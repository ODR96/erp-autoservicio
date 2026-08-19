from fastapi import APIRouter, Depends
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()

# --- CORRECCIÓN HORARIA PARA ARGENTINA ---
ZONA_AR = timezone(timedelta(hours=-3))

# --- 1. GUARDIAS ---
class NuevaCategoria(BaseModel):
    nombre: str

class NuevoGasto(BaseModel):
    categoria_id: int
    descripcion_detalle: str
    monto: float
    metodo_pago: str 
    usuario_id: int = 1 # <-- CORRECCIÓN: Ahora podés mandarle quién hizo el gasto

# --- 2. CATEGORÍAS DE GASTOS ---
@router.post("/categorias", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def crear_categoria(cat: NuevaCategoria):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("INSERT INTO categorias_gasto (nombre) VALUES (?)", (cat.nombre,))
        conexion.commit()
        conexion.close()
        return {"mensaje": f"Categoría '{cat.nombre}' creada con éxito."}
    except Exception as e:
        if conexion:
            conexion.rollback() 
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        return {"error": mensaje_error}

@router.get("/categorias", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_categorias():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT * FROM categorias_gasto ORDER BY nombre ASC")
    categorias = cursor.fetchall()
    conexion.close()
    return {"categorias": [dict(c) for c in categorias]}

# --- 3. REGISTRAR EL GASTO ---
@router.post("/registrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def registrar_gasto_operativo(gasto: NuevoGasto):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        # CORRECCIÓN: Usamos la hora local real
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        cursor.execute('''
            INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago)
            VALUES (?, ?, ?, ?, ?)
        ''', (fecha_actual, gasto.categoria_id, gasto.descripcion_detalle, gasto.monto, gasto.metodo_pago))
        
        if "EFECTIVO" in gasto.metodo_pago.upper():
            cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'")
            turno = cursor.fetchone()
            
            if turno:
                # CORRECCIÓN: Usamos el usuario_id real en vez del "1" hardcodeado
                cursor.execute('''
                    INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones)
                    VALUES (?, ?, 'RETIRO', ?, ?)
                ''', (fecha_actual, gasto.usuario_id, gasto.monto, f"Gasto: {gasto.descripcion_detalle}"))
            else:
                raise Exception("Trataste de pagar un gasto en Efectivo, pero no hay ningún turno de caja ABIERTO para sacar la plata.")
                
        conexion.commit()
        conexion.close()
        return {"mensaje": "¡Gasto registrado y plata descontada de la caja!"}
        
    except Exception as e:
        if conexion:
            conexion.rollback() 
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        return {"error": mensaje_error}

# --- 4. RESUMEN DEL MES ---
@router.get("/resumen_mensual", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def resumen_gastos_del_mes():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # CORRECCIÓN: Mes local
    mes_actual = datetime.now(ZONA_AR).strftime("%Y-%m")
    
    try:
        cursor.execute('''
            SELECT c.nombre as categoria, SUM(g.monto) as total_gastado
            FROM gastos_operativos g
            JOIN categorias_gasto c ON g.categoria_id = c.id
            WHERE strftime('%Y-%m', g.fecha) = ?
            GROUP BY c.id
        ''', (mes_actual,))
        
        resumen = cursor.fetchall()
        conexion.close()
        
        return {
            "mes": mes_actual,
            "gastos_por_categoria": [dict(r) for r in resumen]
        }
    except Exception as e:
        if conexion:
            conexion.rollback() 
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        return {"error": mensaje_error}