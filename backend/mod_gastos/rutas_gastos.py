from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone, timedelta
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

# =================================================================
# 0. MIGRACIONES AUTOMÁTICAS (BLINDAJE DE BASES DE DATOS)
# =================================================================
def asegurar_tablas_tesoreria():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    # Aseguramos que el registro de gastos soporte el Origen de los Fondos
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS gastos_operativos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha DATETIME NOT NULL,
            categoria_id INTEGER NOT NULL,
            descripcion_detalle TEXT,
            monto REAL NOT NULL,
            metodo_pago TEXT NOT NULL,
            origen_fondos TEXT DEFAULT 'CAJA_MAYOR',
            usuario_id INTEGER NOT NULL,
            turno_id INTEGER
        )
    ''')
    
    # Creamos la tabla de la Caja Mayor (La bóveda del local)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS movimientos_caja_mayor (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha_hora DATETIME NOT NULL,
            tipo_movimiento TEXT NOT NULL, 
            monto REAL NOT NULL,
            concepto TEXT NOT NULL,
            usuario_id INTEGER NOT NULL,
            referencia_gasto_id INTEGER
        )
    ''')
    
    conexion.commit()
    conexion.close()

asegurar_tablas_tesoreria()

# =================================================================
# 1. MODELOS DE DATOS ESTRICTOS
# =================================================================
class NuevaCategoria(BaseModel):
    nombre: str

class NuevoGasto(BaseModel):
    categoria_id: int
    descripcion_detalle: str
    monto: float
    metodo_pago: str 
    usuario_id: int
    origen_fondos: str  # "CAJA_DIARIA" o "CAJA_MAYOR"
    turno_id: Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from datetime import datetime, timezone, timedelta
import sqlite3
import logging
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

# Configuración de logging para reemplazar los prints
logging.basicConfig(level=logging.ERROR)
logger = logging.getLogger(__name__)

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

# --- DEPENDENCIAS ---
def get_db():
    """Maneja la conexión a la base de datos de forma segura."""
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        yield conexion
    finally:
        conexion.close()

# --- MODELOS ---
class NuevaCategoria(BaseModel):
    nombre: str = Field(..., min_length=2, max_length=50, strip_whitespace=True)

class NuevoGasto(BaseModel):
    categoria_id: int = Field(..., gt=0)
    descripcion_detalle: str = Field(..., min_length=3, max_length=255, strip_whitespace=True)
    monto: float = Field(..., gt=0, description="El monto debe ser mayor a 0")
    metodo_pago: str = Field(..., min_length=2, max_length=50, strip_whitespace=True)
    # Eliminamos usuario_id; debe venir del backend/token.

# --- RUTAS ---
@router.post("/categorias", status_code=status.HTTP_201_CREATED, dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def crear_categoria(cat: NuevaCategoria, db: sqlite3.Connection = Depends(get_db)):
    try:
        db.execute("INSERT INTO categorias_gasto (nombre) VALUES (?)", (cat.nombre,))
        db.commit()
        return {"mensaje": f"Categoría '{cat.nombre}' creada con éxito."}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="La categoría ya existe.")
    except Exception as e:
        db.rollback()
        logger.error(f"Error SQL al crear categoría: {e}")
        raise HTTPException(status_code=500, detail="Error interno del servidor.")

@router.post("/registrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def registrar_gasto_operativo(
    gasto: NuevoGasto, 
    db: sqlite3.Connection = Depends(get_db)
    # usuario_actual = Depends(obtener_usuario_actual) <-- Aquí inyectarías el usuario real
):
    usuario_id = 1 # Reemplazar con: usuario_actual.id
    fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
    
    try:
        db.execute('''
            INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago)
            VALUES (?, ?, ?, ?, ?)
        ''', (fecha_actual, gasto.categoria_id, gasto.descripcion_detalle, gasto.monto, gasto.metodo_pago))
        
        if "EFECTIVO" in gasto.metodo_pago.upper():
            turno = db.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'").fetchone()
            
            if not turno:
                raise HTTPException(
                    status_code=400, 
                    detail="No hay ningún turno de caja ABIERTO para registrar el retiro en efectivo."
                )
                
            db.execute('''
                INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones)
                VALUES (?, ?, 'RETIRO', ?, ?)
            ''', (fecha_actual, usuario_id, gasto.monto, f"Gasto: {gasto.descripcion_detalle}"))
                
        db.commit()
        return {"mensaje": "¡Gasto registrado y caja actualizada!"}
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error SQL al registrar gasto: {e}")
        raise HTTPException(status_code=500, detail="Error al procesar el gasto.")
    
@router.get("/historial", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_historial_gastos(limite: int = 50):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # Traemos los últimos gastos cruzando con el nombre de la categoría
        cursor.execute('''
            SELECT g.id, g.fecha, c.nombre as categoria, g.descripcion_detalle as detalle, 
                   g.monto, g.origen_fondos
            FROM gastos_operativos g
            JOIN categorias_gasto c ON g.categoria_id = c.id
            ORDER BY g.fecha DESC
            LIMIT ?
        ''', (limite,))
        
        historial = [dict(row) for row in cursor.fetchall()]
        return {"movimientos": historial}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()