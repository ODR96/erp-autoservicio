from fastapi import APIRouter, Query, Depends
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone, timedelta
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

def asegurar_columnas_multi_caja():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try: cursor.execute("ALTER TABLE ventas_cabecera ADD COLUMN turno_id INTEGER DEFAULT 0")
    except: pass
    try: cursor.execute("ALTER TABLE movimientos_caja ADD COLUMN turno_id INTEGER DEFAULT 0")
    except: pass
    conexion.commit()
    conexion.close()

asegurar_columnas_multi_caja()

@router.get("/por_fecha", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_ventas_por_fecha(fecha: str = Query(..., description="Formato YYYY-MM-DD")):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("""
            SELECT * FROM ventas_cabecera 
            WHERE DATE(fecha_hora) = ?
            ORDER BY fecha_hora DESC
        """, (fecha,))
        ventas = []
        for row in cursor.fetchall():
            d = dict(row)
            d["cliente"] = d.get("nombre_cliente_factura", "Consumidor Final")
            d["cajero_nombre"] = d.get("cajero_nombre", "-")
            ventas.append(d)
        return {"ventas": ventas}
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

class ItemVenta(BaseModel):
    producto_id: int
    cantidad: float
    precio_unitario: float
    nombre_fantasma: Optional[str] = None

class PagoMixto(BaseModel):
    metodo: str
    monto: float

class NuevaVenta(BaseModel):
    metodo_pago: str  
    monto_entregado: float = 0.0
    cliente_id: Optional[int] = None
    tipo_comprobante: str = "TICKET NO FISCAL"
    nombre_cliente_factura: str = "Consumidor Final"
    documento_cliente: str = ""
    condicion_iva_cliente: str = "Consumidor Final"
    descuento_recargo_global: float = 0.0
    autorizado_por: Optional[str] = None
    facturar_afip: bool = False
    items: List[ItemVenta]
    pagos_mixtos: Optional[List[PagoMixto]] = None
    cajero_nombre: str = "Sistema"
    turno_id: int

@router.post("/cobrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_venta(venta: NuevaVenta):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row 
    cursor = conexion.cursor()
    try:
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")        
        total_venta = 0.0
        ahorro_por_promos = 0.0
        
        cursor.execute('''
            INSERT INTO ventas_cabecera 
            (fecha_hora, cliente_id, tipo_comprobante, nombre_cliente_factura, documento_cliente, 
             condicion_iva_cliente, total_venta, metodo_pago, descuento_recargo_global, estado, turno_id)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'COMPLETADA', ?)
        ''', (fecha_actual, venta.cliente_id, venta.tipo_comprobante, venta.nombre_cliente_factura, 
              venta.documento_cliente, venta.condicion_iva_cliente, venta.metodo_pago, venta.descuento_recargo_global, venta.turno_id))
        
        venta_id = cursor.lastrowid
        
        for item in venta.items:
            cursor.execute("SELECT precio_venta_final, nombre FROM productos WHERE id = ?", (item.producto_id,))
            prod_info = cursor.fetchone()
            if not prod_info:
                subtotal_item = item.precio_unitario * item.cantidad
                total_venta += subtotal_item
                nombre_mostrar = item.nombre_fantasma if item.nombre_fantasma else "Artículo Varios"
                cursor.execute('''
                    INSERT INTO ventas_detalle 
                    (venta_id, producto_id, descripcion_historica, cantidad, precio_unitario_historico, subtotal)
                    VALUES (?, 0, ?, ?, ?, ?)
                ''', (venta_id, nombre_mostrar, item.cantidad, item.precio_unitario, subtotal_item))
                continue
                
            precio_standard = prod_info['precio_venta_final']
            ahorro_esta_linea = (precio_standard - item.precio_unitario) * item.cantidad
            if ahorro_esta_linea > 0: ahorro_por_promos += ahorro_esta_linea
            subtotal_item = item.precio_unitario * item.cantidad
            total_venta += subtotal_item
            
            cursor.execute('''
                INSERT INTO ventas_detalle 
                (venta_id, producto_id, descripcion_historica, cantidad, precio_unitario_historico, subtotal)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (venta_id, item.producto_id, prod_info['nombre'], item.cantidad, item.precio_unitario, subtotal_item))
            
            cursor.execute("SELECT producto_hijo_id, cantidad_hijo FROM productos_combos WHERE producto_padre_id = ?", (item.producto_id,))
            componentes = cursor.fetchall()
            
            items_a_descontar = []
            if componentes:
                for comp in componentes: items_a_descontar.append({"id": comp['producto_hijo_id'], "cant": item.cantidad * comp['cantidad_hijo']})
            else:
                items_a_descontar.append({"id": item.producto_id, "cant": item.cantidad})
                
            for desc in items_a_descontar:
                producto_desc_id = desc["id"]
                cantidad_por_descontar = desc["cant"]
                
                cursor.execute("SELECT id, cantidad_disponible FROM lotes_stock WHERE producto_id = ? AND cantidad_disponible > 0 AND estado_lote = 'Activo' ORDER BY fecha_vencimiento ASC", (producto_desc_id,))
                lotes = cursor.fetchall()
                for lote in lotes:
                    if cantidad_por_descontar <= 0: break
                    descuento = min(lote['cantidad_disponible'], cantidad_por_descontar)
                    cursor.execute("UPDATE lotes_stock SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?", (descuento, lote['id']))
                    cursor.execute("INSERT INTO movimientos_stock (producto_id, lote_id, cantidad, tipo_movimiento, motivo) VALUES (?, ?, ?, 'VENTA_AUTOMATICA', ?)", (producto_desc_id, lote['id'], descuento, f"Ticket #{venta_id} ({venta.cajero_nombre})"))
                    cantidad_por_descontar -= descuento
                    
                if cantidad_por_descontar > 0:
                    cursor.execute('''
                        INSERT INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote) 
                        VALUES (?, 'VENTA_SIN_STOCK', ?, '2099-12-31', 0, ?, ?, 'Activo')
                    ''', (producto_desc_id, fecha_actual[:10], -cantidad_por_descontar, precio_standard))
                    nuevo_lote_negativo = cursor.lastrowid
                    cursor.execute("INSERT INTO movimientos_stock (producto_id, lote_id, cantidad, tipo_movimiento, motivo) VALUES (?, ?, ?, 'VENTA_FALTANTE_STOCK', ?)", (producto_desc_id, nuevo_lote_negativo, cantidad_por_descontar, f"Ticket #{venta_id} ({venta.cajero_nombre})"))
        
        total_con_descuento = total_venta + venta.descuento_recargo_global
        
        if venta.metodo_pago.upper() in ["CUENTA CORRIENTE", "FIADO"]:
            if not venta.cliente_id: raise Exception("Para vender fiado, seleccione un cliente.")
            cursor.execute("SELECT saldo_actual_deudor, limite_credito, nombre_completo FROM clientes WHERE id = ?", (venta.cliente_id,))
            cliente = cursor.fetchone()
            nuevo_saldo = cliente['saldo_actual_deudor'] + total_con_descuento
            
            if nuevo_saldo > cliente['limite_credito']:
                if not venta.autorizado_por: 
                    raise Exception(f"ALERTA: El cliente {cliente['nombre_completo']} excede su límite. PASE CREDENCIAL.")
                cursor.execute("SELECT id FROM usuarios WHERE nombre_completo = ?", (venta.autorizado_por,))
                supervisor = cursor.fetchone()
                sup_id = supervisor['id'] if supervisor else 1
                cursor.execute("UPDATE ventas_cabecera SET autorizado_por = ? WHERE id = ?", (sup_id, venta_id))
            
            cursor.execute("UPDATE clientes SET saldo_actual_deudor = ? WHERE id = ?", (nuevo_saldo, venta.cliente_id))
            cursor.execute('''
                INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
                VALUES (?, ?, 'CARGO', ?, ?, ?)
            ''', (venta.cliente_id, fecha_actual, total_con_descuento, f"Ticket POS #{venta_id}", 1))

        if venta.metodo_pago == "MIXTO" and venta.pagos_mixtos:
            cursor.execute('''CREATE TABLE IF NOT EXISTS ventas_pagos_mixtos (
                id INTEGER PRIMARY KEY AUTOINCREMENT, venta_id INTEGER, metodo_pago TEXT, monto REAL
            )''')
            for p in venta.pagos_mixtos:
                cursor.execute("INSERT INTO ventas_pagos_mixtos (venta_id, metodo_pago, monto) VALUES (?, ?, ?)", (venta_id, p.metodo, p.monto))
                if p.metodo == "EFECTIVO":
                    # EL ARREGLO: Inyectamos explícitamente el turno_id de la venta
                    cursor.execute('''
                        INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
                        VALUES (?, ?, 'INGRESO', ?, ?, ?)
                    ''', (fecha_actual, 1, p.monto, f"Efectivo de Ticket #{venta_id} (Mixto)", venta.turno_id))

        ahorro_manual = abs(venta.descuento_recargo_global) if venta.descuento_recargo_global < 0 else 0
        cursor.execute("UPDATE ventas_cabecera SET total_venta = ? WHERE id = ?", (total_con_descuento, venta_id))
        vuelto_cliente = venta.monto_entregado - total_con_descuento if venta.monto_entregado > total_con_descuento and venta.metodo_pago.upper() not in ["CUENTA CORRIENTE", "FIADO", "MIXTO"] else 0
        
        cae_afip = None
        if venta.facturar_afip:
            cae_afip = "SIMULADO-736482649274"
            cursor.execute("UPDATE ventas_cabecera SET tipo_comprobante = 'FACTURA B', estado = 'FACTURADO_AFIP' WHERE id = ?", (venta_id,))

        conexion.commit()
        return {
            "mensaje": "¡Venta registrada con éxito!",
            "numero_ticket": venta_id,
            "total_cobrado": total_con_descuento,
            "vuelto": vuelto_cliente,
            "ahorro_total": ahorro_manual + ahorro_por_promos,
            "cae_afip": cae_afip
        }
    except Exception as e:
        if conexion: conexion.rollback()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

@router.get("/ticket/{venta_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def generar_ticket(venta_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM ventas_cabecera WHERE id = ?", (venta_id,))
        venta = cursor.fetchone()
        if not venta: return {"error": "Ese número de ticket no existe"}
            
        cursor.execute('''
            SELECT vd.descripcion_historica as nombre, vd.cantidad, vd.precio_unitario_historico as precio_unitario, vd.subtotal, p.unidad_medida 
            FROM ventas_detalle vd
            LEFT JOIN productos p ON vd.producto_id = p.id
            WHERE vd.venta_id = ?
        ''', (venta_id,))
        detalle = cursor.fetchall()

        desglose_mixto = []
        if venta['metodo_pago'] == 'MIXTO':
            try:
                cursor.execute("SELECT metodo_pago, monto FROM ventas_pagos_mixtos WHERE venta_id = ?", (venta_id,))
                desglose_mixto = [dict(row) for row in cursor.fetchall()]
            except: pass
        
        return {
            "encabezado": {
                "comercio": "Autoservicio 20 de Junio",
                "direccion": "El Colorado, Formosa",
                "tipo_comprobante": venta['tipo_comprobante'],
                "cliente": venta['nombre_cliente_factura'],
                "fecha": venta['fecha_hora'],
                "numero_ticket": f"0001-{venta['id']:08d}"
            },
            "detalle_compra": [dict(item) for item in detalle],
            "totales": {
                "subtotal_articulos": venta['total_venta'] - venta['descuento_recargo_global'],
                "descuentos_o_recargos": venta['descuento_recargo_global'],
                "total_a_pagar": venta['total_venta'],
                "metodo_pago": venta['metodo_pago'],
                "desglose_mixto": desglose_mixto
            }
        }
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()
    
@router.get("/historial/{turno_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def historial_ventas_turno(turno_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT fecha_hora_apertura FROM turnos_caja WHERE id = ?", (turno_id,))
        turno = cursor.fetchone()
        if not turno: raise Exception("El turno no existe.")
        cursor.execute('''
            SELECT id, id AS numero_ticket, fecha_hora, total_venta, metodo_pago, estado 
            FROM ventas_cabecera WHERE turno_id = ? ORDER BY id DESC
        ''', (turno_id,))
        return {"ventas": [dict(row) for row in cursor.fetchall()]}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()

class AnularVentaRequest(BaseModel):
    usuario_id: int
    turno_id: int

@router.put("/anular/{venta_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def anular_venta(venta_id: int, peticion: AnularVentaRequest):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT estado, id, metodo_pago, total_venta, cliente_id FROM ventas_cabecera WHERE id = ?", (venta_id,))
        venta = cursor.fetchone()

        if not venta: raise Exception("La venta no existe.")
        if venta[0] == 'ANULADA': raise Exception("Esta venta ya está anulada.")

        cursor.execute("SELECT lote_id, cantidad, producto_id FROM movimientos_stock WHERE motivo LIKE ?", (f"Ticket #{venta_id}%",))
        movimientos_afectados = cursor.fetchall()

        for mov in movimientos_afectados:
            lote_id, cantidad, producto_id = mov
            cursor.execute("UPDATE lotes_stock SET cantidad_disponible = cantidad_disponible + ? WHERE id = ?", (cantidad, lote_id))
            cursor.execute('''
                INSERT INTO movimientos_stock (producto_id, lote_id, tipo_movimiento, cantidad, motivo)
                VALUES (?, ?, 'ANULACION', ?, ?)
            ''', (producto_id, lote_id, cantidad, f"Anulación Ticket #{venta_id}"))

        metodo_pago = venta[2].upper()
        total_venta = venta[3]
        cliente_id = venta[4]
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

        if metodo_pago in ['FIADO', 'CUENTA CORRIENTE'] and cliente_id:
            cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor - ? WHERE id = ?", (total_venta, cliente_id))
            cursor.execute('''
                INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
                VALUES (?, ?, 'PAGO_ANULACION', ?, ?, ?)
            ''', (cliente_id, fecha_actual, total_venta, f"Anulación Ticket #{venta_id}", peticion.usuario_id))

        # EL ARREGLO: Las anulaciones ahora sí declaran a qué turno y caja están afectando
        elif metodo_pago == 'EFECTIVO':
            cursor.execute('''
                INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id) 
                VALUES (?, ?, 'RETIRO', ?, ?, ?)
            ''', (fecha_actual, peticion.usuario_id, total_venta, f"Anulación Efectivo Ticket #{venta_id}", peticion.turno_id))

        elif metodo_pago == 'MIXTO':
            try:
                cursor.execute("SELECT monto FROM ventas_pagos_mixtos WHERE venta_id = ? AND metodo_pago = 'EFECTIVO'", (venta_id,))
                efvo = cursor.fetchone()
                if efvo and efvo[0] > 0:
                    cursor.execute('''
                        INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id) 
                        VALUES (?, ?, 'RETIRO', ?, ?, ?)
                    ''', (fecha_actual, peticion.usuario_id, efvo[0], f"Anulación Efectivo Mixto #{venta_id}", peticion.turno_id))
            except: pass

        cursor.execute("UPDATE ventas_cabecera SET estado = 'ANULADA' WHERE id = ?", (venta_id,))
        conexion.commit()
        return {"mensaje": "Venta anulada, stock devuelto y caja actualizada."}
    except Exception as e:
        if conexion: conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()