import json
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))
MP_API = "https://api.mercadopago.com"


def _cfg():
    token = (os.getenv("MP_ACCESS_TOKEN") or "").strip()
    user_id = (os.getenv("MP_USER_ID") or "").strip()
    pos_id = (os.getenv("MP_POS_EXTERNAL_ID") or "CAJA1").strip()
    store_id = (os.getenv("MP_STORE_EXTERNAL_ID") or "SUC1").strip()
    if not token or not user_id:
        raise RuntimeError("Faltan MP_ACCESS_TOKEN o MP_USER_ID en el servidor.")
    return token, user_id, pos_id, store_id


def _nombre_negocio(cursor):
    try:
        cursor.execute("SELECT nombre_negocio FROM configuracion_local WHERE id = 1")
        fila = cursor.fetchone()
    except sqlite3.Error:
        return "Venta"
    if not fila:
        return "Venta"
    nombre = (fila["nombre_negocio"] if isinstance(fila, sqlite3.Row) else fila[0]) or ""
    nombre = " ".join(str(nombre).split())
    return (nombre[:120] if nombre else "Venta")


def _mp(method, path, body=None, idempotency=None, ignore_404=False):
    token, _, _, _ = _cfg()
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        MP_API + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    if idempotency:
        req.add_header("X-Idempotency-Key", idempotency)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detalle = e.read().decode("utf-8", errors="replace")[:400]
        if e.code == 404 and ignore_404:
            return {}
        raise RuntimeError(f"Mercado Pago respondió {e.code}: {detalle}")


def inicializar_cobros():
    conexion = obtener_conexion()
    conexion.execute(
        """
        CREATE TABLE IF NOT EXISTS cobros_externos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proveedor TEXT NOT NULL,
            mp_order_id TEXT,
            external_reference TEXT NOT NULL UNIQUE,
            monto REAL NOT NULL,
            estado TEXT NOT NULL,
            turno_id INTEGER,
            venta_id INTEGER,
            pos_external_id TEXT,
            creado_en TEXT NOT NULL
        )
        """
    )
    conexion.commit()
    conexion.close()


inicializar_cobros()


def _listar_sucursales(user_id):
    data = _mp("GET", f"/users/{user_id}/stores/search", ignore_404=True)
    return data.get("results") or []


def _buscar_sucursal(user_id, external_id):
    query = urllib.parse.urlencode({"external_id": external_id})
    data = _mp("GET", f"/users/{user_id}/stores/search?{query}", ignore_404=True)
    resultados = data.get("results") or []
    return resultados[0] if resultados else None


def _listar_cajas():
    data = _mp("GET", "/v2/pos", ignore_404=True)
    return data.get("data") or data.get("results") or []


def _buscar_caja(external_id):
    query = urllib.parse.urlencode({"external_id": external_id})
    data = _mp("GET", f"/pos?{query}", ignore_404=True)
    resultados = data.get("results") or []
    if resultados:
        return resultados[0]
    for caja in _listar_cajas():
        if (caja.get("external_id") or "") == external_id:
            return caja
    return None


def _qr_de_caja(caja):
    qr = caja.get("qr") or caja.get("qr_response") or {}
    return {
        "image": qr.get("image") or qr.get("template_image"),
        "pdf": qr.get("template_document"),
    }


def _caja_con_qr(caja):
    datos = _qr_de_caja(caja)
    return bool(datos.get("image") or datos.get("pdf"))


def _modo_caja(caja):
    return (((caja.get("config") or {}).get("qr") or {}).get("operating_mode") or "").lower()


def _sucursal_para_caja(user_id, store_external):
    sucursal = _buscar_sucursal(user_id, store_external)
    if sucursal:
        return sucursal
    existentes = _listar_sucursales(user_id)
    if existentes:
        return existentes[0]
    return _mp(
        "POST",
        f"/users/{user_id}/stores",
        {
            "name": "Autoservicio",
            "external_id": store_external,
            "location": {
                "street_name": os.getenv("MP_CALLE", "Local"),
                "street_number": os.getenv("MP_ALTURA", "0"),
                "city_name": os.getenv("MP_CIUDAD", "El Colorado"),
                "state_name": os.getenv("MP_PROVINCIA", "Formosa"),
                "latitude": float(os.getenv("MP_LAT", "-25.0")),
                "longitude": float(os.getenv("MP_LON", "-59.0")),
            },
        },
        idempotency=str(uuid.uuid4()),
    )


def asegurar_caja():
    """Usa la caja PDV ya impresa si existe; si no, crea una atendida con QR."""
    _, user_id, pos_id, store_external = _cfg()
    caja = _buscar_caja(pos_id)
    if caja and _caja_con_qr(caja):
        return caja

    for candidata in _listar_cajas():
        if candidata.get("external_id"):
            continue
        if _modo_caja(candidata) != "pdv" or not _caja_con_qr(candidata):
            continue
        actualizada = _mp(
            "PATCH",
            f"/v2/pos/{candidata['id']}",
            {"external_id": pos_id},
            idempotency=str(uuid.uuid4()),
        )
        if actualizada and _caja_con_qr(actualizada):
            return actualizada
        caja = _buscar_caja(pos_id)
        if caja and _caja_con_qr(caja):
            return caja

    sucursal = _sucursal_para_caja(user_id, store_external)
    store_id = sucursal.get("id")
    if not store_id:
        raise RuntimeError("Mercado Pago no devolvió el id de la sucursal.")
    caja = _mp(
        "POST",
        "/v2/pos",
        {
            "name": "Caja 1",
            "store_id": str(store_id),
            "external_id": pos_id,
            "config": {"qr": {"operating_mode": "pdv"}},
        },
        idempotency=str(uuid.uuid4()),
    )
    if not _caja_con_qr(caja):
        raise RuntimeError("Mercado Pago creó la caja pero no le dio QR. Activá las credenciales de producción.")
    return caja


def _estado_order(order):
    status = (order.get("status") or "").lower()
    pagos = ((order.get("transactions") or {}).get("payments") or [])
    pago = pagos[0] if pagos else {}
    pago_status = (pago.get("status") or "").lower()
    pago_detail = (pago.get("status_detail") or "").lower()
    if status == "processed" or (pago_status == "processed" and pago_detail in ("accredited", "processed", "")):
        return "aprobado"
    if status in ("expired",):
        return "vencido"
    if status in ("canceled", "cancelled"):
        return "cancelado"
    if status in ("refunded",):
        return "rechazado"
    return "pendiente"


def _cancelar_pendientes(cursor, pos_id):
    cursor.execute(
        """
        SELECT id, mp_order_id FROM cobros_externos
        WHERE estado = 'pendiente' AND pos_external_id = ?
        """,
        (pos_id,),
    )
    for fila in cursor.fetchall():
        order_id = fila["mp_order_id"] if isinstance(fila, sqlite3.Row) else fila[1]
        local_id = fila["id"] if isinstance(fila, sqlite3.Row) else fila[0]
        if order_id:
            try:
                _mp("POST", f"/v1/orders/{order_id}/cancel", {}, idempotency=str(uuid.uuid4()))
            except RuntimeError:
                pass
        cursor.execute("UPDATE cobros_externos SET estado = 'cancelado' WHERE id = ?", (local_id,))


class CobroQr(BaseModel):
    monto: float
    turno_id: int


@router.get("/qr/caja", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def ver_caja_qr():
    try:
        caja = asegurar_caja()
        _, _, pos_id, _ = _cfg()
        return {"pos_external_id": pos_id, **_qr_de_caja(caja)}
    except Exception as e:
        return {"error": str(e)}


@router.post("/qr", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def crear_cobro_qr(datos: CobroQr):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        monto = round(float(datos.monto or 0), 2)
        if monto < 15:
            raise RuntimeError("Mercado Pago no acepta QR de menos de $15.")
        _, _, pos_id, _ = _cfg()
        caja = asegurar_caja()
        _cancelar_pendientes(cursor, pos_id)
        referencia = "cobro_" + uuid.uuid4().hex[:16]
        monto_txt = f"{monto:.2f}"
        titulo = _nombre_negocio(cursor)
        order = _mp(
            "POST",
            "/v1/orders",
            {
                "type": "qr",
                "total_amount": monto_txt,
                "description": titulo,
                "external_reference": referencia,
                "expiration_time": "PT5M",
                "config": {"qr": {"external_pos_id": pos_id, "mode": "static"}},
                "transactions": {"payments": [{"amount": monto_txt}]},
                "items": [{
                    "title": titulo,
                    "unit_price": monto_txt,
                    "quantity": 1,
                    "unit_measure": "unit",
                }],
            },
            idempotency=str(uuid.uuid4()),
        )
        ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute(
            """
            INSERT INTO cobros_externos
            (proveedor, mp_order_id, external_reference, monto, estado, turno_id, pos_external_id, creado_en)
            VALUES ('mercadopago', ?, ?, ?, 'pendiente', ?, ?, ?)
            """,
            (order.get("id"), referencia, monto, datos.turno_id, pos_id, ahora),
        )
        cobro_id = cursor.lastrowid
        conexion.commit()
        return {
            "cobro_id": cobro_id,
            "estado": "pendiente",
            "monto": monto,
            **_qr_de_caja(caja),
        }
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/qr/{cobro_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def estado_cobro_qr(cobro_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM cobros_externos WHERE id = ?", (cobro_id,))
        cobro = cursor.fetchone()
        if not cobro:
            return {"error": "Ese cobro no existe."}
        estado = cobro["estado"]
        if estado == "pendiente" and cobro["mp_order_id"]:
            order = _mp("GET", f"/v1/orders/{cobro['mp_order_id']}")
            nuevo = _estado_order(order)
            if nuevo != "pendiente":
                cursor.execute("UPDATE cobros_externos SET estado = ? WHERE id = ?", (nuevo, cobro_id))
                conexion.commit()
                estado = nuevo
        return {
            "cobro_id": cobro_id,
            "estado": estado,
            "monto": cobro["monto"],
            "venta_id": cobro["venta_id"],
        }
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()


@router.post("/qr/{cobro_id}/cancelar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def cancelar_cobro_qr(cobro_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM cobros_externos WHERE id = ?", (cobro_id,))
        cobro = cursor.fetchone()
        if not cobro:
            return {"error": "Ese cobro no existe."}
        if cobro["estado"] == "aprobado":
            return {"error": "Ese QR ya se pagó. No se puede cancelar."}
        if cobro["estado"] == "pendiente" and cobro["mp_order_id"]:
            try:
                _mp("POST", f"/v1/orders/{cobro['mp_order_id']}/cancel", {}, idempotency=str(uuid.uuid4()))
            except RuntimeError:
                pass
        cursor.execute("UPDATE cobros_externos SET estado = 'cancelado' WHERE id = ? AND estado = 'pendiente'", (cobro_id,))
        conexion.commit()
        return {"cobro_id": cobro_id, "estado": "cancelado"}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()
