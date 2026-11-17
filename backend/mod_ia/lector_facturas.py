"""Lectura de facturas de proveedores con Gemini (SDK google-genai).

Gemini solo transcribe el papel. Las cuentas (neto sin IVA, bultos, cargos del pie)
las hace calculo_costos.py en Python.
"""
import importlib.util
import os
import time

from pydantic import BaseModel, Field

# En el plan gratis los flash completos viven saturados (503/504); el lite lee la factura en ~5 s.
MODELO_POR_DEFECTO = "gemini-3.5-flash-lite"
TIMEOUT_MS = 90_000
ESPERAS_REINTENTO_503 = (4, 10)
MIMES_ADMITIDOS = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"}


class LineaLeida(BaseModel):
    codigo: str = Field(description="Código de barras o SKU impreso en la línea. Vacío si no hay uno claro. No inventes.")
    descripcion: str = Field(description="Descripción del producto tal como figura.")
    cantidad_bultos_o_packs: float = Field(description="El número de la columna cantidad, tal cual está impreso.")
    unidades_por_bulto: int = Field(
        description="Si la cantidad cuenta bultos, packs, cajas o fardos (por ejemplo 'x6', 'pack 12', 'caja x24' en la descripción o una columna de unidades), cuántas unidades sueltas trae cada uno. Si la cantidad ya es de unidades sueltas, 1."
    )
    precio_unitario_impreso: float = Field(description="Precio unitario impreso (por cada unidad de la columna cantidad), antes de la bonificación. 0 si no figura.")
    descuento_porcentaje: float = Field(description="Bonificación o descuento de la línea en %. 0 si no tiene.")
    importe_linea: float = Field(description="Importe total de la línea tal como figura, ya bonificado. 0 si no figura.")
    alicuota_iva: float = Field(description="Alícuota de IVA de la línea si figura: 21, 10.5, 27 o 0. Si no figura, -1.")
    impuesto_interno_linea: float = Field(description="Impuestos internos de esta línea si figuran en la misma línea. 0 si no.")
    confianza: float = Field(description="Qué tan seguro estás de esta línea, de 0 a 1.")


class FacturaLeida(BaseModel):
    es_manuscrita_o_ilegible: bool = Field(description="true si es manuscrita o no se puede leer. En ese caso items vacío.")
    tipo_comprobante: str = Field(description="A, B, C, REMITO, TICKET u OTRO.")
    precios_incluyen_iva: bool = Field(
        description="true si los precios de las líneas ya traen IVA (factura B o C, ticket, remito a precio final). false si son netos con el IVA discriminado en el pie (factura A)."
    )
    proveedor: str = Field(description="Razón social o nombre de fantasía del emisor.")
    numero_factura: str = Field(description="Número del comprobante, por ejemplo 0003-00012345. Vacío si no se lee.")
    fecha: str = Field(description="Fecha de emisión en formato YYYY-MM-DD. Vacío si no se lee.")
    descuento_general_porcentaje: float = Field(description="Bonificación general del pie en %, que se aplica a todas las líneas. 0 si no hay.")
    impuestos_internos_total: float = Field(description="Impuestos internos del pie, solo si NO figuran ya en las líneas. 0 si no.")
    percepciones_y_otros_cargos: float = Field(description="Suma de percepciones (IIBB, IVA, ganancias), flete y otros cargos del pie. 0 si no hay.")
    total_papel: float = Field(description="Total a pagar del comprobante. 0 si no se lee.")
    items: list[LineaLeida]


PROMPT = """Sos un transcriptor de facturas y remitos de proveedores de Argentina.
Transcribí el comprobante en el esquema pedido. No hagas cuentas: copiá los números como están impresos.
- Una línea por producto. No cargues como producto las líneas de subtotal, IVA, percepciones, impuestos internos del pie, flete ni redondeo.
- Números sin separador de miles y con punto decimal (1.234,50 en el papel es 1234.5).
- Si el comprobante tiene varias páginas o fotos, es uno solo: no repitas líneas que se ven en dos fotos.
- Si una línea no se lee bien, bajá la confianza; no la inventes."""


def _clave() -> str:
    return (os.getenv("GEMINI_API_KEY") or "").strip()


def disponible() -> bool:
    return bool(_clave()) and importlib.util.find_spec("google.genai") is not None


def _mensaje_error(e) -> str:
    codigo = getattr(e, "code", None)
    if codigo == 404:
        return "Ese modelo de Gemini ya no está disponible. Cambiá GEMINI_MODELO en el .env."
    if codigo == 503:
        return "Gemini está saturado ahora (es de Google, pasa seguido en el plan gratis). Probá en unos minutos."
    if codigo == 504:
        return "Gemini tardó demasiado en leer. Probá de nuevo; si sigue, mandá la foto más cerca y derecha."
    if codigo == 429:
        return "Gemini sin cuota por ahora (límite del plan). Probá en un rato."
    if codigo in (400, 401, 403) and "key" in str(e).lower():
        return "GEMINI_API_KEY inválida o sin permiso."
    if codigo:
        return f"Gemini HTTP {codigo}"
    return "No se pudo hablar con Gemini."


def leer_factura(archivos: list) -> dict:
    """archivos: [{"mime": str, "datos": bytes}]. Devuelve lo transcripto, sin cuentas."""
    clave = _clave()
    if not clave:
        return {"estado": "sin_clave"}
    partes_archivo = [a for a in archivos if a.get("mime") in MIMES_ADMITIDOS and a.get("datos")]
    if not partes_archivo:
        return {"estado": "sin_imagen"}

    from google import genai
    from google.genai import types

    modelo = (os.getenv("GEMINI_MODELO") or MODELO_POR_DEFECTO).strip()
    cliente = genai.Client(api_key=clave, http_options=types.HttpOptions(timeout=TIMEOUT_MS))
    contenido = [types.Part.from_bytes(data=a["datos"], mime_type=a["mime"]) for a in partes_archivo] + [PROMPT]
    config = types.GenerateContentConfig(
        temperature=0,
        # Transcribir no necesita razonar: con el nivel por defecto pasa los 90 s y Google corta con 504.
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
        response_mime_type="application/json",
        response_schema=FacturaLeida,
    )
    inicio = time.monotonic()
    for espera in ESPERAS_REINTENTO_503 + (None,):
        try:
            respuesta = cliente.models.generate_content(model=modelo, contents=contenido, config=config)
            break
        except Exception as e:
            print(f"Lector Gemini: {type(e).__name__}: {str(e)[:300]}")
            # El bot y nginx esperan 120 s: solo se reintenta si el 503 llegó rápido.
            if getattr(e, "code", None) != 503 or espera is None or time.monotonic() - inicio > 20:
                return {"estado": "error", "detalle": _mensaje_error(e)}
            time.sleep(espera)

    leida = respuesta.parsed
    if not isinstance(leida, FacturaLeida):
        try:
            leida = FacturaLeida.model_validate_json(respuesta.text or "")
        except Exception:
            return {"estado": "error", "detalle": "Gemini no devolvió la factura en el formato pedido."}

    datos = leida.model_dump()
    return {
        "estado": "ok",
        "motor": "gemini",
        "mano": datos["es_manuscrita_o_ilegible"],
        "proveedor": datos["proveedor"],
        "numero_factura": datos["numero_factura"],
        "fecha": datos["fecha"],
        "total_papel": datos["total_papel"] if datos["total_papel"] > 0 else None,
        "leida": datos,
    }
