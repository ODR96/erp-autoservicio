from fastapi import APIRouter, Depends # <-- Agregamos Depends
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone, timedelta # <-- Agregamos zona horaria
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol # <-- EL PATOVICA

# --- CORRECCIÓN HORARIA PARA ARGENTINA ---
ZONA_AR = timezone(timedelta(hours=-3))

# --- PARCHE DE MIGRACIÓN: AGREGAR DIRECCIÓN A CLIENTES ---
def actualizar_tabla_clientes():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        # Intentamos agregar la columna. Si ya existe, da error y pasa de largo.
        cursor.execute("ALTER TABLE clientes ADD COLUMN direccion TEXT DEFAULT ''")
        conexion.commit()
    except:
        pass
    finally:
        conexion.close()

actualizar_tabla_clientes()

router = APIRouter()

# --- 1. LOS GUARDIAS ---
class ItemPedido(BaseModel):
    producto_id: int
    cantidad: float
    precio_negociado: float = None

class NuevoDocumento(BaseModel):
    tipo_documento: str
    cliente_id: Optional[int] = None
    vendedor_id: Optional[int] = None
    observaciones: str = ""
    items: List[ItemPedido]

# --- 2. CREAR PRESUPUESTO O PEDIDO ---
@router.post("/crear", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_documento_mayorista(doc: NuevoDocumento):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        if doc.tipo_documento not in ["PRESUPUESTO", "PEDIDO"]:
            raise Exception("El tipo debe ser PRESUPUESTO o PEDIDO.")

        # CORRECCIÓN: HORA ARGENTINA
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        total_documento = 0.0
        estado_inicial = "PRESUPUESTO_ACTIVO" if doc.tipo_documento == "PRESUPUESTO" else "PENDIENTE_PAGO"
        
        cursor.execute('''
            INSERT INTO ventas_cabecera 
            (fecha_hora, cliente_id, tipo_comprobante, total_venta, estado)
            VALUES (?, ?, ?, 0, ?)
        ''', (fecha_actual, doc.cliente_id, doc.tipo_documento, estado_inicial))
        
        doc_id = cursor.lastrowid
        
        for item in doc.items:
            cursor.execute("SELECT nombre, precio_venta_final FROM productos WHERE id = ?", (item.producto_id,))
            prod_info = cursor.fetchone()
            
            if not prod_info:
                raise Exception(f"El producto ID {item.producto_id} no existe.")
                
            precio_final = item.precio_negociado if item.precio_negociado is not None else prod_info['precio_venta_final']
            subtotal_item = precio_final * item.cantidad
            total_documento += subtotal_item
            
            cursor.execute('''
                INSERT INTO ventas_detalle 
                (venta_id, producto_id, descripcion_historica, cantidad, precio_unitario_historico, subtotal)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (doc_id, item.producto_id, prod_info['nombre'], item.cantidad, precio_final, subtotal_item))
            
            if doc.tipo_documento == "PEDIDO":
                cursor.execute('''
                    UPDATE productos 
                    SET stock_comprometido = stock_comprometido + ? 
                    WHERE id = ?
                ''', (item.cantidad, item.producto_id))
                
        cursor.execute("UPDATE ventas_cabecera SET total_venta = ? WHERE id = ?", (total_documento, doc_id))
        
        conexion.commit()
        conexion.close()
        
        return {
            "mensaje": f"¡{doc.tipo_documento} registrado correctamente!",
            "numero_documento": doc_id,
            "total": total_documento,
            "estado": estado_inicial
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

# --- 3. COBRAR EL PEDIDO ---
class PagoPedido(BaseModel):
    metodo_pago: str 
    monto_entregado: float = 0.0

@router.put("/cobrar/{pedido_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def cobrar_pedido_mayorista(pedido_id: int, pago: PagoPedido):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        cursor.execute("SELECT estado, total_venta, cliente_id, tipo_comprobante FROM ventas_cabecera WHERE id = ?", (pedido_id,))
        pedido = cursor.fetchone()
        
        if not pedido:
            raise Exception("El documento no existe.")
        if pedido['tipo_comprobante'] == "PRESUPUESTO":
            raise Exception("No podés cobrar un Presupuesto. Tenés que convertirlo a Pedido primero.")
        if pedido['estado'] != 'PENDIENTE_PAGO':
            raise Exception(f"Este pedido ya está en estado {pedido['estado']}.")

        cursor.execute("UPDATE ventas_cabecera SET estado = 'PAGADO_PENDIENTE_ENTREGA', metodo_pago = ? WHERE id = ?", (pago.metodo_pago, pedido_id))
        
        if pago.metodo_pago.upper() in ["CUENTA CORRIENTE", "FIADO"]:
            cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor + ? WHERE id = ?", (pedido['total_venta'], pedido['cliente_id']))
        
        cursor.execute("SELECT descripcion_historica as nombre, cantidad, precio_unitario_historico as precio, subtotal FROM ventas_detalle WHERE venta_id = ?", (pedido_id,))
        detalle = cursor.fetchall()
        
        conexion.commit()
        conexion.close()
        
        vuelto = pago.monto_entregado - pedido['total_venta'] if pago.monto_entregado > pedido['total_venta'] and pago.metodo_pago.upper() not in ["CUENTA CORRIENTE", "FIADO"] else 0
        
        return {
            "mensaje": "¡Pedido Cobrado! Listo para imprimir remitos.",
            "vuelto_a_entregar": vuelto,
            "datos_impresion": {
                "numero_pedido": f"M-{pedido_id:06d}",
                "total": pedido['total_venta'],
                "metodo": pago.metodo_pago,
                "items": [dict(i) for i in detalle]
            }
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

# --- 4. ENTREGAR MERCADERÍA (Portón) ---
@router.put("/entregar/{pedido_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def despachar_pedido_mayorista(pedido_id: int):
    # (El código interno de esta función está perfecto, solo le agregamos el Depends arriba)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT estado, fecha_hora, nombre_cliente_factura FROM ventas_cabecera WHERE id = ?", (pedido_id,))
        pedido = cursor.fetchone()
        
        if not pedido or pedido['estado'] != 'PAGADO_PENDIENTE_ENTREGA':
            raise Exception("No se puede entregar. Verifique que el pedido exista y esté PAGADO.")
            
        cursor.execute("SELECT producto_id, cantidad, descripcion_historica FROM ventas_detalle WHERE venta_id = ?", (pedido_id,))
        items_a_entregar = cursor.fetchall()
        
        for item in items_a_entregar:
            cursor.execute("SELECT id, cantidad_disponible FROM lotes_stock WHERE producto_id = ? AND cantidad_disponible > 0 AND estado_lote = 'Activo' ORDER BY fecha_vencimiento ASC", (item['producto_id'],))
            lotes = cursor.fetchall()
            cantidad_por_descontar = item['cantidad']
            
            for lote in lotes:
                if cantidad_por_descontar <= 0: break
                descuento = min(lote['cantidad_disponible'], cantidad_por_descontar)
                cursor.execute("UPDATE lotes_stock SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?", (descuento, lote['id']))
                cursor.execute("INSERT INTO movimientos_stock (producto_id, lote_id, cantidad, tipo_movimiento, motivo) VALUES (?, ?, ?, 'REMITO_DEPOSITO', ?)", (item['producto_id'], lote['id'], descuento, f"Pedido #{pedido_id}"))
                cantidad_por_descontar -= descuento
                
            if cantidad_por_descontar > 0:
                raise Exception(f"Falta stock físico en el sistema de '{item['descripcion_historica']}' para poder entregar.")
                
            cursor.execute("UPDATE productos SET stock_comprometido = stock_comprometido - ? WHERE id = ?", (item['cantidad'], item['producto_id']))
                
        cursor.execute("UPDATE ventas_cabecera SET estado = 'ENTREGADA' WHERE id = ?", (pedido_id,))
        conexion.commit()
        conexion.close()
        return {"mensaje": "¡Mercadería entregada! Stock físico descontado y reservas liberadas."}
    except Exception as e:
        if conexion:
            conexion.rollback()
            conexion.close()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}

# --- 5. OBTENER DOCUMENTO PARA IMPRESIÓN ---
@router.get("/documento/{doc_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def obtener_documento_impresion(doc_id: int):
    # (Solo se inyectó el Depends, tu código queda igual)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT v.*, c.nombre_completo, c.cuit, c.direccion 
            FROM ventas_cabecera v
            LEFT JOIN clientes c ON v.cliente_id = c.id
            WHERE v.id = ?
        ''', (doc_id,))
        cabecera = cursor.fetchone()
        if not cabecera:
            return {"error": "El documento no existe."}
        cursor.execute("SELECT descripcion_historica as nombre, cantidad, precio_unitario_historico as precio, subtotal FROM ventas_detalle WHERE venta_id = ?", (doc_id,))
        detalle = cursor.fetchall()
        return {"cabecera": dict(cabecera), "detalle": [dict(i) for i in detalle]}
    finally:
        conexion.close()
        
# --- LISTAR TODOS LOS PEDIDOS Y PRESUPUESTOS ---
@router.get("/listar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_documentos_deposito():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # CORRECCIÓN DE HORA: Usamos Python para calcular el límite, no a SQLite
        fecha_limite = (datetime.now(ZONA_AR) - timedelta(hours=48)).strftime("%Y-%m-%d %H:%M:%S")
        
        cursor.execute('''
            UPDATE ventas_cabecera 
            SET estado = 'VENCIDO' 
            WHERE tipo_comprobante = 'PRESUPUESTO' 
            AND estado = 'PRESUPUESTO_ACTIVO' 
            AND fecha_hora <= ?
        ''', (fecha_limite,))
        conexion.commit()
        
        cursor.execute('''
            SELECT v.id, v.fecha_hora, v.tipo_comprobante, v.estado, v.total_venta, 
                   IFNULL(c.nombre_completo, 'Consumidor Final') as cliente
            FROM ventas_cabecera v
            LEFT JOIN clientes c ON v.cliente_id = c.id
            WHERE v.tipo_comprobante IN ('PRESUPUESTO', 'PEDIDO')
            ORDER BY v.fecha_hora DESC
            LIMIT 100
        ''')
        return {"documentos": [dict(d) for d in cursor.fetchall()]}
    finally:
        conexion.close()
        
# --- 6. CONSULTAR PEDIDO PENDIENTE (Para el Mostrador POS) ---
@router.get("/pendiente/{doc_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def obtener_pedido_pendiente(doc_id: int):
    # (Solo inyectamos el Depends)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT v.id, v.total_venta, v.estado, IFNULL(c.nombre_completo, 'Consumidor Final') as cliente
            FROM ventas_cabecera v
            LEFT JOIN clientes c ON v.cliente_id = c.id
            WHERE v.id = ? AND v.tipo_comprobante = 'PEDIDO'
        ''', (doc_id,))
        pedido = cursor.fetchone()
        if not pedido: return {"error": "El pedido no existe o es un Presupuesto."}
        if pedido['estado'] != 'PENDIENTE_PAGO': return {"error": f"Operación denegada. El pedido se encuentra en estado: {pedido['estado']}."}
        return dict(pedido)
    finally:
        conexion.close()
        
# --- 7. CONVERTIR PRESUPUESTO A PEDIDO ---
@router.post("/convertir_presupuesto/{doc_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def convertir_presupuesto_a_pedido(doc_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            UPDATE ventas_cabecera 
            SET tipo_comprobante = 'PEDIDO', estado = 'PENDIENTE_PAGO' 
            WHERE id = ? AND tipo_comprobante = 'PRESUPUESTO'
        ''', (doc_id,))
        if cursor.rowcount == 0:
            return {"error": "No se pudo convertir. Verifique que sea un Presupuesto válido."}
        conexion.commit()
        return {"mensaje": "¡Convertido con éxito! El cliente ya puede pasar por caja a pagar."}
    finally:
        conexion.close()