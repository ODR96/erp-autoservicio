from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timezone, timedelta
import sqlite3
import logging
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

# Configuración de logging
logging.basicConfig(level=logging.ERROR)
logger = logging.getLogger(__name__)

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

# =================================================================
# 0. MIGRACIONES AUTOMÁTICAS (BLINDAJE DE BASES DE DATOS)
# =================================================================
def asegurar_tablas_tesoreria():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
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
# 1. DEPENDENCIAS Y MODELOS
# =================================================================
def get_db():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        yield conexion
    finally:
        conexion.close()

class NuevaCategoria(BaseModel):
    nombre: str = Field(..., min_length=2, max_length=50, strip_whitespace=True)

class NuevoGasto(BaseModel):
    categoria_id: int = Field(..., gt=0)
    descripcion_detalle: str = Field(..., min_length=3, max_length=255, strip_whitespace=True)
    monto: float = Field(..., gt=0)
    metodo_pago: str = Field(..., min_length=2, max_length=50)
    origen_fondos: str = Field(..., min_length=2, max_length=50)
    turno_id: Optional[int] = None
    usuario_id: Optional[int] = 1 # Por ahora lo dejamos fijo hasta conectar el token real

# =================================================================
# 2. RUTAS DE LA API
# =================================================================

@router.post("/categorias", status_code=status.HTTP_201_CREATED, dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def crear_categoria(cat: NuevaCategoria, db: sqlite3.Connection = Depends(get_db)):
    try:
        db.execute("INSERT INTO categorias_gasto (nombre) VALUES (?)", (cat.nombre,))
        db.commit()
        return {"mensaje": f"Categoría '{cat.nombre}' creada con éxito."}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail="Error al crear la categoría. ¿Quizás ya existe?")

@router.get("/categorias", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_categorias(db: sqlite3.Connection = Depends(get_db)):
    cursor = db.execute("SELECT * FROM categorias_gasto ORDER BY nombre ASC")
    return {"categorias": [dict(c) for c in cursor.fetchall()]}

@router.post("/registrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def registrar_gasto_operativo(gasto: NuevoGasto, db: sqlite3.Connection = Depends(get_db)):
    fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
    
    try:
        db.execute('''
            INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago, origen_fondos, usuario_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (fecha_actual, gasto.categoria_id, gasto.descripcion_detalle, gasto.monto, gasto.metodo_pago, gasto.origen_fondos, gasto.usuario_id))
        
        # Si la plata sale del mostrador, descontamos del turno abierto
        if "CAJA_DIARIA" in gasto.origen_fondos.upper() or "EFECTIVO" in gasto.metodo_pago.upper():
            turno = db.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'").fetchone()
            if not turno:
                raise HTTPException(status_code=400, detail="No hay turno de caja ABIERTO para sacar efectivo.")
                
            db.execute('''
                INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones)
                VALUES (?, ?, 'RETIRO', ?, ?)
            ''', (fecha_actual, gasto.usuario_id, gasto.monto, f"Gasto: {gasto.descripcion_detalle}"))
            
        db.commit()
        return {"mensaje": "¡Gasto registrado y caja actualizada!"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error registrando gasto: {e}")
        raise HTTPException(status_code=500, detail="Error al procesar el gasto.")

@router.get("/historial", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_historial_gastos(limite: int = 50, db: sqlite3.Connection = Depends(get_db)):
    cursor = db.execute('''
        SELECT g.id, g.fecha, c.nombre as categoria, g.descripcion_detalle as detalle, 
               g.monto, g.origen_fondos
        FROM gastos_operativos g
        JOIN categorias_gasto c ON g.categoria_id = c.id
        ORDER BY g.fecha DESC
        LIMIT ?
    ''', (limite,))
    return {"movimientos": [dict(row) for row in cursor.fetchall()]}

@router.get("/resumen_mensual", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def resumen_gastos_del_mes(db: sqlite3.Connection = Depends(get_db)):
    mes_actual = datetime.now(ZONA_AR).strftime("%Y-%m")
    cursor = db.execute('''
        SELECT c.nombre as categoria, SUM(g.monto) as total_gastado
        FROM gastos_operativos g
        JOIN categorias_gasto c ON g.categoria_id = c.id
        WHERE strftime('%Y-%m', g.fecha) = ?
        GROUP BY c.id
    ''')
    return {"mes": mes_actual, "gastos_por_categoria": [dict(r) for r in cursor.fetchall()]}