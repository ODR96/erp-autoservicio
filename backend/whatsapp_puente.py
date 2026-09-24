"""Puente dispara-y-olvida hacia el microservicio Node (puerto 3000).

Contrato con el bot whatsapp-web.js:
  POST http://127.0.0.1:3000/enviar
  { "destino": "<id @c.us o @g.us>", "mensaje": "..." }
  Header opcional: X-ERP-Token = PUENTE_TOKEN / WHATSAPP_BRIDGE_TOKEN

Python NUNCA espera a que WhatsApp entregue. Si Node está caído, se loguea y el ERP sigue.

Destinos en configuracion_local:
  telefono                 → dueño (Cierre Z, retiros, gasto alto sin caja)
  whatsapp_grupo_compras   → grupo (digest de faltantes del turno)
"""
import os
import sqlite3
from collections import OrderedDict
import requests
from backend.database import obtener_conexion

PUENTE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3000/enviar")
TIMEOUT_SEG = 0.5
TOKEN = (os.getenv("WHATSAPP_BRIDGE_TOKEN") or os.getenv("PUENTE_TOKEN") or "").strip()


def _plata(monto) -> str:
    return f"${float(monto or 0):,.2f}"


def _normalizar_destino(raw: str) -> str:
    texto = (raw or "").strip()
    if not texto:
        return ""
    if "@" in texto:
        return texto
    digitos = "".join(ch for ch in texto if ch.isdigit())
    if not digitos:
        return ""
    if digitos.startswith("00"):
        digitos = digitos[2:]
    if digitos.startswith("0"):
        digitos = digitos[1:]
    if len(digitos) >= 10 and digitos.startswith("15"):
        digitos = digitos[2:]
    if digitos.startswith("549"):
        pass
    elif digitos.startswith("54"):
        digitos = "549" + digitos[2:]
    elif digitos.startswith("9") and len(digitos) >= 11:
        digitos = "54" + digitos
    else:
        digitos = "549" + digitos
    return f"{digitos}@c.us"


def _leer_destino_config(columna: str) -> str:
    if columna not in ("telefono", "whatsapp_grupo_compras"):
        return ""
    conexion = obtener_conexion()
    try:
        fila = conexion.execute(
            f"SELECT {columna} FROM configuracion_local WHERE id = 1"
        ).fetchone()
        if not fila:
            return ""
        return _normalizar_destino(fila[0] or "")
    except Exception as e:
        print(f"WhatsApp puente: no se pudo leer {columna} ({e})")
        return ""
    finally:
        conexion.close()


def _telefono_admin():
    return _leer_destino_config("telefono")


def _grupo_compras():
    return _leer_destino_config("whatsapp_grupo_compras")


def destino_grupo_compras():
    return _grupo_compras()


def nombre_usuario(usuario_id) -> str:
    if not usuario_id:
        return ""
    conexion = obtener_conexion()
    try:
        fila = conexion.execute(
            "SELECT nombre_completo FROM usuarios WHERE id = ?", (usuario_id,)
        ).fetchone()
        if not fila:
            return f"Usuario #{usuario_id}"
        return fila[0] or f"Usuario #{usuario_id}"
    except Exception:
        return f"Usuario #{usuario_id}"
    finally:
        conexion.close()


def enviar_whatsapp(mensaje: str, numero: str = None):
    destino = _normalizar_destino(numero) if numero else _telefono_admin()
    if not destino:
        print("WhatsApp puente: sin destino. No se envió.")
        return {"ok": False, "detalle": "Falta el teléfono o el grupo en Configuración."}
    if not (mensaje or "").strip():
        return {"ok": False, "detalle": "Mensaje vacío."}
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["X-ERP-Token"] = TOKEN
    try:
        res = requests.post(
            PUENTE_URL,
            json={"destino": destino, "mensaje": mensaje.strip()},
            headers=headers,
            timeout=TIMEOUT_SEG,
        )
        if res.status_code >= 400:
            print(f"WhatsApp puente: Node respondió {res.status_code} en {PUENTE_URL}")
            return {"ok": False, "detalle": f"Node respondió {res.status_code}."}
        return {"ok": True, "detalle": f"Pedido enviado al puente ({res.status_code})."}
    except Exception as e:
        print(f"WhatsApp puente: Node no respondió en {PUENTE_URL} ({e})")
        return {"ok": False, "detalle": f"Node no respondió en {PUENTE_URL}."}


def avisar_autorizacion_remota(motivo: str, link: str):
    """Aviso al dueño. El enlace no autoriza: en el celular se confirma con PIN."""
    lineas = [
        "Autorización de caja",
        (motivo or "").strip()[:300],
        "",
        link,
        "Vigencia: 3 minutos. Confirmá con tu PIN.",
    ]
    return enviar_whatsapp("\n".join(lineas))


def avisar_ticket_cliente(telefono: str, texto: str):
    destino = _normalizar_destino(telefono)
    if not destino:
        return {"ok": False, "detalle": "Ese cliente no tiene un WhatsApp válido."}
    return enviar_whatsapp(texto, numero=destino)


def _fecha_ar(valor) -> str:
    texto = str(valor or "").strip()
    if len(texto) >= 10 and texto[4] == "-" and texto[7] == "-":
        return f"{texto[8:10]}/{texto[5:7]}/{texto[0:4]}"
    return texto or "-"


def avisar_liquidacion_sueldo(telefono: str, datos: dict):
    destino = _normalizar_destino(telefono)
    if not destino:
        return {"ok": False, "detalle": "Ese WhatsApp no es válido."}
    conexion = obtener_conexion()
    try:
        fila = conexion.execute(
            "SELECT nombre_negocio FROM configuracion_local WHERE id = 1"
        ).fetchone()
        negocio = " ".join(str((fila[0] if fila else "") or "").split()) or "ERPetto"
    except Exception:
        negocio = "ERPetto"
    finally:
        conexion.close()
    lineas = [
        negocio,
        "Liquidación de sueldo",
        f"Empleado: {datos.get('empleado') or '-'}",
        f"Período: {_fecha_ar(datos.get('periodo_desde'))} a {_fecha_ar(datos.get('periodo_hasta'))}",
        f"Modalidad: {datos.get('modalidad') or '-'}",
        f"Bruto: {_plata(datos.get('monto_bruto'))}",
        f"Descuentos: {_plata(datos.get('descuento_aplicado'))}",
        f"Neto a cobrar: {_plata(datos.get('monto_neto'))}",
    ]
    saldo = float(datos.get("saldo_pendiente") or 0)
    if saldo > 0.009:
        lineas.append(f"Saldo que queda pendiente: {_plata(saldo)}")
    return enviar_whatsapp("\n".join(lineas), numero=destino)


def avisar_retiro(monto, motivo: str, usuario: str = "", turno_id=None):
    lineas = [f"Retiro de caja {_plata(monto)}"]
    if usuario:
        lineas.append(f"Quién: {usuario}")
    if turno_id:
        lineas.append(f"Turno #{turno_id}")
    if (motivo or "").strip():
        lineas.append((motivo or "").strip())
    return enviar_whatsapp("\n".join(lineas))


def avisar_cierre_z(datos: dict):
    lineas = [
        f"Cierre Z #{datos.get('turno_id')}",
        f"Cajero: {datos.get('cajero') or '-'}",
        f"Fondo inicial: {_plata(datos.get('fondo_inicial'))}",
        f"Efectivo: {_plata(datos.get('ventas_efectivo'))}",
        f"Tarjeta: {_plata(datos.get('ventas_tarjeta'))}",
        f"Transferencia / QR: {_plata(datos.get('ventas_transferencia'))}",
        f"Billetera: {_plata(datos.get('ventas_virtual'))}",
        f"Fiado: {_plata(datos.get('ventas_fiados'))}",
        f"Ingresos extra: {_plata(datos.get('ingresos'))}",
        f"Retiros: {_plata(datos.get('retiros'))}",
    ]
    detalle_retiros = datos.get("detalle_retiros") or []
    for item in detalle_retiros[:12]:
        obs = (item.get("obs") or "Retiro").strip()
        if len(obs) > 60:
            obs = obs[:57] + "..."
        lineas.append(f"  • {_plata(item.get('monto'))} {obs}")
    if len(detalle_retiros) > 12:
        lineas.append(f"  • … y {len(detalle_retiros) - 12} retiro(s) más")
    lineas.extend([
        f"Sistema esperaba: {_plata(datos.get('esperado'))}",
        f"Declarado: {_plata(datos.get('declarado'))}",
        f"Diferencia: {_plata(datos.get('diferencia'))}",
    ])
    return enviar_whatsapp("\n".join(lineas))


def _agrupar_faltantes(filas):
    grupos = OrderedDict()
    for fila in filas:
        nombre = (fila["descripcion_producto"] or "").strip()
        clave = nombre.lower()
        if not clave:
            continue
        if clave not in grupos:
            grupos[clave] = {"nombre": nombre, "cantidad": 0.0, "quienes": []}
        grupos[clave]["cantidad"] += float(fila["cantidad_pedida"] or 0)
        quien = (fila["usuario_anoto"] or "").strip()
        if quien and quien not in grupos[clave]["quienes"]:
            grupos[clave]["quienes"].append(quien)
    return list(grupos.values())


def avisar_faltantes_del_turno(turno_id, fecha_apertura, fecha_cierre, cajero: str):
    destino = _grupo_compras()
    if not destino:
        print("WhatsApp puente: sin grupo de compras en Configuración. Digest omitido.")
        return {"ok": False, "detalle": "Falta el grupo de compras en Configuración."}

    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        filas = conexion.execute(
            '''
            SELECT descripcion_producto, cantidad_pedida, usuario_anoto
            FROM productos_solicitados_faltantes
            WHERE IFNULL(estado, 'PENDIENTE') = 'PENDIENTE'
              AND IFNULL(origen, 'POS') = 'POS'
              AND fecha_hora >= ? AND fecha_hora <= ?
            ORDER BY id ASC
            ''',
            (fecha_apertura, fecha_cierre),
        ).fetchall()
    except Exception as e:
        print(f"WhatsApp puente: no se pudieron leer faltantes del turno ({e})")
        return {"ok": False, "detalle": "No se pudieron leer los faltantes."}
    finally:
        conexion.close()

    agrupados = _agrupar_faltantes(filas)
    if not agrupados:
        return {"ok": True, "detalle": "Sin faltantes en el turno."}

    lineas = [
        f"Faltantes turno #{turno_id}",
        f"Cajero: {cajero or '-'}",
        f"{fecha_apertura} → {fecha_cierre}",
        "",
    ]
    for item in agrupados:
        cant = item["cantidad"]
        cant_txt = str(int(cant)) if cant == int(cant) else f"{cant:g}"
        quienes = ", ".join(item["quienes"]) if item["quienes"] else "-"
        lineas.append(f"• {item['nombre']} x{cant_txt} — {quienes}")
    return enviar_whatsapp("\n".join(lineas), numero=destino)


def avisar_pedido_faltantes(items, quien: str = ""):
    """Pedido armado desde Faltantes (selección o visibles). Texto al grupo de compras."""
    destino = _grupo_compras()
    if not destino:
        print("WhatsApp puente: sin grupo de compras. Pedido de faltantes omitido.")
        return {"ok": False, "detalle": "Falta el grupo de compras en Configuración."}

    limpios = []
    for item in items or []:
        nombre = (item.get("producto") or "").strip()
        if not nombre:
            continue
        limpios.append(item)
    if not limpios:
        return {"ok": False, "detalle": "No hay ítems para enviar."}

    tope = 40
    lineas = ["Pedido de faltantes"]
    if quien:
        lineas.append(f"Armó: {quien}")
    lineas.append("")
    for item in limpios[:tope]:
        cant = item.get("cantidad") or "1"
        linea = f"• {item.get('producto')} x{cant}"
        obs = (item.get("observacion") or "").strip()
        if obs:
            linea += f" ({obs})"
        lineas.append(linea)
    if len(limpios) > tope:
        lineas.append(f"… y {len(limpios) - tope} ítem(s) más")
    return enviar_whatsapp("\n".join(lineas), numero=destino)
