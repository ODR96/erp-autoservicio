"""Puente dispara-y-olvida hacia el microservicio Node (puerto 3000).

Python NUNCA espera a que WhatsApp entregue el mensaje. Si Node está caído,
se loguea y el ERP sigue. No usar pywhatkit, selenium ni librerías de WhatsApp.
"""
import os
import requests
from backend.database import obtener_conexion

PUENTE_URL = os.getenv("WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3000")
TIMEOUT_SEG = 0.5


def _normalizar_numero(raw: str) -> str:
    texto = (raw or "").strip()
    if not texto:
        return ""
    if texto.startswith("+"):
        return "+" + "".join(ch for ch in texto[1:] if ch.isdigit())
    return "".join(ch for ch in texto if ch.isdigit())


def _telefono_admin():
    conexion = obtener_conexion()
    try:
        fila = conexion.execute("SELECT telefono FROM configuracion_local WHERE id = 1").fetchone()
        if not fila:
            return ""
        return _normalizar_numero(fila[0] or "")
    except Exception as e:
        print(f"WhatsApp puente: no se pudo leer el teléfono de config ({e})")
        return ""
    finally:
        conexion.close()


def enviar_whatsapp(mensaje: str, numero: str = None):
    destino = _normalizar_numero(numero or _telefono_admin())
    if not destino:
        print("WhatsApp puente: sin número en Configuración. No se envió.")
        return {"ok": False, "detalle": "Falta el teléfono en Configuración."}
    if not (mensaje or "").strip():
        return {"ok": False, "detalle": "Mensaje vacío."}
    try:
        res = requests.post(
            PUENTE_URL,
            json={"numero": destino, "mensaje": mensaje.strip()},
            timeout=TIMEOUT_SEG,
        )
        if res.status_code >= 400:
            print(f"WhatsApp puente: Node respondió {res.status_code} en {PUENTE_URL}")
            return {"ok": False, "detalle": f"Node respondió {res.status_code}."}
        return {"ok": True, "detalle": f"Pedido enviado al puente ({res.status_code})."}
    except Exception as e:
        print(f"WhatsApp puente: Node no respondió en {PUENTE_URL} ({e})")
        return {"ok": False, "detalle": f"Node no respondió en {PUENTE_URL}."}
