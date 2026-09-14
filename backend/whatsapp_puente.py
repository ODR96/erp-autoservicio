"""Puente dispara-y-olvida hacia el microservicio Node (puerto 3000).

Contrato con el bot whatsapp-web.js:
  POST http://127.0.0.1:3000/enviar
  { "destino": "<id @c.us o @g.us>", "mensaje": "..." }
  Header opcional: X-ERP-Token = PUENTE_TOKEN / WHATSAPP_BRIDGE_TOKEN

Python NUNCA espera a que WhatsApp entregue. Si Node está caído, se loguea y el ERP sigue.
"""
import os
import requests
from backend.database import obtener_conexion

PUENTE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3000/enviar")
TIMEOUT_SEG = 0.5
TOKEN = (os.getenv("WHATSAPP_BRIDGE_TOKEN") or os.getenv("PUENTE_TOKEN") or "").strip()


def _normalizar_destino(raw: str) -> str:
    texto = (raw or "").strip()
    if not texto:
        return ""
    if "@" in texto:
        return texto
    digitos = "".join(ch for ch in texto if ch.isdigit())
    if not digitos:
        return ""
    if not digitos.startswith("54"):
        digitos = "54" + digitos
    return f"{digitos}@c.us"


def _telefono_admin():
    conexion = obtener_conexion()
    try:
        fila = conexion.execute("SELECT telefono FROM configuracion_local WHERE id = 1").fetchone()
        if not fila:
            return ""
        return _normalizar_destino(fila[0] or "")
    except Exception as e:
        print(f"WhatsApp puente: no se pudo leer el teléfono de config ({e})")
        return ""
    finally:
        conexion.close()


def enviar_whatsapp(mensaje: str, numero: str = None):
    destino = _normalizar_destino(numero) if numero else _telefono_admin()
    if not destino:
        print("WhatsApp puente: sin número en Configuración. No se envió.")
        return {"ok": False, "detalle": "Falta el teléfono en Configuración."}
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
