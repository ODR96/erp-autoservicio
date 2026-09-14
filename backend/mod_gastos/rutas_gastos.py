from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks
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
    if 'activo' not in cols_cat:
        # Soft-delete: una categoría con gastos históricos nunca se borra de verdad (rompería
        # los reportes viejos), simplemente se oculta de los selectores para gastos nuevos.
        cursor.execute("ALTER TABLE categorias_gasto ADD COLUMN activo INTEGER DEFAULT 1")

    # 2. Escaneo inteligente (Gastos)
    cursor.execute("PRAGMA table_info(gastos_operativos)")
    cols_gastos = [col[1] for col in cursor.fetchall()]
    
    if 'origen_fondos' not in cols_gastos:
        cursor.execute("ALTER TABLE gastos_operativos ADD COLUMN origen_fondos TEXT DEFAULT 'CAJA_MAYOR'")
    if 'turno_id' not in cols_gastos:
        cursor.execute("ALTER TABLE gastos_operativos ADD COLUMN turno_id INTEGER")
    if 'usuario_id' not in cols_gastos:
        cursor.execute("ALTER TABLE gastos_operativos ADD COLUMN usuario_id INTEGER DEFAULT 1")
    if 'estado' not in cols_gastos:
        # BLINDAJE: permite "anular" un gasto (ej: liquidaciones de sueldo revertidas)
        # sin borrar el registro contable, igual que ventas_cabecera.estado = 'ANULADA'
        cursor.execute("ALTER TABLE gastos_operativos ADD COLUMN estado TEXT DEFAULT 'ACTIVO'")

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

class EditarCategoria(BaseModel):
    nombre: str = Field(..., min_length=2, max_length=50)
    tipo_categoria: str = Field(..., description="OPERATIVO o RETIRO_SOCIO")
    activo: bool = True

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
@router.post("/categorias", status_code=status.HTTP_201_CREATED, dependencies=[Depends(VerificarRol(["ADMIN"]))])
def crear_categoria(cat: NuevaCategoria, db: sqlite3.Connection = Depends(get_db)):
    try:
        db.execute("INSERT INTO categorias_gasto (nombre, tipo_categoria) VALUES (?, ?)", (cat.nombre, cat.tipo_categoria))
        db.commit()
        return {"mensaje": f"Categoría creada."}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/categorias", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_categorias(incluir_inactivas: bool = False, db: sqlite3.Connection = Depends(get_db)):
    try:
        if incluir_inactivas:
            # Para la pantalla de administración de categorías (ver y poder reactivar las ocultas)
            cursor = db.execute("SELECT * FROM categorias_gasto ORDER BY IFNULL(activo, 1) DESC, nombre ASC")
        else:
            # Para cualquier selector donde se elige categoría para un gasto NUEVO (F10, Cheques
            # y Gastos, RRHH): las categorías ocultas no deben poder elegirse de nuevo.
            cursor = db.execute("SELECT * FROM categorias_gasto WHERE IFNULL(activo, 1) = 1 ORDER BY nombre ASC")
        return {"categorias": [dict(c) for c in cursor.fetchall()]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/categorias/{categoria_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def editar_categoria(categoria_id: int, cat: EditarCategoria, db: sqlite3.Connection = Depends(get_db)):
    try:
        existente = db.execute("SELECT id FROM categorias_gasto WHERE id = ?", (categoria_id,)).fetchone()
        if not existente:
            raise HTTPException(status_code=404, detail="La categoría no existe.")

        db.execute(
            "UPDATE categorias_gasto SET nombre = ?, tipo_categoria = ?, activo = ? WHERE id = ?",
            (cat.nombre, cat.tipo_categoria, 1 if cat.activo else 0, categoria_id)
        )
        db.commit()
        return {"mensaje": "Categoría actualizada."}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/categorias/{categoria_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def eliminar_categoria(categoria_id: int, db: sqlite3.Connection = Depends(get_db)):
    try:
        existente = db.execute("SELECT id FROM categorias_gasto WHERE id = ?", (categoria_id,)).fetchone()
        if not existente:
            raise HTTPException(status_code=404, detail="La categoría no existe.")

        en_uso = db.execute("SELECT COUNT(*) as c FROM gastos_operativos WHERE categoria_id = ?", (categoria_id,)).fetchone()['c']

        if en_uso == 0:
            # Nunca se usó: se puede borrar de verdad, no hay ningún reporte histórico que dependa de ella.
            db.execute("DELETE FROM categorias_gasto WHERE id = ?", (categoria_id,))
            db.commit()
            return {"mensaje": "Categoría eliminada permanentemente (nunca tuvo gastos registrados)."}
        else:
            # Tiene historial: la ocultamos (soft-delete) para no romper los gastos ya registrados
            # ni los reportes de meses anteriores.
            db.execute("UPDATE categorias_gasto SET activo = 0 WHERE id = ?", (categoria_id,))
            db.commit()
            return {"mensaje": f"La categoría tiene {en_uso} gasto(s) registrado(s), así que se ocultó en vez de borrarla (para no afectar el historial)."}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

def _alerta_gasto_alto(monto: float, detalle: str):
    from backend.whatsapp_puente import enviar_whatsapp
    enviar_whatsapp(
        f"Gasto operativo alto\n"
        f"Monto: ${monto:,.2f}\n"
        f"Detalle: {detalle or 'Sin detalle'}"
    )

@router.post("/registrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_gasto_operativo(gasto: NuevoGasto, background_tasks: BackgroundTasks, db: sqlite3.Connection = Depends(get_db)):
    try:
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        db.execute('''
            INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago, origen_fondos, usuario_id, turno_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (fecha_actual, gasto.categoria_id, gasto.descripcion_detalle, gasto.monto, gasto.metodo_pago, gasto.origen_fondos, gasto.usuario_id, gasto.turno_id))
        
        # EL ARREGLO DEL RETIRO DEL POS
        retiro_de_caja = False
        turno_retiro = None
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
            retiro_de_caja = True
            turno_retiro = turno['id']
            
        db.commit()
        from backend.whatsapp_puente import avisar_retiro, nombre_usuario
        if retiro_de_caja:
            background_tasks.add_task(
                avisar_retiro,
                gasto.monto,
                f"Gasto: {gasto.descripcion_detalle or 'Sin detalle'}",
                nombre_usuario(gasto.usuario_id),
                turno_retiro,
            )
        elif gasto.monto > 50000:
            background_tasks.add_task(_alerta_gasto_alto, gasto.monto, gasto.descripcion_detalle)
        return {"mensaje": "Gasto y retiro registrados."}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error registrando gasto: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/historial", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def obtener_historial_gastos(limite: int = 50, db: sqlite3.Connection = Depends(get_db)):
    try:
        cursor = db.execute('''
            SELECT g.id, g.fecha, c.nombre as categoria, g.descripcion_detalle as detalle, 
                   g.monto, g.origen_fondos, IFNULL(g.estado, 'ACTIVO') as estado
            FROM gastos_operativos g
            JOIN categorias_gasto c ON g.categoria_id = c.id
            ORDER BY g.fecha DESC LIMIT ?
        ''', (limite,))
        return {"movimientos": [dict(row) for row in cursor.fetchall()]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/resumen_mensual", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def resumen_gastos_del_mes(db: sqlite3.Connection = Depends(get_db)):
    try:
        mes_actual = datetime.now(ZONA_AR).strftime("%Y-%m")
        cursor = db.execute('''
            SELECT c.nombre as categoria, IFNULL(c.tipo_categoria, 'OPERATIVO') as tipo_categoria, SUM(g.monto) as total_gastado
            FROM gastos_operativos g
            JOIN categorias_gasto c ON g.categoria_id = c.id
            WHERE strftime('%Y-%m', g.fecha) = ?
            AND IFNULL(g.estado, 'ACTIVO') = 'ACTIVO'
            GROUP BY c.id
        ''', (mes_actual,))
        por_categoria = [dict(r) for r in cursor.fetchall()]
        fila_cajon = db.execute('''
            SELECT IFNULL(SUM(monto), 0) as total
            FROM gastos_operativos
            WHERE strftime('%Y-%m', fecha) = ?
            AND IFNULL(estado, 'ACTIVO') = 'ACTIVO'
            AND origen_fondos LIKE '%CAJA_DIARIA%'
        ''', (mes_actual,)).fetchone()
        return {
            "mes": mes_actual,
            "gastos_por_categoria": por_categoria,
            "salidas_cajon": fila_cajon['total'] if fila_cajon else 0
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))