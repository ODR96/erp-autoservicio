from fastapi import APIRouter
from pydantic import BaseModel
from datetime import date, datetime, timezone, timedelta
import sqlite3
import os
from fastapi import BackgroundTasks
from backend.replicador import replicar_fila_a_nube

router = APIRouter()

ZONA_AR = timezone(timedelta(hours=-3))

# --- MODELOS DE DATOS ---
class LoteNuevo(BaseModel):
    producto_id: int
    numero_lote_proveedor: str = ""  
    fecha_vencimiento: date          
    cantidad_inicial: float
    costo_real_ingreso: float

class BajaManual(BaseModel):
    lote_id: int
    cantidad_a_bajar: float
    motivo: str  # Ej: "Rotura", "Vencido", "Consumo interno"
    usuario_id: int = 1


# --- 1. INGRESAR MERCADERÍA AL DEPÓSITO ---
@router.post("/ingresar")
def ingresar_lote(lote: LoteNuevo, background_tasks: BackgroundTasks):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        fecha_hoy = date.today()
        ahora = datetime.now(ZONA_AR) # <-- Sacamos la hora exacta
        num_lote = lote.numero_lote_proveedor
        
        if num_lote == "":
            # Ahora le sumamos %H%M%S (Hora, Minuto, Segundo) para que sea imposible que se repita
            num_lote = f"LOTE-INT-{ahora.strftime('%Y%m%d-%H%M%S')}-PROD{lote.producto_id}"

        cursor.execute('''
            INSERT INTO lotes_stock 
            (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, 
            cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo')
        ''', (lote.producto_id, num_lote, fecha_hoy, lote.fecha_vencimiento, 
              lote.cantidad_inicial, lote.cantidad_inicial, lote.costo_real_ingreso))
        
        cursor.execute('UPDATE productos SET costo_sin_iva = ? WHERE id = ?', (lote.costo_real_ingreso, lote.producto_id))
        
        lote_id = cursor.lastrowid
        background_tasks.add_task(replicar_fila_a_nube, 'lotes_stock', lote_id)
        background_tasks.add_task(replicar_fila_a_nube, 'productos', lote.producto_id) # Porque le cambiaste el costo!
        
        conexion.commit()
        
        conexion.close()
        return {"mensaje": "¡Mercadería ingresada y costo actualizado!"}
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


# --- 2. LISTAR STOCK EN GÓNDOLA ---
@router.get("/listar_activos")
def listar_lotes_activos():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row 
    cursor = conexion.cursor()
    cursor.execute('''
        SELECT l.id as lote_id, p.nombre as producto, l.numero_lote_proveedor, 
               l.fecha_vencimiento, l.cantidad_disponible 
        FROM lotes_stock l
        JOIN productos p ON l.producto_id = p.id
        WHERE l.cantidad_disponible > 0 AND l.estado_lote = 'Activo'
        ORDER BY l.fecha_vencimiento ASC
    ''')
    lotes = cursor.fetchall()
    conexion.close()
    return {"lotes_en_gondola": [dict(lote) for lote in lotes]}


# --- 3. BAJA MANUAL DE STOCK (Mejorada para reportes) ---
@router.put("/baja_manual")
def dar_baja_manual(datos: BajaManual, background_tasks: BackgroundTasks):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # Buscamos de qué producto es este lote para anotarlo bien en el reporte
        cursor.execute("SELECT cantidad_disponible, producto_id FROM lotes_stock WHERE id = ?", (datos.lote_id,))
        resultado = cursor.fetchone()
        
        if not resultado:
            return {"error": "Ese lote no existe."}
            
        stock_actual = resultado[0]
        producto_id = resultado[1]
        
        if datos.cantidad_a_bajar > stock_actual:
            return {"error": f"No podés dar de baja {datos.cantidad_a_bajar}. Solo hay {stock_actual} en este lote."}
            
        nuevo_stock = stock_actual - datos.cantidad_a_bajar
        
        # 1. Actualizamos el stock real en la góndola
        cursor.execute("UPDATE lotes_stock SET cantidad_disponible = ? WHERE id = ?", (nuevo_stock, datos.lote_id))
        
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        # 2. PASO CLAVE PARA REPORTES: Anotamos en el historial (Kardex)
        cursor.execute('''
            INSERT INTO movimientos_stock 
            (producto_id, lote_id, cantidad, tipo_movimiento, motivo, usuario_id, fecha_hora)
            VALUES (?, ?, ?, 'Baja Manual / Merma', ?, ?, ?)
        ''', (producto_id, datos.lote_id, datos.cantidad_a_bajar, datos.motivo, datos.usuario_id, fecha_actual))
        
        background_tasks.add_task(replicar_fila_a_nube, 'lotes_stock', datos.lote_id)
        conexion.commit()
        conexion.close()
        
        return {
            "mensaje": "Stock ajustado y registrado en auditoría.", 
            "motivo_registrado": datos.motivo,
            "stock_restante_en_lote": nuevo_stock
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
    
    # --- 4. DESCUENTO AUTOMÁTICO DE STOCK (El método FIFO para Ventas) ---
class DescuentoStock(BaseModel):
    producto_id: int
    cantidad_vendida: float

@router.put("/descontar_fifo")
def descontar_stock_fifo(datos: DescuentoStock):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    
    try:
        # Buscamos los lotes con stock, ordenados del que vence primero al último
        cursor.execute('''
            SELECT id, cantidad_disponible 
            FROM lotes_stock 
            WHERE producto_id = ? AND cantidad_disponible > 0 AND estado_lote = 'Activo'
            ORDER BY fecha_vencimiento ASC
        ''', (datos.producto_id,))
        
        lotes = cursor.fetchall()
        cantidad_restante_por_descontar = datos.cantidad_vendida
        
        # Empezamos a descontar
        for lote in lotes:
            lote_id = lote[0]
            disponible_en_este_lote = lote[1]
            
            if cantidad_restante_por_descontar <= 0:
                break 
                
            if disponible_en_este_lote >= cantidad_restante_por_descontar:
                nuevo_disponible = disponible_en_este_lote - cantidad_restante_por_descontar
                cursor.execute("UPDATE lotes_stock SET cantidad_disponible = ? WHERE id = ?", (nuevo_disponible, lote_id))
                cantidad_restante_por_descontar = 0
            else:
                cursor.execute("UPDATE lotes_stock SET cantidad_disponible = 0 WHERE id = ?", (lote_id,))
                cantidad_restante_por_descontar -= disponible_en_este_lote
                
        conexion.commit()
        conexion.close()
        
        if cantidad_restante_por_descontar > 0:
            return {"aviso": f"Se descontó todo, pero faltaron {cantidad_restante_por_descontar} unidades en el sistema."}
            
        return {"mensaje": "¡Stock descontado perfectamente usando el método FIFO!"}
        
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
    
    # --- 5. CONSULTAR STOCK TOTAL DE UN PRODUCTO ---
@router.get("/stock_total/{producto_id}")
def consultar_stock_total(producto_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    
    # Le pedimos a SQLite que sume todas las cantidades disponibles de los lotes activos de ese producto
    cursor.execute('''
        SELECT SUM(cantidad_disponible) 
        FROM lotes_stock 
        WHERE producto_id = ? AND estado_lote = 'Activo' AND cantidad_disponible > 0
    ''', (producto_id,))
    
    resultado = cursor.fetchone()[0]
    conexion.close()
    
    # Si resultado es None (no hay lotes), devolvemos 0
    stock_total = resultado if resultado else 0
    return {"producto_id": producto_id, "stock_total": stock_total}