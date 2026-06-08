from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from pydantic import BaseModel
import sqlite3
import shutil
import os

router = APIRouter()

CARPETA_LOGOS = "static/logos"
os.makedirs(CARPETA_LOGOS, exist_ok=True)

# --- 1. PREPARAR LA BASE DE DATOS (MIGRACIÓN INTELIGENTE) ---
def asegurar_tabla_configuracion():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
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

    cursor.execute("INSERT OR IGNORE INTO configuracion_local (id) VALUES (1)")
    conexion.commit()
    conexion.close()

asegurar_tabla_configuracion()

# --- 2. ACTUALIZAR DATOS DE TEXTO ---
@router.put("/actualizar_datos")
def actualizar_configuracion(
    nombre_negocio: str = Form(...),
    direccion: str = Form(...),
    telefono: str = Form(...),
    mensaje_ticket: str = Form(...),
    cuit: str = Form(...),
    condicion_iva: str = Form(...),
    impresora_por_defecto: str = Form(...)
):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            UPDATE configuracion_local 
            SET nombre_negocio = ?, direccion = ?, telefono = ?, mensaje_ticket = ?, cuit = ?, condicion_iva = ?, impresora_por_defecto = ?
            WHERE id = 1
        ''', (nombre_negocio, direccion, telefono, mensaje_ticket, cuit, condicion_iva, impresora_por_defecto))
        conexion.commit()
        return {"mensaje": "¡Configuración del negocio guardada con éxito!"}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()

# --- 3. SUBIR EL LOGO DE LA EMPRESA ---
@router.post("/subir_logo")
def subir_logo_empresa(archivo: UploadFile = File(...)):
    if not archivo.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Debe ser una imagen.")
    
    extension = archivo.filename.split(".")[-1]
    nombre_archivo = f"logo_empresa.{extension}"
    ruta_guardado = f"{CARPETA_LOGOS}/{nombre_archivo}"
    
    try:
        with open(ruta_guardado, "wb") as buffer:
            shutil.copyfileobj(archivo.file, buffer)
            
        conexion = sqlite3.connect('autoservicio_20dejunio.db')
        cursor = conexion.cursor()
        # Guardamos solo el nombre del archivo, el frontend sabe buscar en /static/logos/
        cursor.execute("UPDATE configuracion_local SET ruta_logo = ? WHERE id = 1", (nombre_archivo,))
        conexion.commit()
        conexion.close()
        
        return {"mensaje": "¡Logo actualizado!", "ruta_logo": nombre_archivo}
    except Exception as e:
        return {"error": str(e)}

# --- 4. LEER LA CONFIGURACIÓN (Para el Frontend y los Tickets) ---
@router.get("/leer")
def obtener_configuracion():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT * FROM configuracion_local WHERE id = 1")
    config = cursor.fetchone()
    conexion.close()
    return dict(config)