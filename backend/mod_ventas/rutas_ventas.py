from fastapi import APIRouter, Query
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone, timedelta
import sqlite3

router = APIRouter()

@router.get("/por_fecha")
def obtener_ventas_por_fecha(fecha: str = Query(..., description="Formato YYYY-MM-DD")):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        # Apuntamos a tu tabla real: ventas_cabecera
        cursor.execute("""
            SELECT * FROM ventas_cabecera 
            WHERE DATE(fecha_hora) = ?
            ORDER BY fecha_hora DESC
        """, (fecha,))
        
        ventas = []
        for row in cursor.fetchall():
            d = dict(row)
            # Emparejamos los nombres que saca la base de datos con los que espera el JS
            d["cliente"] = d.get("nombre_cliente_factura", "Consumidor Final")
            d["cajero_nombre"] = d.get("cajero_nombre", "-")
            ventas.append(d)
            
        return {"ventas": ventas}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()

# --- CONFIGURACIÓN DE HORA ARGENTINA ---
ZONA_AR = timezone(timedelta(hours=-3))

# --- 1. LOS GUARDIAS ---
class ItemVenta(BaseModel):
    producto_id: int
    cantidad: float
    precio_unitario: float

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
    autorizado_por: Optional[str] = None # <-- EL ARREGLO: Ahora espera el NOMBRE del autorizante
    facturar_afip: bool = False
    items: List[ItemVenta]
    pagos_mixtos: Optional[List[PagoMixto]] = None
    cajero_nombre: str = "Sistema"

# --- 2. EL MOTOR DE COBRO ---
@router.post("/cobrar")
def registrar_venta(venta: NuevaVenta):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row 
    cursor = conexion.cursor()
    
    try:
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")        
        total_venta = 0.0
        ahorro_por_promos = 0.0
        
        # A. Guardamos Cabecera
        cursor.execute('''
            INSERT INTO ventas_cabecera 
            (fecha_hora, cliente_id, tipo_comprobante, nombre_cliente_factura, documento_cliente, 
             condicion_iva_cliente, total_venta, metodo_pago, descuento_recargo_global, estado)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'COMPLETADA')
        ''', (fecha_actual, venta.cliente_id, venta.tipo_comprobante, venta.nombre_cliente_factura, 
              venta.documento_cliente, venta.condicion_iva_cliente, venta.metodo_pago, venta.descuento_recargo_global))
        
        venta_id = cursor.lastrowid
        
        # B. Procesamos Detalle, Ahorro y FIFO
        for item in venta.items:
            cursor.execute("SELECT precio_venta_final, nombre FROM productos WHERE id = ?", (item.producto_id,))
            prod_info = cursor.fetchone()
            if not prod_info:
                raise Exception(f"El producto ID {item.producto_id} no existe.")
                
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
            
            # --- LÓGICA DE STOCK ---
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
                    fecha_hoy_corta = fecha_actual[:10]
                    cursor.execute('''
                        INSERT INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote) 
                        VALUES (?, 'VENTA_SIN_STOCK', ?, '2099-12-31', 0, ?, ?, 'Activo')
                    ''', (producto_desc_id, fecha_hoy_corta, -cantidad_por_descontar, precio_standard))
                    nuevo_lote_negativo = cursor.lastrowid
                    cursor.execute("INSERT INTO movimientos_stock (producto_id, lote_id, cantidad, tipo_movimiento, motivo) VALUES (?, ?, ?, 'VENTA_FALTANTE_STOCK', ?)", (producto_desc_id, nuevo_lote_negativo, cantidad_por_descontar, f"Ticket #{venta_id} ({venta.cajero_nombre})"))
        total_con_descuento = total_venta + venta.descuento_recargo_global
        
        # C. EL CANDADO PARA LOS FIADOS
# C. EL CANDADO PARA LOS FIADOS
        if venta.metodo_pago.upper() in ["CUENTA CORRIENTE", "FIADO"]:
            if not venta.cliente_id: raise Exception("Para vender fiado, seleccione un cliente.")
                
            cursor.execute("SELECT saldo_actual_deudor, limite_credito, nombre_completo FROM clientes WHERE id = ?", (venta.cliente_id,))
            cliente = cursor.fetchone()
            nuevo_saldo = cliente['saldo_actual_deudor'] + total_con_descuento
            
            if nuevo_saldo > cliente['limite_credito']:
                # Leemos la firma que mandó Javascript
                if not venta.autorizado_por: 
                    raise Exception(f"ALERTA: El cliente {cliente['nombre_completo']} excede su límite. PASE CREDENCIAL.")
                
                # Buscamos quién fue el gerente que autorizó para dejarlo asentado
                cursor.execute("SELECT id FROM usuarios WHERE nombre_completo = ?", (venta.autorizado_por,))
                supervisor = cursor.fetchone()
                sup_id = supervisor['id'] if supervisor else 1
                cursor.execute("UPDATE ventas_cabecera SET autorizado_por = ? WHERE id = ?", (sup_id, venta_id))
            
            cursor.execute("UPDATE clientes SET saldo_actual_deudor = ? WHERE id = ?", (nuevo_saldo, venta.cliente_id))
            
            cursor.execute('''CREATE TABLE IF NOT EXISTS movimientos_clientes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER, fecha_hora DATETIME, 
                tipo_movimiento TEXT, monto REAL, detalle TEXT, usuario_id INTEGER)''')
            cursor.execute('''
                INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
                VALUES (?, ?, 'CARGO', ?, ?, ?)
            ''', (venta.cliente_id, fecha_actual, total_con_descuento, f"Ticket POS #{venta_id}", 1))

        # D. LA MAGIA DEL PAGO MIXTO
        if venta.metodo_pago == "MIXTO" and venta.pagos_mixtos:
            cursor.execute('''CREATE TABLE IF NOT EXISTS ventas_pagos_mixtos (
                id INTEGER PRIMARY KEY AUTOINCREMENT, venta_id INTEGER, metodo_pago TEXT, monto REAL
            )''')
            for p in venta.pagos_mixtos:
                cursor.execute("INSERT INTO ventas_pagos_mixtos (venta_id, metodo_pago, monto) VALUES (?, ?, ?)", (venta_id, p.metodo, p.monto))
                
                # El truco: Solo ingresamos a la caja fuerte (los billetes) la parte que es efectivo.
                if p.metodo == "EFECTIVO":
                    cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'")
                    turno = cursor.fetchone()
                    if turno:
                        cursor.execute('''
                            INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones)
                            VALUES (?, ?, 'INGRESO', ?, ?)
                        ''', (fecha_actual, 1, p.monto, f"Efectivo de Ticket #{venta_id} (Mixto)"))

        # E. CÁLCULO FINAL DE AHORRO Y CABECERA
        ahorro_manual = abs(venta.descuento_recargo_global) if venta.descuento_recargo_global < 0 else 0
        ahorro_final_para_ticket = ahorro_manual + ahorro_por_promos

        cursor.execute("UPDATE ventas_cabecera SET total_venta = ? WHERE id = ?", (total_con_descuento, venta_id))
        vuelto_cliente = venta.monto_entregado - total_con_descuento if venta.monto_entregado > total_con_descuento and venta.metodo_pago.upper() not in ["CUENTA CORRIENTE", "FIADO", "MIXTO"] else 0
        
        cae_afip = None
        if venta.facturar_afip:
            cae_afip = "SIMULADO-736482649274"
            cursor.execute("UPDATE ventas_cabecera SET tipo_comprobante = 'FACTURA B', estado = 'FACTURADO_AFIP' WHERE id = ?", (venta_id,))

        conexion.commit()
        conexion.close()
        
        return {
            "mensaje": "¡Venta registrada con éxito!",
            "numero_ticket": venta_id,
            "total_cobrado": total_con_descuento,
            "vuelto": vuelto_cliente,
            "ahorro_total": ahorro_final_para_ticket,
            "cae_afip": cae_afip
        }
        
    except Exception as e:
        conexion.rollback()
        conexion.close()
        return {"error": "Venta Rechazada", "detalle": str(e)}

# --- 3. GENERAR EL TICKET IMPRESO ---
@router.get("/ticket/{venta_id}")
def generar_ticket(venta_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        cursor.execute("SELECT * FROM ventas_cabecera WHERE id = ?", (venta_id,))
        venta = cursor.fetchone()
        
        if not venta:
            return {"error": "Ese número de ticket no existe"}
            
        # LA MAGIA ACÁ: Hacemos un JOIN con la tabla productos para sacar la unidad_medida
        cursor.execute('''
            SELECT vd.descripcion_historica as nombre, vd.cantidad, vd.precio_unitario_historico as precio_unitario, vd.subtotal, p.unidad_medida 
            FROM ventas_detalle vd
            LEFT JOIN productos p ON vd.producto_id = p.id
            WHERE vd.venta_id = ?
        ''', (venta_id,))
        detalle = cursor.fetchall()

        # Si fue MIXTO, traemos el detalle de con qué pagó
        desglose_mixto = []
        if venta['metodo_pago'] == 'MIXTO':
            try:
                cursor.execute("SELECT metodo_pago, monto FROM ventas_pagos_mixtos WHERE venta_id = ?", (venta_id,))
                desglose_mixto = [dict(row) for row in cursor.fetchall()]
            except: pass
        
        ticket_formateado = {
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
            },
            "pie_pagina": "¡Gracias por su compra!"
        }
        
        return ticket_formateado
    except Exception as e:
        return {"error": "No se pudo generar el ticket", "detalle": str(e)}
    finally:
        conexion.close()
    
# --- 4. TRAER EL HISTORIAL DEL TURNO ---
@router.get("/historial/{turno_id}")
def historial_ventas_turno(turno_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT fecha_hora_apertura FROM turnos_caja WHERE id = ?", (turno_id,))
        turno = cursor.fetchone()
        if not turno: raise Exception("El turno no existe.")
            
        fecha_apertura = turno['fecha_hora_apertura']
        
        cursor.execute('''
            SELECT id, id AS numero_ticket, fecha_hora, total_venta, metodo_pago, estado 
            FROM ventas_cabecera WHERE fecha_hora >= ? ORDER BY id DESC
        ''', (fecha_apertura,))
        
        ventas = [dict(row) for row in cursor.fetchall()]
        return {"ventas": ventas}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()

# --- 5. ANULAR UNA VENTA Y DEVOLVER EL STOCK Y DINERO ---
@router.put("/anular/{venta_id}")
def anular_venta(venta_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # 1. Buscamos el ticket
        cursor.execute("SELECT estado, id, metodo_pago, total_venta, cliente_id FROM ventas_cabecera WHERE id = ?", (venta_id,))
        venta = cursor.fetchone()
        
        if not venta: raise Exception("La venta no existe.")
        if venta[0] == 'ANULADA': raise Exception("Esta venta ya está anulada.")

        # 2. REVERSO DE STOCK (El Bug del Motivo arreglado con LIKE)
        cursor.execute('''
            SELECT lote_id, cantidad, producto_id 
            FROM movimientos_stock WHERE motivo LIKE ?
        ''', (f"Ticket #{venta_id}%",))
        movimientos_afectados = cursor.fetchall()

        for mov in movimientos_afectados:
            lote_id, cantidad, producto_id = mov
            # Devolvemos la cantidad al lote
            cursor.execute("UPDATE lotes_stock SET cantidad_disponible = cantidad_disponible + ? WHERE id = ?", (cantidad, lote_id))
            # Registramos el movimiento de devolución
            cursor.execute('''
                INSERT INTO movimientos_stock (producto_id, lote_id, tipo_movimiento, cantidad, motivo)
                VALUES (?, ?, 'ANULACION', ?, ?)
            ''', (producto_id, lote_id, cantidad, f"Anulación Ticket #{venta_id}"))

        # 3. REVERSO DE DINERO Y CUENTAS
        metodo_pago = venta[2].upper()
        total_venta = venta[3]
        cliente_id = venta[4]
        
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

        # A. Si era fiado, le restamos la deuda al cliente y dejamos registro
        if metodo_pago in ['FIADO', 'CUENTA CORRIENTE'] and cliente_id:
            cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor - ? WHERE id = ?", (total_venta, cliente_id))
            cursor.execute('''
                INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
                VALUES (?, ?, 'PAGO_ANULACION', ?, ?, 1)
            ''', (cliente_id, fecha_actual, total_venta, f"Anulación Ticket #{venta_id}"))

        # B. Si era EFECTIVO puro (El Bug de la Caja arreglado)
        elif metodo_pago == 'EFECTIVO':
            cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'")
            turno = cursor.fetchone()
            if turno:
                cursor.execute('''
                    INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones) 
                    VALUES (?, 1, 'RETIRO', ?, ?)
                ''', (fecha_actual, total_venta, f"Anulación Efectivo Ticket #{venta_id}"))

        # C. Si era MIXTO, sacamos solo la parte que era efectivo físico
        elif metodo_pago == 'MIXTO':
            try:
                cursor.execute("SELECT monto FROM ventas_pagos_mixtos WHERE venta_id = ? AND metodo_pago = 'EFECTIVO'", (venta_id,))
                efvo = cursor.fetchone()
                if efvo and efvo[0] > 0:
                    cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'")
                    turno = cursor.fetchone()
                    if turno:
                        cursor.execute('''
                            INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones) 
                            VALUES (?, 1, 'RETIRO', ?, ?)
                        ''', (fecha_actual, efvo[0], f"Anulación Efectivo Mixto #{venta_id}"))
            except: pass

        # 4. Tachamos el ticket definitivamente
        cursor.execute("UPDATE ventas_cabecera SET estado = 'ANULADA' WHERE id = ?", (venta_id,))
        
        conexion.commit()
        return {"mensaje": "Venta anulada, stock devuelto y caja actualizada."}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()
        