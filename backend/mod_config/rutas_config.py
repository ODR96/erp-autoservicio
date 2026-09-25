from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import FileResponse
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pydantic import BaseModel
from typing import List
import sqlite3
import shutil
import os
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()

CARPETA_LOGOS = "static/logos"
os.makedirs(CARPETA_LOGOS, exist_ok=True)

# --- 1. PREPARAR LA BASE DE DATOS (MIGRACIÓN INTELIGENTE) ---
def asegurar_tabla_configuracion():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS configuracion_local (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            nombre_negocio TEXT DEFAULT 'Mi Negocio',
            direccion TEXT DEFAULT 'Dirección, Ciudad',
            telefono TEXT DEFAULT '',
            mensaje_ticket TEXT DEFAULT '¡Gracias por su compra!',
            ruta_logo TEXT DEFAULT ''
        )
    ''')
    
    # PARCHE DE MIGRACIÓN: Inyectamos las columnas nuevas para la versión SaaS
    try: cursor.execute("ALTER TABLE configuracion_local ADD COLUMN cuit TEXT DEFAULT '00-00000000-0'")
    except: pass
    try: cursor.execute("ALTER TABLE configuracion_local ADD COLUMN condicion_iva TEXT DEFAULT 'Responsable Inscripto'")
    except: pass
    try: cursor.execute("ALTER TABLE configuracion_local ADD COLUMN impresora_por_defecto TEXT DEFAULT '80mm'")
    except: pass
    try: cursor.execute("ALTER TABLE configuracion_local ADD COLUMN tope_maximo_descuento_sueldo_pct REAL DEFAULT 50.0")
    except: pass
    try: cursor.execute("ALTER TABLE configuracion_local ADD COLUMN whatsapp_grupo_compras TEXT DEFAULT ''")
    except: pass
    try: cursor.execute("ALTER TABLE configuracion_local ADD COLUMN umbral_descuento_pct REAL DEFAULT 5")
    except: pass
    try: cursor.execute("ALTER TABLE configuracion_local ADD COLUMN umbral_descuento_pesos REAL DEFAULT 0")
    except: pass

    cursor.execute("INSERT OR IGNORE INTO configuracion_local (id) VALUES (1)")
    conexion.commit()
    conexion.close()

asegurar_tabla_configuracion()

# Costo del banco y si ese costo se le cobra al cliente.
# La semilla es la de este local. Una instalación nueva la cambia en esta pantalla.
# INSERT OR IGNORE: no pisa un porcentaje que el dueño ya guardó.
SEMILLA_COMISIONES = (
    ("EFECTIVO", "Efectivo", 0.0, 0),
    ("TRANSFERENCIA", "Transferencia", 0.0, 0),
    ("TARJETA", "Tarjeta", 7.0, 1),
    ("QR", "QR", 0.8, 0),
)


def asegurar_comisiones_medio():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS comisiones_medio (
            codigo TEXT PRIMARY KEY,
            nombre TEXT NOT NULL,
            pct_costo REAL NOT NULL DEFAULT 0,
            recargo_activo INTEGER NOT NULL DEFAULT 0
        )
    ''')
    cursor.executemany(
        "INSERT OR IGNORE INTO comisiones_medio (codigo, nombre, pct_costo, recargo_activo) VALUES (?, ?, ?, ?)",
        SEMILLA_COMISIONES,
    )
    conexion.commit()
    conexion.close()


asegurar_comisiones_medio()


def plata(valor) -> float:
    return float(Decimal(str(valor)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def clasificar_medio(metodo: str) -> str:
    m = (metodo or "").upper()
    if "QR" in m:
        return "QR"
    if "TARJETA" in m:
        return "TARJETA"
    if "TRANSFERENCIA" in m or "BILLETERA" in m:
        return "TRANSFERENCIA"
    if "EFECTIVO" in m:
        return "EFECTIVO"
    return ""


def liquidar_comision(cursor, metodo: str, base: float, cobrar_recargo: bool):
    """Devuelve (cobrado, recargo, comision). El porcentaje sale de configuración, no del POS."""
    codigo = clasificar_medio(metodo)
    base_d = Decimal(str(base)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if not codigo:
        return float(base_d), 0.0, 0.0
    cursor.execute(
        "SELECT pct_costo, recargo_activo FROM comisiones_medio WHERE codigo = ?",
        (codigo,),
    )
    fila = cursor.fetchone()
    if not fila:
        return float(base_d), 0.0, 0.0
    pct = Decimal(str(fila[0] or 0))
    if pct <= 0:
        return float(base_d), 0.0, 0.0
    if pct >= 100:
        raise Exception("La comisión configurada no puede ser 100% o más.")
    tasa = pct / Decimal("100")
    recargo_on = int(fila[1] or 0) == 1 and bool(cobrar_recargo)
    if recargo_on:
        cobrado = (base_d / (Decimal("1") - tasa)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        comision = (cobrado * tasa).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        recargo = (cobrado - base_d).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        return float(cobrado), float(recargo), float(comision)
    comision = (base_d * tasa).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(base_d), 0.0, float(comision)


class ComisionMedioIn(BaseModel):
    codigo: str
    pct_costo: float = 0
    recargo_activo: bool = False

# --- 2. ACTUALIZAR DATOS DE TEXTO ---
@router.put("/actualizar_datos", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def actualizar_configuracion(
    nombre_negocio: str = Form(...),
    direccion: str = Form(...),
    telefono: str = Form(...),
    mensaje_ticket: str = Form(...),
    cuit: str = Form(...),
    condicion_iva: str = Form(...),
    impresora_por_defecto: str = Form(...),
    tope_maximo_descuento_sueldo_pct: float = Form(50.0),
    whatsapp_grupo_compras: str = Form(""),
    umbral_descuento_pct: float = Form(5),
    umbral_descuento_pesos: float = Form(0),
):
    if tope_maximo_descuento_sueldo_pct < 0 or tope_maximo_descuento_sueldo_pct > 100:
        return {"error": "El tope de descuento de sueldo debe ser un porcentaje entre 0 y 100."}
    if umbral_descuento_pct < 0 or umbral_descuento_pct > 100:
        return {"error": "El aviso de descuento tiene que ser un porcentaje entre 0 y 100."}
    if umbral_descuento_pesos < 0:
        return {"error": "El aviso de descuento en pesos no puede ser negativo."}

    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            UPDATE configuracion_local 
            SET nombre_negocio = ?, direccion = ?, telefono = ?, mensaje_ticket = ?, cuit = ?, condicion_iva = ?, impresora_por_defecto = ?, tope_maximo_descuento_sueldo_pct = ?, whatsapp_grupo_compras = ?, umbral_descuento_pct = ?, umbral_descuento_pesos = ?
            WHERE id = 1
        ''', (nombre_negocio, direccion, telefono, mensaje_ticket, cuit, condicion_iva, impresora_por_defecto, tope_maximo_descuento_sueldo_pct, (whatsapp_grupo_compras or "").strip(), umbral_descuento_pct, umbral_descuento_pesos))
        conexion.commit()
        return {"mensaje": "¡Configuración del negocio guardada con éxito!"}
    except Exception as e:
        if conexion:
            conexion.rollback()
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        return {"error": mensaje_error}
    finally:
        # Usamos check de existencia por si falló el obtener_conexion
        if 'conexion' in locals() and conexion:
            conexion.close()

# --- 3. SUBIR EL LOGO DE LA EMPRESA (BUG CORREGIDO Y BLINDADO) ---
@router.post("/subir_logo", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def subir_logo_empresa(archivo: UploadFile = File(...)):
    # 1. Blindaje extra: Validar extensiones explícitamente
    extension = archivo.filename.split(".")[-1].lower()
    extensiones_permitidas = ["jpg", "jpeg", "png", "webp"]
    
    if not archivo.content_type.startswith("image/") or extension not in extensiones_permitidas:
        raise HTTPException(status_code=400, detail="Formato inválido. Debe ser JPG, PNG o WEBP.")
    
    nombre_archivo = f"logo_empresa.{extension}"
    ruta_guardado = f"{CARPETA_LOGOS}/{nombre_archivo}"
    
    conexion = None # <-- LA SOLUCIÓN AL BUG (Nace vacía por las dudas)
    try:
        with open(ruta_guardado, "wb") as buffer:
            shutil.copyfileobj(archivo.file, buffer)
            
        conexion = obtener_conexion()
        cursor = conexion.cursor()
        cursor.execute("UPDATE configuracion_local SET ruta_logo = ? WHERE id = 1", (nombre_archivo,))
        conexion.commit()
        
        return {"mensaje": "¡Logo actualizado!", "ruta_logo": nombre_archivo}
    except Exception as e:
        if conexion:
            conexion.rollback()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        return {"error": mensaje_error}
    finally:
        if conexion:
            conexion.close()

@router.post("/probar_whatsapp", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def probar_whatsapp():
    from backend.whatsapp_puente import enviar_whatsapp
    resultado = enviar_whatsapp("ERPetto: prueba de aviso WhatsApp. Si leés esto, el puente Node está vivo.")
    return resultado

@router.post("/probar_whatsapp_grupo", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def probar_whatsapp_grupo():
    from backend.whatsapp_puente import enviar_whatsapp, destino_grupo_compras
    destino = destino_grupo_compras()
    if not destino:
        return {"ok": False, "detalle": "Falta el grupo de compras en Configuración. Guardá el ID (...@g.us) y volvé a probar."}
    return enviar_whatsapp(
        "ERPetto: prueba al grupo de compras. Si leés esto, los faltantes del Cierre Z van a llegar acá.",
        numero=destino,
    )

@router.get("/comisiones", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def leer_comisiones():
    asegurar_comisiones_medio()
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute(
            """SELECT codigo, nombre, pct_costo, recargo_activo FROM comisiones_medio
               ORDER BY CASE codigo
                    WHEN 'EFECTIVO' THEN 1
                    WHEN 'TRANSFERENCIA' THEN 2
                    WHEN 'TARJETA' THEN 3
                    WHEN 'QR' THEN 4
                    ELSE 9 END"""
        )
        return [
            {
                "codigo": row["codigo"],
                "nombre": row["nombre"],
                "pct_costo": row["pct_costo"] or 0,
                "recargo_activo": bool(row["recargo_activo"]),
            }
            for row in cursor.fetchall()
        ]
    finally:
        conexion.close()


@router.put("/comisiones", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def guardar_comisiones(medios: List[ComisionMedioIn]):
    if not medios:
        raise HTTPException(status_code=400, detail="No hay medios para guardar.")
    vistos = set()
    for medio in medios:
        codigo = (medio.codigo or "").strip().upper()
        if codigo not in {fila[0] for fila in SEMILLA_COMISIONES}:
            raise HTTPException(status_code=400, detail="Medio de pago desconocido.")
        if codigo in vistos:
            raise HTTPException(status_code=400, detail="Medio de pago repetido.")
        if medio.pct_costo < 0 or medio.pct_costo >= 100:
            raise HTTPException(status_code=400, detail="El costo tiene que ser un porcentaje entre 0 y 100, sin llegar a 100.")
        vistos.add(codigo)

    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        for medio in medios:
            cursor.execute(
                "UPDATE comisiones_medio SET pct_costo = ?, recargo_activo = ? WHERE codigo = ?",
                (medio.pct_costo, 1 if medio.recargo_activo else 0, medio.codigo.strip().upper()),
            )
        conexion.commit()
        return {"mensaje": "Comisiones guardadas."}
    except Exception as e:
        conexion.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conexion.close()


# --- 4. LEER LA CONFIGURACIÓN ---
# Esta ruta la usa el POS para imprimir tickets, así que el cajero NECESITA poder leerla
@router.get("/leer", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def obtener_configuracion():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT * FROM configuracion_local WHERE id = 1")
    config = cursor.fetchone()
    conexion.close()
    return dict(config)

# --- 5. DESCARGAR BACKUP (LA RUTA MÁS PELIGROSA, AHORA BLINDADA) ---
@router.get("/descargar_backup", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def descargar_base_datos():
    fecha = datetime.now().strftime("%Y%m%d_%H%M")
    return FileResponse(
        path="autoservicio_20dejunio.db", 
        filename=f"Autoservicio_Backup_{fecha}.db", 
        media_type="application/x-sqlite3"
    )