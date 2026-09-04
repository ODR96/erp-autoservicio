from fastapi import APIRouter, Query
from pydantic import BaseModel
from datetime import datetime, timedelta, timezone
import sqlite3
from backend.database import obtener_conexion
from fastapi import Depends
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()

ZONA_AR = timezone(timedelta(hours=-3))

# 1. ACTUALIZAMOS EL MODELO PARA SABER QUIÉN PIDE
class ProductoFaltante(BaseModel):
    descripcion: str
    cantidad: float = 1.0
    notas: str = ""
    usuario_nombre: str = "Desconocido" # <-- NUEVO: Atrapamos al responsable

# --- 1. ALERTAS DEL DASHBOARD (Para ver a la mañana) ---
@router.get("/alertas", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_alertas_dashboard():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # EL ARREGLO: Agregamos p.proveedor_habitual_id a la consulta SELECT
        cursor.execute('''
            SELECT p.nombre, p.stock_minimo_alerta, p.proveedor_habitual_id,
                   IFNULL((SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = p.id AND estado_lote = 'Activo'), 0) as stock_actual
            FROM productos p
            WHERE stock_actual <= p.stock_minimo_alerta 
            AND p.activo = 1
            AND p.id NOT IN (SELECT producto_padre_id FROM productos_combos)
        ''')
        alertas_stock = [dict(row) for row in cursor.fetchall()]

        # EL ARREGLO: Agregamos p.id as producto_id
        cursor.execute('''
            SELECT p.id as producto_id, p.nombre, l.numero_lote_proveedor, l.fecha_vencimiento, l.cantidad_disponible 
            FROM lotes_stock l
            JOIN productos p ON l.producto_id = p.id
            WHERE l.cantidad_disponible > 0 
            AND l.estado_lote = 'Activo' 
            AND l.fecha_vencimiento <= date('now', '+' || IFNULL(p.dias_alerta_vencimiento, 30) || ' days')
            AND p.id NOT IN (SELECT producto_padre_id FROM productos_combos)
            ORDER BY l.fecha_vencimiento ASC
        ''')
        alertas_vencimiento = [dict(row) for row in cursor.fetchall()]
        return {"alertas_stock_critico": alertas_stock, "alertas_vencimientos": alertas_vencimiento}
    finally:
        conexion.close()


# --- 2. LA VERDAD DE LA MILANESA: GANANCIA NETA REAL ---
@router.get("/ganancia_neta", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def calcular_ganancia_neta(mes: str = None):
    # Si no le mandamos mes, analiza el mes actual en curso
    if not mes:
        mes = datetime.now().strftime("%Y-%m")

    conexion = obtener_conexion()
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
    
@router.post("/registrar_faltante", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_pedido_no_encontrado(p: ProductoFaltante):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    # 2. CREAMOS LA COLUMNA SI NO EXISTE (Migración automática silenciosa)
    try:
        cursor.execute("ALTER TABLE productos_solicitados_faltantes ADD COLUMN usuario_anoto TEXT DEFAULT 'Desconocido'")
    except:
        pass # Si ya existe la columna, ignora el error

    # 3. GUARDAMOS CON EL DATO DEL EMPLEADO
    cursor.execute('''
        INSERT INTO productos_solicitados_faltantes (descripcion_producto, cantidad_pedida, notas, usuario_anoto) 
        VALUES (?, ?, ?, ?)
    ''', (p.descripcion, p.cantidad, p.notas, p.usuario_nombre))
    
    conexion.commit()
    conexion.close()
    return {"mensaje": "Anotado."}

@router.get("/faltantes_pendientes", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_faltantes_pendientes():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # Ahora traemos también quién lo anotó
        cursor.execute("SELECT rowid, descripcion_producto, cantidad_pedida, notas, usuario_anoto FROM productos_solicitados_faltantes ORDER BY rowid DESC")
        faltantes = [dict(row) for row in cursor.fetchall()]
        return {"faltantes": faltantes}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()

@router.delete("/resolver_faltante/{faltante_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def borrar_faltante_resuelto(faltante_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("DELETE FROM productos_solicitados_faltantes WHERE rowid = ?", (faltante_id,))
        conexion.commit()
        return {"mensaje": "Resuelto"}
    finally:
        conexion.close()

# --- 2. RANKING DE PRODUCTOS (Top Ventas) ---
@router.get("/ranking_ventas", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_ranking_productos(periodo: str = "dia"): # dia, semana, mes
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # Definimos el filtro de fecha según el periodo
    if periodo == "dia":
        filtro = "date(vc.fecha_hora) = date('now')"
    elif periodo == "semana":
        filtro = "date(vc.fecha_hora) >= date('now', '-7 days')"
    else:
        # Filtra exactamente por el mes en curso (Ej: Todo septiembre)
        filtro = "strftime('%Y-%m', vc.fecha_hora) = strftime('%Y-%m', 'now')"

    query = f'''
        SELECT p.nombre, SUM(vd.cantidad) as total_vendido, SUM(vd.subtotal) as recaudacion
        FROM ventas_detalle vd
        JOIN ventas_cabecera vc ON vd.venta_id = vc.id
        JOIN productos p ON vd.producto_id = p.id
        WHERE {filtro}
        GROUP BY p.id
        ORDER BY total_vendido DESC
        LIMIT 10
    '''
    cursor.execute(query)
    ranking = cursor.fetchall()
    conexion.close()
    return [dict(r) for r in ranking]

# --- 3. BAJA ROTACIÓN (Los "Clavos" que no se mueven) ---
@router.get("/baja_rotacion", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def productos_sin_salida():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # EL ARREGLO: Calcula dias_clavado y filtra los ingresados hoy
        query = '''
            SELECT p.id as producto_id, p.nombre, 
                   SUM(l.cantidad_disponible) as stock_estancado,
                   CAST(julianday('now') - julianday(MIN(l.fecha_ingreso)) AS INTEGER) as dias_clavado
            FROM productos p
            JOIN lotes_stock l ON p.id = l.producto_id
            WHERE l.cantidad_disponible > 0 AND l.estado_lote = 'Activo'
            AND l.fecha_ingreso <= date('now', '-30 days')
            AND p.id NOT IN (
                SELECT vd.producto_id
                FROM ventas_detalle vd
                JOIN ventas_cabecera vc ON vd.venta_id = vc.id
                WHERE date(vc.fecha_hora) >= date('now', '-30 days')
            )
            GROUP BY p.id
        '''
        cursor.execute(query)
        estancados = [dict(e) for e in cursor.fetchall()]
        return estancados
    finally:
        conexion.close()

@router.get("/ventas_por_pago", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ventas_por_metodo():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        query = '''
            WITH VentasPuras AS (
                -- 1. Ventas puras (Toman el nombre tal cual viene de la caja principal)
                SELECT metodo_pago, COUNT(id) as cantidad_transacciones, SUM(total_venta) as total_dinero
                FROM ventas_cabecera
                WHERE strftime('%Y-%m', fecha_hora) = strftime('%Y-%m', 'now')
                AND metodo_pago != 'MIXTO'
                AND estado != 'ANULADA'
                GROUP BY metodo_pago
            ),
            VentasMixtas AS (
                -- 2. Ventas Mixtas (TRADUCIMOS los nombres internos para que coincidan con los puros)
                SELECT 
                    CASE 
                        WHEN UPPER(vm.metodo_pago) = 'TARJETA' THEN 'Tarjeta / POS'
                        WHEN UPPER(vm.metodo_pago) = 'TRANSFERENCIA' THEN 'Billetera Virtual / QR'
                        WHEN UPPER(vm.metodo_pago) = 'EFECTIVO' THEN 'EFECTIVO'
                        ELSE vm.metodo_pago 
                    END as metodo_pago_traducido, 
                    COUNT(DISTINCT vc.id) as cantidad_transacciones, 
                    SUM(vm.monto) as total_dinero
                FROM ventas_pagos_mixtos vm
                JOIN ventas_cabecera vc ON vm.venta_id = vc.id
                WHERE strftime('%Y-%m', vc.fecha_hora) = strftime('%Y-%m', 'now')
                AND vc.estado != 'ANULADA'
                GROUP BY metodo_pago_traducido
            )
            -- 3. Unimos y sumamos todo bajo los nombres ya unificados
            SELECT 
                metodo_pago_traducido as metodo_pago, 
                SUM(cantidad_transacciones) as cantidad_transacciones, 
                SUM(total_dinero) as total_dinero
            FROM (
                SELECT metodo_pago as metodo_pago_traducido, cantidad_transacciones, total_dinero FROM VentasPuras
                UNION ALL
                SELECT metodo_pago_traducido, cantidad_transacciones, total_dinero FROM VentasMixtas
            )
            GROUP BY metodo_pago_traducido
            ORDER BY total_dinero DESC
        '''
        cursor.execute(query)
        metodos = [dict(row) for row in cursor.fetchall()]
        return metodos
    except Exception as e:
        print(f"🚨 Error en ventas_por_pago: {e}")
        return {"error": str(e)}
    finally:
        conexion.close()

class LanzarOferta(BaseModel):
    producto_id: int
    porcentaje_descuento: float # Ej: 20 para un 20% OFF
    motivo: str # "Vencimiento Cercano" o "Baja Rotación"

@router.post("/lanzar_oferta", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def crear_oferta_urgente(oferta: LanzarOferta):
    conexion = obtener_conexion()
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
        
        
@router.get("/detalle_ventas_hora", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def detalle_ventas_por_hora(hora: str):
    # MAGIA: .zfill(2) transforma un "8" en "08", o deja el "11" como "11"
    hora_corta = hora.split(":")[0].zfill(2)
    
    # Buscamos el día exacto en Argentina
    fecha_hoy = datetime.now(ZONA_AR).strftime("%Y-%m-%d")
    
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # Buscamos los tickets cruzando exactamente fecha y hora formadas
        query = '''
            SELECT id, numero_ticket, metodo_pago, total_venta, cajero_nombre
            FROM ventas_cabecera
            WHERE date(fecha_hora) = ?
            AND strftime('%H', fecha_hora) = ?
            AND estado != 'ANULADA'
            ORDER BY fecha_hora DESC
        '''
        cursor.execute(query, (fecha_hoy, hora_corta))
        tickets = [dict(row) for row in cursor.fetchall()]
        
        return {"hora": hora, "tickets": tickets}
    except Exception as e:
        print(f"🚨 Error en detalle_hora: {e}")
        return {"error": str(e)}
    finally:
        conexion.close()