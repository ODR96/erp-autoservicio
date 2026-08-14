from fastapi import APIRouter
from pydantic import BaseModel
from datetime import datetime
import sqlite3

router = APIRouter()

# --- 1. GUARDIAS ---
class NuevaCategoria(BaseModel):
    nombre: str

class NuevoGasto(BaseModel):
    categoria_id: int
    descripcion_detalle: str
    monto: float
    metodo_pago: str # Ej: "Efectivo Caja", "Transferencia Banco", "Cheque"

# --- 2. CATEGORÍAS DE GASTOS ---
@router.post("/categorias")
def crear_categoria(cat: NuevaCategoria):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        cursor.execute("INSERT INTO categorias_gasto (nombre) VALUES (?)", (cat.nombre,))
        conexion.commit()
        conexion.close()
        return {"mensaje": f"Categoría '{cat.nombre}' creada con éxito."}
    except Exception as e:
        if conexion:
            conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        # 2. Si es un error de negocio tuyo, lo mostramos normal
        return {"error": mensaje_error}

@router.get("/categorias")
def listar_categorias():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT * FROM categorias_gasto ORDER BY nombre ASC")
    categorias = cursor.fetchall()
    conexion.close()
    return {"categorias": [dict(c) for c in categorias]}

# --- 3. REGISTRAR EL GASTO ---
@router.post("/registrar")
def registrar_gasto_operativo(gasto: NuevoGasto):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        fecha_actual = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        cursor.execute('''
            INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago)
            VALUES (?, ?, ?, ?, ?)
        ''', (fecha_actual, gasto.categoria_id, gasto.descripcion_detalle, gasto.monto, gasto.metodo_pago))
        
        # MAGIA CONTABLE ARREGLADA: Si la palabra "EFECTIVO" está en el método de pago
        if "EFECTIVO" in gasto.metodo_pago.upper():
            cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'")
            turno = cursor.fetchone()
            
            if turno:
                cursor.execute('''
                    INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones)
                    VALUES (?, 1, 'RETIRO', ?, ?)
                ''', (fecha_actual, gasto.monto, f"Gasto: {gasto.descripcion_detalle}"))
            else:
                # Si no hay caja abierta, frenamos todo para que no se te descontrole la contabilidad
                raise Exception("Trataste de pagar un gasto en Efectivo, pero no hay ningún turno de caja ABIERTO para sacar la plata.")
                
        conexion.commit()
        conexion.close()
        return {"mensaje": "¡Gasto registrado y plata descontada de la caja!"}
        
    except Exception as e:
        if conexion:
            conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        # 2. Si es un error de negocio tuyo, lo mostramos normal
        return {"error": mensaje_error}

# --- 4. RESUMEN DEL MES (Para el Dashboard) ---
@router.get("/resumen_mensual")
def resumen_gastos_del_mes():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # Traemos el año y mes actual para filtrar
    mes_actual = datetime.now().strftime("%Y-%m")
    
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
            conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        # 2. Si es un error de negocio tuyo, lo mostramos normal
        return {"error": mensaje_error}