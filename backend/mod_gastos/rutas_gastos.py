from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timezone, timedelta
import sqlite3
import logging
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

logging.basicConfig(level=logging.ERROR)
logger = logging.getLogger(__name__)

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

def asegurar_tablas_tesoreria():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    cursor.execute('''CREATE TABLE IF NOT EXISTS gastos_operativos (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha DATETIME NOT NULL, categoria_id INTEGER NOT NULL, descripcion_detalle TEXT, monto REAL NOT NULL, metodo_pago TEXT NOT NULL, usuario_id INTEGER NOT NULL DEFAULT 1)''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS movimientos_caja_mayor (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha_hora DATETIME NOT NULL, tipo_movimiento TEXT NOT NULL, monto REAL NOT NULL, concepto TEXT NOT NULL, usuario_id INTEGER NOT NULL, referencia_gasto_id INTEGER)''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS categorias_gasto (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL)''')

    # 1. Escaneo inteligente (Categorías)
    cursor.execute("PRAGMA table_info(categorias_gasto)")
    cols_cat = [col[1] for col in cursor.fetchall()]
    if 'tipo_categoria' not in cols_cat:
        cursor.execute("ALTER TABLE categorias_gasto ADD COLUMN tipo_categoria TEXT DEFAULT 'OPERATIVO'")

    # 2. Escaneo inteligente (Gastos)
    cursor.execute("PRAGMA table_info(gastos_operativos)")
    cols_gastos = [col[1] for col in cursor.fetchall()]
    
    if 'origen_fondos' not in cols_gastos:
        cursor.execute("ALTER TABLE gastos_operativos ADD COLUMN origen_fondos TEXT DEFAULT 'CAJA_MAYOR'")
    if 'turno_id' not in cols_gastos:
        cursor.execute("ALTER TABLE gastos_operativos ADD COLUMN turno_id INTEGER")
    if 'usuario_id' not in cols_gastos:
        cursor.execute("ALTER TABLE gastos_operativos ADD COLUMN usuario_id INTEGER DEFAULT 1")

    # 3. EL PARCHE NUEVO: Escaneo de la tabla del POS
    try:
        cursor.execute("PRAGMA table_info(movimientos_caja)")
        cols_movs = [col[1] for col in cursor.fetchall()]
        if cols_movs: # Si la tabla existe
            if 'caja_id' not in cols_movs:
                cursor.execute("ALTER TABLE movimientos_caja ADD COLUMN caja_id INTEGER")
            if 'turno_id' not in cols_movs:
                cursor.execute("ALTER TABLE movimientos_caja ADD COLUMN turno_id INTEGER")
    except Exception:
        pass
        
    conexion.commit()
    conexion.close()

asegurar_tablas_tesoreria()

def get_db():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try: yield conexion
    finally: conexion.close()

class NuevaCategoria(BaseModel):
    nombre: str = Field(..., min_length=2, max_length=50)
    tipo_categoria: str = Field(..., description="OPERATIVO o RETIRO_SOCIO")

class NuevoGasto(BaseModel):
    categoria_id: int = Field(..., gt=0)
    descripcion_detalle: str = Field(..., min_length=3, max_length=255)
    monto: float = Field(..., gt=0)
    metodo_pago: str = Field(..., min_length=2, max_length=50)
    origen_fondos: str = Field(..., min_length=2, max_length=50)
    turno_id: Optional[int] = None
    usuario_id: int

# =================================================================
# 1. RUTAS BLINDADAS
# =================================================================
@router.post("/categorias", status_code=status.HTTP_201_CREATED, dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def crear_categoria(cat: NuevaCategoria, db: sqlite3.Connection = Depends(get_db)):
    try:
        db.execute("INSERT INTO categorias_gasto (nombre, tipo_categoria) VALUES (?, ?)", (cat.nombre, cat.tipo_categoria))
        db.commit()
        return {"mensaje": f"Categoría creada."}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/categorias", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_categorias(db: sqlite3.Connection = Depends(get_db)):
    try:
        cursor = db.execute("SELECT * FROM categorias_gasto ORDER BY nombre ASC")
        return {"categorias": [dict(c) for c in cursor.fetchall()]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/registrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_gasto_operativo(gasto: NuevoGasto, db: sqlite3.Connection = Depends(get_db)):
    try:
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        db.execute('''
            INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago, origen_fondos, usuario_id, turno_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (fecha_actual, gasto.categoria_id, gasto.descripcion_detalle, gasto.monto, gasto.metodo_pago, gasto.origen_fondos, gasto.usuario_id, gasto.turno_id))
        
        # EL ARREGLO DEL RETIRO DEL POS
        if "CAJA_DIARIA" in gasto.origen_fondos.upper() or "EFECTIVO" in gasto.metodo_pago.upper():
            turno = db.execute("SELECT id, caja_id FROM turnos_caja WHERE estado_turno = 'ABIERTO' AND id = ?", (gasto.turno_id,)).fetchone()
            if not turno:
                turno = db.execute("SELECT id, caja_id FROM turnos_caja WHERE estado_turno = 'ABIERTO' ORDER BY id DESC LIMIT 1").fetchone()
                
            if not turno:
                raise HTTPException(status_code=400, detail="No hay turno abierto para sacar efectivo.")
                
            # Ahora inyectamos los 7 parámetros correctos
            db.execute('''
                INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id, caja_id)
                VALUES (?, ?, 'RETIRO', ?, ?, ?, ?)
            ''', (fecha_actual, gasto.usuario_id, gasto.monto, f"Gasto: {gasto.descripcion_detalle}", turno['id'], turno['caja_id']))
            
        db.commit()
        return {"mensaje": "Gasto y retiro registrados."}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error registrando gasto: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/historial", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_historial_gastos(limite: int = 50, db: sqlite3.Connection = Depends(get_db)):
    try:
        cursor = db.execute('''
            SELECT g.id, g.fecha, c.nombre as categoria, g.descripcion_detalle as detalle, 
                   g.monto, g.origen_fondos
            FROM gastos_operativos g
            JOIN categorias_gasto c ON g.categoria_id = c.id
            ORDER BY g.fecha DESC LIMIT ?
        ''', (limite,))
        return {"movimientos": [dict(row) for row in cursor.fetchall()]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/resumen_mensual", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def resumen_gastos_del_mes(db: sqlite3.Connection = Depends(get_db)):
    try:
        mes_actual = datetime.now(ZONA_AR).strftime("%Y-%m")
        cursor = db.execute('''
            SELECT c.nombre as categoria, IFNULL(c.tipo_categoria, 'OPERATIVO') as tipo_categoria, SUM(g.monto) as total_gastado
            FROM gastos_operativos g
            JOIN categorias_gasto c ON g.categoria_id = c.id
            WHERE strftime('%Y-%m', g.fecha) = ?
            GROUP BY c.id
        ''', (mes_actual,))
        return {"mes": mes_actual, "gastos_por_categoria": [dict(r) for r in cursor.fetchall()]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))