from fastapi import APIRouter, Query
from pydantic import BaseModel
from datetime import datetime, timedelta
import sqlite3

router = APIRouter()

class ProductoFaltante(BaseModel):
    descripcion: str
    cantidad: float = 1.0
    notas: str = ""

# --- 1. ALERTAS DEL DASHBOARD (Para ver a la mañana) ---
@router.get("/alertas")
def obtener_alertas_dashboard():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()

    try:
        # A. Stock Crítico: Busca qué productos están por debajo de tu límite de alerta
        cursor.execute('''
            SELECT p.nombre, p.stock_minimo_alerta, 
                   IFNULL((SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = p.id AND estado_lote = 'Activo'), 0) as stock_actual
            FROM productos p
            WHERE stock_actual <= p.stock_minimo_alerta AND p.activo = 1
        ''')
        alertas_stock = [dict(row) for row in cursor.fetchall()]

        # B. Vencimientos Próximos: Busca qué mercadería vence en los próximos 30 días
        cursor.execute('''
            SELECT p.nombre, l.numero_lote_proveedor, l.fecha_vencimiento, l.cantidad_disponible 
            FROM lotes_stock l
            JOIN productos p ON l.producto_id = p.id
            WHERE l.cantidad_disponible > 0 AND l.estado_lote = 'Activo' 
            AND l.fecha_vencimiento <= date('now', '+30 days')
            ORDER BY l.fecha_vencimiento ASC
        ''')
        alertas_vencimiento = [dict(row) for row in cursor.fetchall()]

        conexion.close()
        return {
            "alertas_stock_critico": alertas_stock,
            "alertas_vencimientos": alertas_vencimiento
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


# --- 2. LA VERDAD DE LA MILANESA: GANANCIA NETA REAL ---
@router.get("/ganancia_neta")
def calcular_ganancia_neta(mes: str = None):
    # Si no le mandamos mes, analiza el mes actual en curso
    if not mes:
        mes = datetime.now().strftime("%Y-%m")

    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()

    try:
        # 1. INGRESOS BRUTOS (Toda la plata de ventas cobradas o fiadas confirmadas)
        cursor.execute('''
            SELECT SUM(total_venta) FROM ventas_cabecera 
            WHERE strftime('%Y-%m', fecha_hora) = ? 
            AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
        ''', (mes,))
        ingresos = cursor.fetchone()[0] or 0.0

        # 2. COSTO DE MERCADERÍA VENDIDA (CMV) - Lo que te costó a vos comprar esa mercadería
        cursor.execute('''
            SELECT SUM(v.cantidad * p.costo_sin_iva) 
            FROM ventas_detalle v
            JOIN ventas_cabecera c ON v.venta_id = c.id
            JOIN productos p ON v.producto_id = p.id
            WHERE strftime('%Y-%m', c.fecha_hora) = ?
            AND c.estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
        ''', (mes,))
        costos_mercaderia = cursor.fetchone()[0] or 0.0

        # 3. GASTOS OPERATIVOS FIJOS (Los que cargaste en el módulo de Gastos)
        cursor.execute('''
            SELECT SUM(monto) FROM gastos_operativos 
            WHERE strftime('%Y-%m', fecha) = ?
        ''', (mes,))
        gastos = cursor.fetchone()[0] or 0.0

        # 4. MATEMÁTICA PURA DE NEGOCIOS
        ganancia_neta = ingresos - costos_mercaderia - gastos
        
        # Sacamos el porcentaje de rentabilidad
        margen_porcentaje = (ganancia_neta / ingresos * 100) if ingresos > 0 else 0

        conexion.close()

        return {
            "mes_analizado": mes,
            "resumen_financiero": {
                "1_ingresos_por_ventas": round(ingresos, 2),
                "2_costo_de_la_mercaderia": round(costos_mercaderia, 2),
                "3_gastos_del_local": round(gastos, 2),
                "4_GANANCIA_NETA_PURA": round(ganancia_neta, 2),
                "5_rentabilidad_del_mes": f"{round(margen_porcentaje, 2)}%"
            }
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
    
@router.post("/registrar_faltante")
def registrar_pedido_no_encontrado(p: ProductoFaltante):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    cursor.execute("INSERT INTO productos_solicitados_faltantes (descripcion_producto, cantidad_pedida, notas) VALUES (?, ?, ?)", 
                   (p.descripcion, p.cantidad, p.notas))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Anotado. Esto te va a ayudar a decidir la próxima compra a proveedores."}

# --- 2. RANKING DE PRODUCTOS (Top Ventas) ---
@router.get("/ranking_ventas")
def obtener_ranking_productos(periodo: str = "dia"): # dia, semana, mes
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # Definimos el filtro de fecha según el periodo
    if periodo == "dia":
        filtro = "date('now')"
    elif periodo == "semana":
        filtro = "date('now', '-7 days')"
    else:
        filtro = "date('now', '-30 days')"

    query = f'''
        SELECT p.nombre, SUM(vd.cantidad) as total_vendido, SUM(vd.subtotal) as recaudacion
        FROM ventas_detalle vd
        JOIN ventas_cabecera vc ON vd.venta_id = vc.id
        JOIN productos p ON vd.producto_id = p.id
        WHERE date(vc.fecha_hora) >= {filtro}
        GROUP BY p.id
        ORDER BY total_vendido DESC
        LIMIT 10
    '''
    cursor.execute(query)
    ranking = cursor.fetchall()
    conexion.close()
    return [dict(r) for r in ranking]

# --- 3. BAJA ROTACIÓN (Los "Clavos" que no se mueven) ---
@router.get("/baja_rotacion")
def productos_sin_salida():
    # Buscamos productos que tienen stock hace más de 30 días y no se vendieron
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    query = '''
        SELECT p.nombre, SUM(l.cantidad_disponible) as stock_estancado
        FROM productos p
        JOIN lotes_stock l ON p.id = l.producto_id
        LEFT JOIN ventas_detalle vd ON p.id = vd.producto_id
        WHERE l.cantidad_disponible > 0 
        AND vd.id IS NULL -- Nunca se vendieron (o no en el periodo registrado)
        GROUP BY p.id
    '''
    cursor.execute(query)
    estancados = cursor.fetchall()
    conexion.close()
    return [dict(e) for e in estancados]

# --- 4. VENTAS POR MÉTODO DE PAGO (¿Efectivo o Tarjeta?) ---
@router.get("/ventas_por_pago")
def ventas_por_metodo():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    query = '''
        SELECT metodo_pago, COUNT(id) as cantidad_transacciones, SUM(total_venta) as total_dinero
        FROM ventas_cabecera
        WHERE strftime('%Y-%m', fecha_hora) = strftime('%Y-%m', 'now')
        GROUP BY metodo_pago
    '''
    cursor.execute(query)
    metodos = cursor.fetchall()
    conexion.close()
    return [dict(m) for m in metodos]

class LanzarOferta(BaseModel):
    producto_id: int
    porcentaje_descuento: float # Ej: 20 para un 20% OFF
    motivo: str # "Vencimiento Cercano" o "Baja Rotación"

@router.post("/lanzar_oferta")
def crear_oferta_urgente(oferta: LanzarOferta):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    
    try:
        # A. Buscamos el precio actual
        cursor.execute("SELECT precio_venta_final, nombre FROM productos WHERE id = ?", (oferta.producto_id,))
        prod = cursor.fetchone()
        
        nuevo_precio = round(prod[0] * (1 - (oferta.porcentaje_descuento / 100)), 2)
        nuevo_nombre = f"OFERTA {prod[1]}"
        
        # B. Actualizamos el producto para que la caja lo cobre barato YA
        cursor.execute('''
            UPDATE productos 
            SET precio_venta_final = ?, 
                nombre = ? 
            WHERE id = ?
        ''', (nuevo_precio, nuevo_nombre, oferta.producto_id))
        
        # C. Lo mandamos a la COLA DE IMPRESIÓN (para el cartel de góndola)
        cursor.execute('''
            INSERT INTO cola_impresion_etiquetas (producto_id, tipo_cartel, cantidad_copias)
            VALUES (?, 'OFERTA_A4', 2)
        ''', (oferta.producto_id,))
        
        conexion.commit()
        conexion.close()
        return {"mensaje": f"¡Oferta lanzada! El {prod[1]} ahora cuesta ${nuevo_precio}. Imprimí los carteles ahora."}
        
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