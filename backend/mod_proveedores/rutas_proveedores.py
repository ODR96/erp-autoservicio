from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional, Any
from datetime import datetime, timezone, timedelta
import sqlite3
import os
import re
import json
import uuid
import base64
import urllib.request
import urllib.error
from backend.database import obtener_conexion, RAIZ_PROYECTO
from backend.mod_usuarios.rutas_usuarios import VerificarRol
from backend.mod_productos.rutas_productos import compensar_deuda_stock

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3)) # <-- LA HORA ARGENTINA

class NuevoProveedor(BaseModel):
    nombre_comercial: str
    cuit: str = ""
    telefono_vendedor: str = ""
    observaciones: str = ""


class ItemFactura(BaseModel):
    producto_id: int
    cantidad_comprada: float
    costo_unitario: float
    nuevo_precio_venta: Optional[float] = None
    fecha_vencimiento: str = "2099-12-31"
    numero_lote_proveedor: str = "S/L"

class PagoInmediato(BaseModel):
    metodo_pago: str
    monto: float
    observaciones: str = ""
    turno_id: Optional[int] = None

class NuevaFacturaCompra(BaseModel):
    proveedor_id: int
    numero_factura: str
    condicion_pago: str
    cargos_extra: float = 0.0
    fecha_compra: str = ""
    forzar_duplicado: bool = False
    items: List[ItemFactura]
    pago_inmediato: Optional[PagoInmediato] = None
    
class PagoProveedor(BaseModel):
    proveedor_id: int
    monto_pagado: float
    metodo_pago: str
    observaciones: str = ""
    turno_id: Optional[int] = None

class DeudaRapida(BaseModel):
    proveedor_id: int
    numero_factura: str
    condicion_pago: str
    total_factura: float
    observaciones: str = ""
    fecha_compra: str = ""
    forzar_duplicado: bool = False
    pago_inmediato: Optional[PagoInmediato] = None

class PayloadBorrador(BaseModel):
    cab: Optional[dict] = None
    items: Optional[List[Any]] = None

class ConfirmarBorrador(BaseModel):
    compra_id: Optional[int] = None

class FotoWhatsappIn(BaseModel):
    chat_id: str
    caption: str = ""
    foto_b64: str
    mime: str = "image/jpeg"
    filename: str = "whatsapp.jpg"
    proveedor_id: Optional[int] = None
    numero_factura: str = ""


def _hoy_ar() -> str:
    return datetime.now(ZONA_AR).strftime("%Y-%m-%d")


def _normalizar_fecha_compra(fecha: Optional[str]) -> str:
    texto = (fecha or "").strip()[:10]
    if not texto:
        return _hoy_ar()
    try:
        datetime.strptime(texto, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Fecha de factura inválida.")
    return texto


def _numero_factura_clave(numero: str) -> str:
    return " ".join((numero or "").strip().upper().split())


def _buscar_factura_duplicada(cursor, proveedor_id: int, numero: str):
    clave = _numero_factura_clave(numero)
    if not clave:
        return None
    cursor.execute(
        '''
        SELECT id, numero_factura, fecha_compra, total_factura
        FROM compras_cabecera
        WHERE proveedor_id = ?
          AND UPPER(TRIM(numero_factura)) = ?
        ORDER BY id DESC
        LIMIT 1
        ''',
        (proveedor_id, clave),
    )
    return cursor.fetchone()


DIR_FOTOS_BORRADOR = os.path.join(RAIZ_PROYECTO, "data", "borradores_factura")
MIME_FOTO_OK = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
}
FOTO_ID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
MAX_FOTO_BYTES = 8 * 1024 * 1024
MAX_FOTOS_BORRADOR = 20
VENTANA_WHATSAPP_SEG = 2 * 60 * 60


def _ahora_ar_dt() -> str:
    return datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")


def _parse_json_list(raw) -> list:
    if isinstance(raw, list):
        return raw
    try:
        data = json.loads(raw or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def _cab_desde_fila(row) -> dict:
    return {
        "modo": row["modo"] or "stock",
        "proveedor_id": "" if row["proveedor_id"] is None else str(row["proveedor_id"]),
        "numero": row["numero_factura"] or "",
        "condicion": row["condicion_pago"] or "Cuenta Corriente",
        "fecha": row["fecha_papel"] or _hoy_ar(),
        "cargos": "" if row["cargos_extra"] is None else str(row["cargos_extra"]),
        "total_papel": "" if row["total_papel"] is None else str(row["total_papel"]),
        "total_deuda": "" if row["total_deuda"] is None else str(row["total_deuda"]),
        "obs_deuda": row["obs_deuda"] or "",
    }


def _titulo_borrador(row, n_items: int, n_fotos: int) -> str:
    nombre = ""
    try:
        nombre = (row["nombre_comercial"] or "").strip()
    except (KeyError, IndexError, TypeError):
        nombre = ""
    nombre = nombre or "Sin proveedor"
    numero = (row["numero_factura"] or "").strip()
    partes = [f"#{row['id']}", nombre]
    if numero:
        partes.append(numero)
    if n_items:
        partes.append(f"{n_items} ítems")
    if n_fotos:
        partes.append(f"{n_fotos} fotos")
    if (row["origen"] or "") == "WHATSAPP":
        partes.append("WA")
    return " · ".join(partes)


def _resumen_borrador(row) -> dict:
    items = _parse_json_list(row["items_json"])
    fotos = _parse_json_list(row["fotos_json"])
    return {
        "id": row["id"],
        "estado": row["estado"],
        "origen": row["origen"],
        "proveedor_id": row["proveedor_id"],
        "nombre_comercial": row["nombre_comercial"] if "nombre_comercial" in row.keys() else None,
        "numero_factura": row["numero_factura"] or "",
        "modo": row["modo"] or "stock",
        "n_items": len(items),
        "n_fotos": len(fotos),
        "updated_at": row["updated_at"],
        "origen_chat": row["origen_chat"] or "",
        "titulo": _titulo_borrador(row, len(items), len(fotos)),
    }


def _payload_borrador(row) -> dict:
    resumen = _resumen_borrador(row)
    resumen["cab"] = _cab_desde_fila(row)
    resumen["items"] = _parse_json_list(row["items_json"])
    resumen["fotos"] = _parse_json_list(row["fotos_json"])
    resumen["caption"] = row["caption"] if "caption" in row.keys() else ""
    return resumen


def _asegurar_tablas_borrador(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS compras_borradores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            estado TEXT NOT NULL DEFAULT 'BORRADOR',
            origen TEXT NOT NULL DEFAULT 'ADMIN',
            proveedor_id INTEGER,
            numero_factura TEXT DEFAULT '',
            condicion_pago TEXT DEFAULT 'Cuenta Corriente',
            fecha_papel TEXT DEFAULT '',
            modo TEXT DEFAULT 'stock',
            cargos_extra REAL DEFAULT 0,
            total_papel REAL,
            total_deuda REAL,
            obs_deuda TEXT DEFAULT '',
            items_json TEXT NOT NULL DEFAULT '[]',
            fotos_json TEXT NOT NULL DEFAULT '[]',
            origen_chat TEXT DEFAULT '',
            caption TEXT DEFAULT '',
            usuario_id INTEGER DEFAULT 1,
            compra_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )


def _dir_fotos(borrador_id: int) -> str:
    ruta = os.path.join(DIR_FOTOS_BORRADOR, str(int(borrador_id)))
    os.makedirs(ruta, exist_ok=True)
    return ruta


def _ext_de_mime(mime: str) -> str:
    return MIME_FOTO_OK.get((mime or "").split(";")[0].strip().lower(), "")


def _resolver_mime_foto(mime: str, filename: str):
    mime_limpio = (mime or "").split(";")[0].strip().lower()
    if mime_limpio in MIME_FOTO_OK:
        return mime_limpio, MIME_FOTO_OK[mime_limpio]
    nombre = (filename or "").lower()
    por_ext = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
    }
    for suf, m in por_ext.items():
        if nombre.endswith(suf):
            return m, MIME_FOTO_OK[m]
    return "", ""


def _float_o_none(valor):
    if valor is None or valor == "":
        return None
    try:
        return float(valor)
    except (TypeError, ValueError):
        return None


def _int_o_none(valor):
    if valor is None or valor == "":
        return None
    try:
        return int(valor)
    except (TypeError, ValueError):
        return None


def _aplicar_cab_items(cursor, borrador_id: int, cab: Optional[dict], items: Optional[list], usuario_id: int):
    cab = cab or {}
    sets = ["updated_at = ?", "usuario_id = ?"]
    vals = [_ahora_ar_dt(), usuario_id]
    if cab:
        sets.extend([
            "proveedor_id = ?",
            "numero_factura = ?",
            "condicion_pago = ?",
            "fecha_papel = ?",
            "modo = ?",
            "cargos_extra = ?",
            "total_papel = ?",
            "total_deuda = ?",
            "obs_deuda = ?",
        ])
        vals.extend([
            _int_o_none(cab.get("proveedor_id")),
            (cab.get("numero") or "").strip()[:80],
            (cab.get("condicion") or "Cuenta Corriente").strip()[:40],
            (cab.get("fecha") or _hoy_ar())[:10],
            "deuda" if cab.get("modo") == "deuda" else "stock",
            _float_o_none(cab.get("cargos")) or 0,
            _float_o_none(cab.get("total_papel")),
            _float_o_none(cab.get("total_deuda")),
            (cab.get("obs_deuda") or "").strip()[:500],
        ])
    if items is not None:
        if not isinstance(items, list):
            raise HTTPException(status_code=400, detail="Ítems de borrador inválidos.")
        sets.append("items_json = ?")
        vals.append(json.dumps(items, ensure_ascii=False))
    vals.append(borrador_id)
    cursor.execute(
        f"UPDATE compras_borradores SET {', '.join(sets)} WHERE id = ? AND estado = 'BORRADOR'",
        vals,
    )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Ese borrador no existe o ya se cerró.")


def _fila_borrador(cursor, borrador_id: int, incluir_cerrados: bool = False):
    sql = """
        SELECT b.*, p.nombre_comercial
        FROM compras_borradores b
        LEFT JOIN proveedores p ON p.id = b.proveedor_id
        WHERE b.id = ?
    """
    if not incluir_cerrados:
        sql += " AND b.estado = 'BORRADOR'"
    cursor.execute(sql, (borrador_id,))
    return cursor.fetchone()


def _exigir_borrador_abierto(cursor, borrador_id: int):
    fila = _fila_borrador(cursor, borrador_id)
    if not fila:
        raise HTTPException(status_code=404, detail="Ese borrador no existe o ya se cerró.")
    return fila


def _adjuntar_bytes(cursor, borrador_id: int, data: bytes, mime: str, filename: str, origen: str):
    if not data:
        raise HTTPException(status_code=400, detail="La foto llegó vacía.")
    if len(data) > MAX_FOTO_BYTES:
        raise HTTPException(status_code=400, detail="La foto supera 8 MB.")
    mime_ok, ext = _resolver_mime_foto(mime, filename)
    if not ext:
        raise HTTPException(status_code=400, detail="Formato no permitido. Usá JPG, PNG, WEBP, GIF o PDF.")
    fila = _exigir_borrador_abierto(cursor, borrador_id)
    fotos = _parse_json_list(fila["fotos_json"])
    if len(fotos) >= MAX_FOTOS_BORRADOR:
        raise HTTPException(status_code=400, detail="Este borrador ya tiene 20 fotos (tope de páginas).")
    foto_id = str(uuid.uuid4())
    ruta = os.path.join(_dir_fotos(borrador_id), f"{foto_id}{ext}")
    with open(ruta, "wb") as fh:
        fh.write(data)
    meta = {
        "id": foto_id,
        "filename": os.path.basename(filename or f"foto{ext}")[:120],
        "mime": mime_ok,
        "origen": origen,
        "bytes": len(data),
        "created_at": _ahora_ar_dt(),
    }
    fotos.append(meta)
    cursor.execute(
        "UPDATE compras_borradores SET fotos_json = ?, updated_at = ? WHERE id = ?",
        (json.dumps(fotos, ensure_ascii=False), _ahora_ar_dt(), borrador_id),
    )
    return meta


def _ruta_archivo_foto(borrador_id: int, foto: dict) -> str:
    ext = _ext_de_mime(foto.get("mime") or "")
    return os.path.join(_dir_fotos(borrador_id), f"{foto['id']}{ext}")


def _exigir_loopback_whatsapp(request: Request):
    host = (request.client.host if request.client else "") or ""
    if host not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="Solo el bot local puede adjuntar fotos de WhatsApp.")
    esperado = (os.getenv("WHATSAPP_BRIDGE_TOKEN") or os.getenv("PUENTE_TOKEN") or "").strip()
    if esperado:
        token = (request.headers.get("X-ERP-Token") or "").strip()
        if token != esperado:
            raise HTTPException(status_code=401, detail="Token de puente inválido.")


def _insertar_borrador(cursor, origen: str, usuario_id: int, origen_chat: str = "", caption: str = "",
                       proveedor_id=None, numero_factura: str = ""):
    ahora = _ahora_ar_dt()
    cursor.execute(
        """
        INSERT INTO compras_borradores (
            estado, origen, proveedor_id, numero_factura, condicion_pago, fecha_papel, modo,
            cargos_extra, items_json, fotos_json, origen_chat, caption, usuario_id, created_at, updated_at
        ) VALUES ('BORRADOR', ?, ?, ?, 'Cuenta Corriente', ?, 'stock', 0, '[]', '[]', ?, ?, ?, ?, ?)
        """,
        (
            origen,
            proveedor_id,
            (numero_factura or "").strip()[:80],
            _hoy_ar(),
            origen_chat or "",
            (caption or "")[:500],
            usuario_id,
            ahora,
            ahora,
        ),
    )
    return cursor.lastrowid


def _exigir_factura_unica(cursor, proveedor_id: int, numero: str, forzar: bool):
    dup = _buscar_factura_duplicada(cursor, proveedor_id, numero)
    if not dup:
        return
    if forzar:
        return
    fecha = dup["fecha_compra"] if isinstance(dup, sqlite3.Row) else dup[2]
    total = dup["total_factura"] if isinstance(dup, sqlite3.Row) else dup[3]
    raise HTTPException(
        status_code=409,
        detail=f"Ese N° ya está cargado ({fecha}, ${float(total or 0):.2f}). Revisá o confirmá el duplicado.",
    )


def _usuario_desde_payload(payload: dict) -> int:
    try:
        return int((payload or {}).get("sub") or 1)
    except (TypeError, ValueError):
        return 1


def _es_pago_efectivo_caja(metodo: str) -> bool:
    m = (metodo or "").strip().upper().replace("_", " ")
    return m == "EFECTIVO CAJA"


def _asegurar_ctacte(cursor, proveedor_id: int):
    cursor.execute("SELECT id FROM proveedores_ctacte WHERE proveedor_id = ?", (proveedor_id,))
    if not cursor.fetchone():
        cursor.execute(
            "INSERT INTO proveedores_ctacte (proveedor_id, saldo_deudor) VALUES (?, 0)",
            (proveedor_id,)
        )


def _sumar_deuda_proveedor(cursor, proveedor_id: int, monto: float):
    _asegurar_ctacte(cursor, proveedor_id)
    cursor.execute(
        "UPDATE proveedores_ctacte SET saldo_deudor = saldo_deudor + ? WHERE proveedor_id = ?",
        (monto, proveedor_id)
    )


def _asegurar_columna_usuario_pagos(cursor):
    cursor.execute('''CREATE TABLE IF NOT EXISTS pagos_proveedores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proveedor_id INTEGER,
        fecha_pago TEXT,
        monto_total_pagado REAL,
        metodo_pago TEXT,
        observaciones TEXT
    )''')
    cursor.execute("PRAGMA table_info(pagos_proveedores)")
    cols = [c[1] for c in cursor.fetchall()]
    if "usuario_id" not in cols:
        cursor.execute("ALTER TABLE pagos_proveedores ADD COLUMN usuario_id INTEGER DEFAULT 1")


def _registrar_pago_en_cursor(cursor, proveedor_id: int, monto: float, metodo: str,
                              observaciones: str, usuario_id: int, turno_id=None):
    """Historial + baja de saldo. Si es efectivo de registradora, RETIRO del turno. No toca gastos."""
    if monto <= 0:
        raise HTTPException(status_code=400, detail="El pago tiene que ser mayor a cero.")

    _asegurar_columna_usuario_pagos(cursor)
    _asegurar_ctacte(cursor, proveedor_id)
    fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute('''
        INSERT INTO pagos_proveedores (proveedor_id, fecha_pago, monto_total_pagado, metodo_pago, observaciones, usuario_id)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (proveedor_id, fecha_actual, monto, metodo, observaciones or "", usuario_id))

    cursor.execute(
        "UPDATE proveedores_ctacte SET saldo_deudor = saldo_deudor - ? WHERE proveedor_id = ?",
        (monto, proveedor_id)
    )

    retiro_caja = None
    if _es_pago_efectivo_caja(metodo):
        turno = None
        if turno_id:
            cursor.execute(
                "SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'",
                (turno_id,)
            )
            turno = cursor.fetchone()
        if not turno:
            cursor.execute(
                "SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO' ORDER BY id DESC LIMIT 1"
            )
            turno = cursor.fetchone()
        if not turno:
            raise HTTPException(
                status_code=400,
                detail="No hay caja abierta. Abrí un turno para pagar en efectivo de la registradora."
            )
        tid = turno[0] if not isinstance(turno, sqlite3.Row) else turno["id"]
        cursor.execute('''
            INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
            VALUES (?, ?, 'RETIRO', ?, ?, ?)
        ''', (fecha_actual, usuario_id, monto, f"Pago a proveedor #{proveedor_id}", tid))
        retiro_caja = tid

    return retiro_caja


def _aplicar_pago_inmediato(cursor, proveedor_id: int, total_factura: float, condicion: str,
                            pago: PagoInmediato, usuario_id: int):
    if pago.monto <= 0:
        raise HTTPException(status_code=400, detail="El pago inmediato tiene que ser mayor a cero.")
    if pago.monto > total_factura + 0.009:
        raise HTTPException(status_code=400, detail="El pago no puede ser mayor al total de la factura.")

    # Contado no sumaba saldo; si hay pago hay que abrir deuda y cancelarla (si es total, queda en 0).
    if condicion != "Cuenta Corriente":
        _sumar_deuda_proveedor(cursor, proveedor_id, total_factura)

    return _registrar_pago_en_cursor(
        cursor,
        proveedor_id,
        pago.monto,
        pago.metodo_pago,
        pago.observaciones,
        usuario_id,
        pago.turno_id,
    )


def _avisar_retiro_proveedor(background_tasks: BackgroundTasks, monto: float, proveedor_id: int,
                             usuario_id: int, turno_id):
    from backend.whatsapp_puente import avisar_retiro, nombre_usuario
    background_tasks.add_task(
        avisar_retiro,
        monto,
        f"Pago a proveedor #{proveedor_id}",
        nombre_usuario(usuario_id),
        turno_id,
    )

# --- 1. GESTIÓN DE PROVEEDORES (ABM COMPLETO) ---
@router.post("/alta", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def registrar_proveedor(prov: NuevoProveedor):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        # AGREGAMOS LAS OBSERVACIONES AL INSERT
        cursor.execute("INSERT INTO proveedores (nombre_comercial, cuit, telefono_vendedor, observaciones) VALUES (?, ?, ?, ?)", 
                       (prov.nombre_comercial, prov.cuit, prov.telefono_vendedor, prov.observaciones))
        nuevo_id = cursor.lastrowid
        cursor.execute("INSERT INTO proveedores_ctacte (proveedor_id, saldo_deudor) VALUES (?, 0)", (nuevo_id,))
        conexion.commit()
        return {"mensaje": "Proveedor registrado", "id": nuevo_id}
    except Exception as e:
            if conexion:
                conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
                conexion.close()
                
            mensaje_error = str(e)
            # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
            if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
                print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
                return {"error": "Ocurrió un error interno al procesar la solicitud."}
                
            # 2. Si es un error de negocio tuyo, lo mostramos normal
            return {"error": mensaje_error}
    finally:
        conexion.close()

@router.get("/listado", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_proveedores(solo_activos: bool = False):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # Unimos con la tabla de Cta Cte para traer el saldo real
    query = '''
        SELECT p.*, IFNULL(c.saldo_deudor, 0) as saldo_deudor 
        FROM proveedores p
        LEFT JOIN proveedores_ctacte c ON p.id = c.proveedor_id
    '''
    if solo_activos:
        query += " WHERE p.activo = 1"
    
    cursor.execute(query + " ORDER BY p.nombre_comercial ASC")
    res = [dict(p) for p in cursor.fetchall()]
    conexion.close()
    return res

@router.put("/actualizar/{prov_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def actualizar_proveedor(prov_id: int, prov: NuevoProveedor): # <-- Borramos background_tasks
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        # AGREGAMOS LAS OBSERVACIONES AL UPDATE
        cursor.execute("UPDATE proveedores SET nombre_comercial=?, cuit=?, telefono_vendedor=?, observaciones=? WHERE id=?", 
                       (prov.nombre_comercial, prov.cuit, prov.telefono_vendedor, prov.observaciones, prov_id))
        
        conexion.commit()
        return {"mensaje": "Proveedor actualizado"}
    except Exception as e:
            if conexion:
                conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
                conexion.close()
                
            mensaje_error = str(e)
            # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
            if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
                print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
                return {"error": "Ocurrió un error interno al procesar la solicitud."}
                
            # 2. Si es un error de negocio tuyo, lo mostramos normal
            return {"error": mensaje_error}
    finally:
        conexion.close()

@router.delete("/baja/{prov_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def baja_proveedor(prov_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute("UPDATE proveedores SET activo = 0 WHERE id = ?", (prov_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Proveedor desactivado"}

@router.put("/reactivar/{prov_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def reactivar_proveedor(prov_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute("UPDATE proveedores SET activo = 1 WHERE id = ?", (prov_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Proveedor reactivado"}

# --- EL CORAZÓN DE LOS PAGOS (PARCHE AQUÍ) ---
# --- REGISTRAR PAGO Y DESCONTAR DEUDA ---
# --- REGISTRAR PAGO Y DESCONTAR DEUDA ---
@router.post("/pagar")
def registrar_pago_proveedor(pago: PagoProveedor, background_tasks: BackgroundTasks,
                             payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))):
    usuario_id = _usuario_desde_payload(payload)
    rol = (payload or {}).get("rol") or ""
    if rol == "CAJERO" and not _es_pago_efectivo_caja(pago.metodo_pago):
        raise HTTPException(
            status_code=403,
            detail="El cajero solo puede pagar con efectivo de la registradora. Bolsillo o transferencia: Encargado o Admin."
        )

    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        retiro_caja = _registrar_pago_en_cursor(
            cursor,
            pago.proveedor_id,
            pago.monto_pagado,
            pago.metodo_pago,
            pago.observaciones,
            usuario_id,
            pago.turno_id,
        )
        conexion.commit()
        if retiro_caja is not None:
            _avisar_retiro_proveedor(background_tasks, pago.monto_pagado, pago.proveedor_id, usuario_id, retiro_caja)
        return {"mensaje": "Pago realizado con éxito"}
    except HTTPException:
        if conexion:
            conexion.rollback()
        raise
    except Exception as e:
            if conexion:
                conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
                conexion.close()
                
            mensaje_error = str(e)
            # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
            if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
                print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
                return {"error": "Ocurrió un error interno al procesar la solicitud."}
                
            # 2. Si es un error de negocio tuyo, lo mostramos normal
            return {"error": mensaje_error}
    finally:
        conexion.close()

# --- DEUDA RÁPIDA (solo saldo + historial, sin stock) ---
@router.post("/deuda_rapida")
def registrar_deuda_rapida(deuda: DeudaRapida, background_tasks: BackgroundTasks,
                           payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    if deuda.total_factura <= 0:
        raise HTTPException(status_code=400, detail="El total tiene que ser mayor a cero.")
    if not deuda.numero_factura.strip():
        raise HTTPException(status_code=400, detail="Falta el número de factura o remito.")

    usuario_id = _usuario_desde_payload(payload)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id FROM proveedores WHERE id = ? AND IFNULL(activo, 1) = 1", (deuda.proveedor_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="El proveedor no existe o está inactivo.")

        numero = deuda.numero_factura.strip()
        _exigir_factura_unica(cursor, deuda.proveedor_id, numero, deuda.forzar_duplicado)
        fecha_compra = _normalizar_fecha_compra(deuda.fecha_compra)
        nota = (deuda.observaciones or "").strip() or "Carga rápida (sin detalle de ítems)"

        cursor.execute('''
            INSERT INTO compras_cabecera (proveedor_id, numero_factura, fecha_compra, total_factura, condicion_pago)
            VALUES (?, ?, ?, ?, ?)
        ''', (deuda.proveedor_id, numero, fecha_compra, deuda.total_factura, deuda.condicion_pago))
        compra_id = cursor.lastrowid

        cursor.execute('''
            INSERT INTO compras_detalle
                (compra_id, producto_id, descripcion_historica, cantidad_comprada, costo_unitario, fecha_vencimiento, numero_lote_proveedor)
            VALUES (?, NULL, ?, 1, ?, '2099-12-31', 'DEUDA-RAPIDA')
        ''', (compra_id, nota, deuda.total_factura))

        if deuda.condicion_pago == "Cuenta Corriente":
            _sumar_deuda_proveedor(cursor, deuda.proveedor_id, deuda.total_factura)

        retiro_caja = None
        if deuda.pago_inmediato:
            retiro_caja = _aplicar_pago_inmediato(
                cursor, deuda.proveedor_id, deuda.total_factura, deuda.condicion_pago,
                deuda.pago_inmediato, usuario_id
            )

        conexion.commit()
        if retiro_caja is not None:
            _avisar_retiro_proveedor(
                background_tasks, deuda.pago_inmediato.monto, deuda.proveedor_id, usuario_id, retiro_caja
            )
        return {
            "mensaje": "Deuda registrada. No se tocó el stock.",
            "id": compra_id,
            "total": deuda.total_factura
        }
    except HTTPException:
        conexion.rollback()
        raise
    except Exception as e:
        conexion.rollback()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}
    finally:
        conexion.close()

@router.get("/comprobar_factura", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def comprobar_factura(proveedor_id: int, numero: str):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        dup = _buscar_factura_duplicada(cursor, proveedor_id, numero)
        if not dup:
            return {"duplicada": False}
        return {
            "duplicada": True,
            "id": dup["id"],
            "numero_factura": dup["numero_factura"],
            "fecha_compra": dup["fecha_compra"],
            "total_factura": dup["total_factura"],
        }
    finally:
        conexion.close()


# --- BORRADORES DE FACTURA (servidor; el bot solo adjunta fotos) ---
@router.get("/borradores", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def listar_borradores_factura():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        conexion.commit()
        cursor.execute(
            """
            SELECT b.*, p.nombre_comercial
            FROM compras_borradores b
            LEFT JOIN proveedores p ON p.id = b.proveedor_id
            WHERE b.estado = 'BORRADOR'
            ORDER BY b.updated_at DESC, b.id DESC
            """
        )
        return [_resumen_borrador(r) for r in cursor.fetchall()]
    finally:
        conexion.close()


@router.get("/borradores/{borrador_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_borrador_factura(borrador_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        fila = _fila_borrador(cursor, borrador_id, incluir_cerrados=True)
        if not fila:
            raise HTTPException(status_code=404, detail="Borrador no encontrado.")
        return _payload_borrador(fila)
    finally:
        conexion.close()


@router.post("/borradores", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def crear_borrador_factura(payload: PayloadBorrador,
                           datos: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        cab = payload.cab or {}
        nuevo_id = _insertar_borrador(
            cursor,
            "ADMIN",
            _usuario_desde_payload(datos),
            proveedor_id=_int_o_none(cab.get("proveedor_id")),
            numero_factura=(cab.get("numero") or ""),
        )
        _aplicar_cab_items(cursor, nuevo_id, cab, payload.items if payload.items is not None else [], _usuario_desde_payload(datos))
        conexion.commit()
        fila = _fila_borrador(cursor, nuevo_id)
        return _payload_borrador(fila)
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@router.put("/borradores/{borrador_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def actualizar_borrador_factura(borrador_id: int, payload: PayloadBorrador,
                                datos: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        _exigir_borrador_abierto(cursor, borrador_id)
        _aplicar_cab_items(cursor, borrador_id, payload.cab, payload.items, _usuario_desde_payload(datos))
        conexion.commit()
        return _payload_borrador(_fila_borrador(cursor, borrador_id))
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@router.post("/borradores/{borrador_id}/fotos", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def adjuntar_foto_borrador(borrador_id: int, archivo: UploadFile = File(...)):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        data = archivo.file.read()
        meta = _adjuntar_bytes(
            cursor,
            borrador_id,
            data,
            archivo.content_type or "",
            archivo.filename or "foto",
            "ADMIN",
        )
        conexion.commit()
        fila = _fila_borrador(cursor, borrador_id)
        return {"foto": meta, "borrador": _payload_borrador(fila)}
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@router.get("/borradores/{borrador_id}/fotos/{foto_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def descargar_foto_borrador(borrador_id: int, foto_id: str):
    if not FOTO_ID_RE.match(foto_id or ""):
        raise HTTPException(status_code=400, detail="Foto inválida.")
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        fila = _fila_borrador(cursor, borrador_id, incluir_cerrados=True)
        if not fila:
            raise HTTPException(status_code=404, detail="Borrador no encontrado.")
        foto = next((f for f in _parse_json_list(fila["fotos_json"]) if f.get("id") == foto_id), None)
        if not foto:
            raise HTTPException(status_code=404, detail="Esa foto no está en el borrador.")
        ruta = _ruta_archivo_foto(borrador_id, foto)
        if not os.path.isfile(ruta):
            raise HTTPException(status_code=404, detail="El archivo de la foto no está en disco.")
        return FileResponse(ruta, media_type=foto.get("mime") or "application/octet-stream", filename=foto.get("filename") or "foto")
    finally:
        conexion.close()


@router.delete("/borradores/{borrador_id}/fotos/{foto_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def borrar_foto_borrador(borrador_id: int, foto_id: str):
    if not FOTO_ID_RE.match(foto_id or ""):
        raise HTTPException(status_code=400, detail="Foto inválida.")
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        fila = _exigir_borrador_abierto(cursor, borrador_id)
        fotos = _parse_json_list(fila["fotos_json"])
        foto = next((f for f in fotos if f.get("id") == foto_id), None)
        if not foto:
            raise HTTPException(status_code=404, detail="Esa foto no está en el borrador.")
        ruta = _ruta_archivo_foto(borrador_id, foto)
        fotos = [f for f in fotos if f.get("id") != foto_id]
        cursor.execute(
            "UPDATE compras_borradores SET fotos_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(fotos, ensure_ascii=False), _ahora_ar_dt(), borrador_id),
        )
        conexion.commit()
        if os.path.isfile(ruta):
            try:
                os.remove(ruta)
            except OSError:
                pass
        return {"ok": True, "fotos": fotos}
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@router.post("/borradores/{borrador_id}/anular", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def anular_borrador_factura(borrador_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        cursor.execute(
            "UPDATE compras_borradores SET estado = 'ANULADO', updated_at = ? WHERE id = ? AND estado = 'BORRADOR'",
            (_ahora_ar_dt(), borrador_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Ese borrador no existe o ya se cerró.")
        conexion.commit()
        return {"ok": True}
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@router.post("/borradores/{borrador_id}/confirmar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def confirmar_borrador_factura(borrador_id: int, body: ConfirmarBorrador):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        cursor.execute(
            """
            UPDATE compras_borradores
            SET estado = 'CONFIRMADO', compra_id = ?, updated_at = ?
            WHERE id = ? AND estado = 'BORRADOR'
            """,
            (body.compra_id, _ahora_ar_dt(), borrador_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Ese borrador no existe o ya se cerró.")
        conexion.commit()
        return {"ok": True}
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


PROMPT_OCR_FACTURA = """Sos un extractor de facturas/remitos de proveedores de Argentina (autoservicio, corralón, distribuidora).
Devolvé SOLO JSON válido con esta forma:
{"mano":false,"proveedor":"","numero_factura":"","fecha":"YYYY-MM-DD o vacio","total_papel":null,"cargos_pie":null,
 "items":[{"codigo":"","nombre":"","cantidad":1,"unidad":"UN","costo_unitario":0,"confianza":0.0}]}
Reglas:
- mano=true si es manuscrita o ilegible: items vacío.
- codigo solo si se lee un código de barras o SKU claro. No inventes.
- cantidad y costo_unitario numéricos. unidad UN o CAJA.
- costo_unitario es el costo de 1 unidad (si el papel trae caja, convertí o marcá unidad CAJA).
- No incluyas líneas de IVA, impuesto interno, percepción, flete: eso va en cargos_pie o se refleja en total_papel.
- total_papel es el total a pagar del papel. cargos_pie es lo del pie que NO está en las líneas (si no se puede separar, null).
- confianza 0 a 1. Omití ítems con confianza < 0.45.
- No cargues stock. Solo transcribí el papel."""


def _ocr_clave_openai() -> str:
    return (os.getenv("OPENAI_API_KEY") or os.getenv("FACTURA_OCR_KEY") or "").strip()


def _item_desde_producto_row(prod: dict, cantidad: float, costo: float, modo: str, origen: str) -> dict:
    uxb = max(1, int(prod.get("unidades_por_bulto") or 1))
    precio = float(prod.get("precio_venta_final") or 0)
    costo = float(costo or 0)
    if costo <= 0:
        costo = float(prod.get("costo_sin_iva") or 0)
    modo = "CAJA" if modo == "CAJA" else "UN"
    cant = float(cantidad or 1)
    if cant <= 0:
        cant = 1
    return {
        "producto_id": prod["id"],
        "nombre": prod.get("nombre") or "",
        "codigo_barras": prod.get("codigo_barras") or "",
        "cantidad_ingresada": cant,
        "modo_cantidad": modo,
        "cantidad_comprada": cant * uxb if modo == "CAJA" else cant,
        "costo_unitario": costo,
        "costo_anterior": float(prod.get("costo_sin_iva") or costo),
        "costo_caja": costo * uxb,
        "fecha_vencimiento": "2099-12-31",
        "nuevo_precio_venta": None,
        "precio_gondola_actual": precio,
        "actualizar_gondola": False,
        "unidades_por_bulto": uxb,
        "porcentaje_iva": prod.get("porcentaje_iva") if prod.get("porcentaje_iva") is not None else 21,
        "origen_linea": origen,
        "huerfano": False,
    }


def _item_huerfano_ocr(linea: dict) -> dict:
    nombre = (linea.get("nombre") or linea.get("codigo") or "Ítem del papel").strip()[:120]
    codigo = (linea.get("codigo") or "").strip()
    modo = "CAJA" if str(linea.get("unidad") or "").upper() == "CAJA" else "UN"
    cant = float(linea.get("cantidad") or 1)
    if cant <= 0:
        cant = 1
    costo = float(linea.get("costo_unitario") or 0)
    return {
        "producto_id": None,
        "nombre": nombre,
        "codigo_barras": codigo,
        "nombre_ocr": nombre,
        "codigo_ocr": codigo,
        "cantidad_ingresada": cant,
        "modo_cantidad": modo,
        "cantidad_comprada": cant,
        "costo_unitario": costo,
        "costo_anterior": costo,
        "costo_caja": costo,
        "fecha_vencimiento": "2099-12-31",
        "nuevo_precio_venta": None,
        "precio_gondola_actual": 0,
        "actualizar_gondola": False,
        "unidades_por_bulto": 1,
        "porcentaje_iva": 21,
        "origen_linea": "OCR",
        "huerfano": True,
    }


def _match_producto_ocr(cursor, codigo: str, nombre: str):
    codigo = (codigo or "").strip()
    if codigo:
        cursor.execute(
            "SELECT * FROM productos WHERE activo = 1 AND codigo_barras = ? LIMIT 1",
            (codigo,),
        )
        row = cursor.fetchone()
        if row:
            return dict(row)
    nombre = (nombre or "").strip()
    if len(nombre) >= 4:
        cursor.execute(
            "SELECT * FROM productos WHERE activo = 1 AND nombre LIKE ? LIMIT 4",
            (f"%{nombre}%",),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        if len(rows) == 1:
            return rows[0]
        if len(rows) > 1:
            exact = [r for r in rows if (r.get("nombre") or "").strip().lower() == nombre.lower()]
            if len(exact) == 1:
                return exact[0]
    return None


def _match_proveedor_ocr(cursor, nombre: str):
    nombre = (nombre or "").strip()
    if len(nombre) < 3:
        return None
    cursor.execute(
        """
        SELECT id FROM proveedores
        WHERE IFNULL(activo, 1) = 1 AND nombre_comercial LIKE ?
        ORDER BY id LIMIT 2
        """,
        (f"%{nombre}%",),
    )
    rows = cursor.fetchall()
    if len(rows) == 1:
        return rows[0]["id"] if isinstance(rows[0], sqlite3.Row) else rows[0][0]
    return None


def _llamar_ocr_openai(imagenes: list) -> dict:
    key = _ocr_clave_openai()
    if not key:
        return {"estado": "sin_clave"}
    vis = [im for im in imagenes if (im.get("mime") or "").startswith("image/")]
    if not vis:
        return {"estado": "sin_imagen"}
    modelo = (os.getenv("FACTURA_OCR_MODELO") or "gpt-4o-mini").strip()
    content = [{"type": "text", "text": PROMPT_OCR_FACTURA}]
    for im in vis[:6]:
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{im['mime']};base64,{im['b64']}",
                "detail": "high",
            },
        })
    body = json.dumps({
        "model": modelo,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "max_tokens": 4000,
        "messages": [{"role": "user", "content": content}],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detalle = e.read().decode("utf-8", "replace")[:300]
        print(f"OCR factura HTTP {e.code}: {detalle}")
        return {"estado": "error", "detalle": f"OCR HTTP {e.code}"}
    except Exception as e:
        print(f"OCR factura: {e}")
        return {"estado": "error", "detalle": str(e)[:200]}
    try:
        txt = data["choices"][0]["message"]["content"]
        parsed = json.loads(txt)
    except Exception:
        return {"estado": "error", "detalle": "La visión no devolvió JSON."}
    parsed["estado"] = "ok"
    return parsed


def _fotos_a_imagenes_ocr(cursor, fila) -> list:
    out = []
    for foto in _parse_json_list(fila["fotos_json"]):
        mime = (foto.get("mime") or "image/jpeg").split(";")[0].strip().lower()
        if not mime.startswith("image/"):
            continue
        ruta = _ruta_archivo_foto(fila["id"], foto)
        if not os.path.isfile(ruta):
            continue
        with open(ruta, "rb") as fh:
            raw = fh.read()
        if not raw or len(raw) > MAX_FOTO_BYTES:
            continue
        out.append({"mime": mime, "b64": base64.b64encode(raw).decode("ascii")})
    return out


def _aplicar_parseo_ocr(cursor, fila, parsed: dict) -> dict:
    if parsed.get("mano"):
        return {"estado": "mano", "n_items": 0, "n_huerfanos": 0}

    borrador_id = fila["id"]
    items_prev = _parse_json_list(fila["items_json"])
    if items_prev and not any((it.get("origen_linea") == "OCR") for it in items_prev):
        if any(it.get("producto_id") for it in items_prev):
            return {"estado": "omitido_edicion", "n_items": len(items_prev), "n_huerfanos": 0}

    manuales = [it for it in items_prev if (it.get("origen_linea") or "") == "MANUAL"]

    ocr_items = []
    for linea in parsed.get("items") or []:
        try:
            conf = float(linea.get("confianza") or 0)
        except (TypeError, ValueError):
            conf = 0
        if conf and conf < 0.45:
            continue
        prod = _match_producto_ocr(cursor, linea.get("codigo") or "", linea.get("nombre") or "")
        modo = "CAJA" if str(linea.get("unidad") or "").upper() == "CAJA" else "UN"
        cant = linea.get("cantidad") or 1
        costo = linea.get("costo_unitario") or 0
        if prod:
            ocr_items.append(_item_desde_producto_row(prod, cant, costo, modo, "OCR"))
        else:
            ocr_items.append(_item_huerfano_ocr(linea))

    nuevos = manuales + ocr_items
    cab_sets = ["items_json = ?", "updated_at = ?", "modo = ?"]
    cab_vals = [json.dumps(nuevos, ensure_ascii=False), _ahora_ar_dt(), "stock"]

    if not fila["numero_factura"] and (parsed.get("numero_factura") or "").strip():
        cab_sets.append("numero_factura = ?")
        cab_vals.append(str(parsed.get("numero_factura")).strip()[:80])
    if not fila["proveedor_id"] and parsed.get("proveedor"):
        pid = _match_proveedor_ocr(cursor, parsed.get("proveedor"))
        if pid:
            cab_sets.append("proveedor_id = ?")
            cab_vals.append(pid)
    fecha = (parsed.get("fecha") or "").strip()[:10]
    if fecha and re.match(r"^\d{4}-\d{2}-\d{2}$", fecha) and not (fila["fecha_papel"] or "").strip():
        cab_sets.append("fecha_papel = ?")
        cab_vals.append(fecha)
    total_papel = parsed.get("total_papel")
    if total_papel is not None and fila["total_papel"] is None:
        try:
            cab_sets.append("total_papel = ?")
            cab_vals.append(float(total_papel))
        except (TypeError, ValueError):
            pass
    cargos = parsed.get("cargos_pie")
    if cargos is not None:
        try:
            cab_sets.append("cargos_extra = ?")
            cab_vals.append(float(cargos))
        except (TypeError, ValueError):
            pass

    cab_vals.append(borrador_id)
    cursor.execute(
        f"UPDATE compras_borradores SET {', '.join(cab_sets)} WHERE id = ? AND estado = 'BORRADOR'",
        cab_vals,
    )
    n_h = sum(1 for it in nuevos if it.get("huerfano") or not it.get("producto_id"))
    return {
        "estado": "ok",
        "n_items": len(nuevos),
        "n_huerfanos": n_h,
        "mano": False,
    }


def _ocr_borrador_completo(borrador_id: int) -> dict:
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        fila = _fila_borrador(cursor, borrador_id)
        if not fila:
            return {"estado": "error", "detalle": "Borrador no encontrado."}
        imagenes = _fotos_a_imagenes_ocr(cursor, fila)
        parsed = _llamar_ocr_openai(imagenes)
        if parsed.get("estado") in ("sin_clave", "sin_imagen", "error"):
            return parsed
        res = _aplicar_parseo_ocr(cursor, fila, parsed)
        conexion.commit()
        return res
    except Exception as e:
        conexion.rollback()
        print(f"OCR borrador: {e}")
        return {"estado": "error", "detalle": str(e)[:200]}
    finally:
        conexion.close()


@router.post("/borradores/desde_whatsapp")
def borrador_desde_whatsapp(body: FotoWhatsappIn, request: Request):
    """Contrato del bot Node (loopback). Adjunta foto a un borrador. NUNCA carga stock."""
    _exigir_loopback_whatsapp(request)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        _asegurar_tablas_borrador(cursor)
        chat = (body.chat_id or "").strip()[:120]
        if not chat:
            raise HTTPException(status_code=400, detail="Falta chat_id.")
        try:
            raw = base64.b64decode(body.foto_b64 or "", validate=False)
        except Exception:
            raise HTTPException(status_code=400, detail="foto_b64 inválida.")

        caption = body.caption or ""
        borrador_id = None
        m_id = re.search(r"#(\d{1,10})", caption)
        if m_id:
            candidato = int(m_id.group(1))
            fila = _fila_borrador(cursor, candidato)
            if fila:
                borrador_id = candidato

        if borrador_id is None:
            corte = (datetime.now(ZONA_AR) - timedelta(seconds=VENTANA_WHATSAPP_SEG)).strftime("%Y-%m-%d %H:%M:%S")
            cursor.execute(
                """
                SELECT id FROM compras_borradores
                WHERE estado = 'BORRADOR' AND origen = 'WHATSAPP' AND origen_chat = ? AND updated_at >= ?
                ORDER BY id DESC LIMIT 1
                """,
                (chat, corte),
            )
            fila = cursor.fetchone()
            if fila:
                borrador_id = fila["id"]

        if borrador_id is None:
            borrador_id = _insertar_borrador(
                cursor,
                "WHATSAPP",
                1,
                origen_chat=chat,
                caption=caption,
                proveedor_id=body.proveedor_id,
                numero_factura=body.numero_factura,
            )

        meta = _adjuntar_bytes(
            cursor,
            borrador_id,
            raw,
            body.mime or "image/jpeg",
            body.filename or "whatsapp.jpg",
            "WHATSAPP",
        )
        if caption:
            cursor.execute(
                "UPDATE compras_borradores SET caption = ?, updated_at = ? WHERE id = ?",
                (caption[:500], _ahora_ar_dt(), borrador_id),
            )
        conexion.commit()
        ocr = {"estado": "omitido"}
        try:
            ocr = _ocr_borrador_completo(borrador_id)
        except Exception as e:
            print(f"OCR post-WhatsApp: {e}")
            ocr = {"estado": "error", "detalle": str(e)[:200]}
        fila = _fila_borrador(cursor, borrador_id)
        if fila is None:
            conexion2 = obtener_conexion()
            conexion2.row_factory = sqlite3.Row
            try:
                fila = _fila_borrador(conexion2.cursor(), borrador_id, incluir_cerrados=True)
            finally:
                conexion2.close()
        n_fotos = len(_parse_json_list(fila["fotos_json"])) if fila else 1
        return {
            "mensaje": "Foto en borrador. No se tocó stock.",
            "borrador_id": borrador_id,
            "foto": meta,
            "n_fotos": n_fotos,
            "ocr": ocr,
        }
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@router.post("/borradores/{borrador_id}/ocr", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ocr_borrador_factura(borrador_id: int):
    """Lee las fotos del borrador y precarga ítems. Nunca toca stock."""
    if not _ocr_clave_openai():
        raise HTTPException(
            status_code=400,
            detail="Falta OPENAI_API_KEY (o FACTURA_OCR_KEY) en el servidor para leer el papel.",
        )
    res = _ocr_borrador_completo(borrador_id)
    if res.get("estado") == "error":
        raise HTTPException(status_code=400, detail=res.get("detalle") or "No se pudo leer la factura.")
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        fila = _fila_borrador(cursor, borrador_id, incluir_cerrados=True)
        if not fila:
            raise HTTPException(status_code=404, detail="Borrador no encontrado.")
        payload = _payload_borrador(fila)
        payload["ocr"] = res
        return payload
    finally:
        conexion.close()


# --- 2. INGRESO DE MERCADERÍA (CON ACTUALIZACIÓN DE SALDO) ---
@router.post("/cargar_factura")
def ingresar_mercaderia(factura: NuevaFacturaCompra, background_tasks: BackgroundTasks,
                        payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    if not factura.items:
        raise HTTPException(status_code=400, detail="La factura no tiene productos.")
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        numero = (factura.numero_factura or "").strip() or f"INT-{int(datetime.now(ZONA_AR).timestamp())}"
        _exigir_factura_unica(cursor, factura.proveedor_id, numero, factura.forzar_duplicado)
        fecha_compra = _normalizar_fecha_compra(factura.fecha_compra)
        total_acumulado = 0.0
        
        # 1. Creamos la cabecera de la compra
        cursor.execute('''
            INSERT INTO compras_cabecera (proveedor_id, numero_factura, fecha_compra, total_factura, condicion_pago)
            VALUES (?, ?, ?, 0, ?)
        ''', (factura.proveedor_id, numero, fecha_compra, factura.condicion_pago))
        compra_id = cursor.lastrowid
        
        # 2. Procesamos cada producto que llegó en el camión
        for item in factura.items:
            if item.cantidad_comprada <= 0:
                raise HTTPException(status_code=400, detail="Hay un ítem con cantidad inválida.")
            if item.costo_unitario < 0:
                raise HTTPException(status_code=400, detail="Hay un ítem con costo negativo.")
            subtotal_item = item.cantidad_comprada * item.costo_unitario
            total_acumulado += subtotal_item
            
            cursor.execute("SELECT nombre FROM productos WHERE id = ?", (item.producto_id,))
            prod = cursor.fetchone()
            if not prod:
                raise HTTPException(status_code=400, detail=f"El producto #{item.producto_id} no existe. Vinculá o dales alta a las líneas sin catálogo.")

            cursor.execute('''
                INSERT INTO compras_detalle 
                (compra_id, producto_id, descripcion_historica, cantidad_comprada, costo_unitario, fecha_vencimiento, numero_lote_proveedor)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (compra_id, item.producto_id, prod['nombre'], item.cantidad_comprada, item.costo_unitario, item.fecha_vencimiento, item.numero_lote_proveedor))
            
            cursor.execute('''
                INSERT INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo')
            ''', (item.producto_id, item.numero_lote_proveedor, fecha_compra, item.fecha_vencimiento, item.cantidad_comprada, item.cantidad_comprada, item.costo_unitario))

            compensar_deuda_stock(cursor, item.producto_id, fecha_compra)

            # Costo siempre (CMV). Góndola solo si el operador la tildó.
            cursor.execute(
                "UPDATE productos SET costo_sin_iva = ? WHERE id = ?",
                (item.costo_unitario, item.producto_id),
            )
            if item.nuevo_precio_venta is not None:
                cursor.execute(
                    "UPDATE productos SET precio_venta_final = ? WHERE id = ?",
                    (item.nuevo_precio_venta, item.producto_id),
                )

# 3. ACTUALIZAMOS EL TOTAL DE LA FACTURA (Sumando los cargos extra)
        total_final_real = total_acumulado + factura.cargos_extra
        cursor.execute("UPDATE compras_cabecera SET total_factura = ? WHERE id = ?", (total_final_real, compra_id))
        
        # 4. SUMAMOS A LA DEUDA (Si es Cuenta Corriente)
        if factura.condicion_pago == "Cuenta Corriente":
            _sumar_deuda_proveedor(cursor, factura.proveedor_id, total_final_real)

        retiro_caja = None
        if factura.pago_inmediato:
            retiro_caja = _aplicar_pago_inmediato(
                cursor, factura.proveedor_id, total_final_real, factura.condicion_pago,
                factura.pago_inmediato, _usuario_desde_payload(payload)
            )

        conexion.commit()
        if retiro_caja is not None:
            _avisar_retiro_proveedor(
                background_tasks, factura.pago_inmediato.monto, factura.proveedor_id,
                _usuario_desde_payload(payload), retiro_caja
            )
        conexion.close()
        return {"mensaje": "Stock, Precios y Deuda actualizados correctamente", "total": total_final_real, "id": compra_id}
        
    except HTTPException:
        if conexion:
            conexion.rollback()
            conexion.close()
        raise
    except Exception as e:
            if conexion:
                conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
                conexion.close()
                
            mensaje_error = str(e)
            # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
            if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
                print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
                return {"error": "Ocurrió un error interno al procesar la solicitud."}
                
            # 2. Si es un error de negocio tuyo, lo mostramos normal
            return {"error": mensaje_error}
    
    # --- HISTORIAL DE COMPRAS ---
@router.get("/historial/{proveedor_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ver_historial_compras(proveedor_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # Traemos las cabeceras de las facturas
        cursor.execute('''
            SELECT id, numero_factura, fecha_compra, total_factura, condicion_pago
            FROM compras_cabecera
            WHERE proveedor_id = ?
            ORDER BY fecha_compra DESC
        ''', (proveedor_id,))
        compras = [dict(c) for c in cursor.fetchall()]
        
        conexion.close()
        return {"historial": compras}
    except Exception as e:
            if conexion:
                conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
                conexion.close()
                
            mensaje_error = str(e)
            # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
            if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
                print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
                return {"error": "Ocurrió un error interno al procesar la solicitud."}
                
            # 2. Si es un error de negocio tuyo, lo mostramos normal
            return {"error": mensaje_error}
    
    # --- VER DETALLE DE UNA FACTURA ESPECÍFICA ---
@router.get("/factura_detalle/{compra_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ver_detalle_factura(compra_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # 1. Traemos los productos
        cursor.execute('''
            SELECT descripcion_historica, cantidad_comprada, costo_unitario, 
                   (cantidad_comprada * costo_unitario) as subtotal
            FROM compras_detalle WHERE compra_id = ?
        ''', (compra_id,))
        detalle = [dict(c) for c in cursor.fetchall()]
        
        # 2. Calculamos la suma de mercadería pura
        suma_mercaderia = sum(d['subtotal'] for d in detalle)
        
        # 3. Traemos el total final que se guardó en la cabecera
        cursor.execute("SELECT total_factura FROM compras_cabecera WHERE id = ?", (compra_id,))
        cabecera = cursor.fetchone()
        total_real = cabecera['total_factura'] if cabecera else 0
        
        # 4. Los cargos extra son simplemente la diferencia
        cargos_calculados = total_real - suma_mercaderia
        
        conexion.close()
        return {
            "detalle": detalle, 
            "cargos_extra": cargos_calculados,
            "total_factura": total_real
        }
    except Exception as e:
            if conexion:
                conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
                conexion.close()
                
            mensaje_error = str(e)
            # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
            if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
                print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
                return {"error": "Ocurrió un error interno al procesar la solicitud."}
                
            # 2. Si es un error de negocio tuyo, lo mostramos normal
            return {"error": mensaje_error}
    
@router.get("/historial_pagos/{proveedor_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ver_pagos(proveedor_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT id, fecha_pago, monto_total_pagado as monto, metodo_pago, observaciones 
            FROM pagos_proveedores 
            WHERE proveedor_id = ? 
            ORDER BY fecha_pago DESC
        ''', (proveedor_id,))
        pagos = [dict(row) for row in cursor.fetchall()]
        return {"pagos": pagos}
    except Exception as e:
            if conexion:
                conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
                conexion.close()
                
            mensaje_error = str(e)
            # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
            if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
                print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
                return {"error": "Ocurrió un error interno al procesar la solicitud."}
                
            # 2. Si es un error de negocio tuyo, lo mostramos normal
            return {"error": mensaje_error}
    finally:
        conexion.close()
        
def migrar_proveedores():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("ALTER TABLE proveedores ADD COLUMN observaciones TEXT DEFAULT ''")
        conexion.commit()
    except:
        pass
    try:
        cursor.execute("ALTER TABLE movimientos_caja ADD COLUMN turno_id INTEGER")
        conexion.commit()
    except:
        pass # Si ya existe, no hace nada
    conexion.close()

migrar_proveedores()