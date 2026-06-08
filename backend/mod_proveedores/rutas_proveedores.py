from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
from datetime import datetime
import sqlite3

router = APIRouter()

class NuevoProveedor(BaseModel):
    nombre_comercial: str
    cuit: str = ""
    telefono_vendedor: str = ""
    observaciones: str = ""


class ItemFactura(BaseModel):
    producto_id: int
    cantidad_comprada: float
    costo_unitario: float
    nuevo_precio_venta: float = None
    fecha_vencimiento: str = "2099-12-31"
    numero_lote_proveedor: str = "S/L"

class NuevaFacturaCompra(BaseModel):
    proveedor_id: int
    numero_factura: str
    condicion_pago: str
    cargos_extra: float = 0.0
    items: List[ItemFactura]
    
class PagoProveedor(BaseModel):
    proveedor_id: int
    monto_pagado: float
    metodo_pago: str
    observaciones: str = ""

# --- 1. GESTIÓN DE PROVEEDORES (ABM COMPLETO) ---
@router.post("/alta")
def registrar_proveedor(prov: NuevoProveedor):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # AGREGAMOS LAS OBSERVACIONES AL INSERT
        cursor.execute("INSERT INTO proveedores (nombre_comercial, cuit, telefono_vendedor, observaciones) VALUES (?, ?, ?, ?)", 
                       (prov.nombre_comercial, prov.cuit, prov.telefono_vendedor, prov.observaciones))
        nuevo_id = cursor.lastrowid
        cursor.execute("INSERT INTO proveedores_ctacte (proveedor_id, saldo_deudor) VALUES (?, 0)", (nuevo_id,))
        conexion.commit()
        return {"mensaje": "Proveedor registrado", "id": nuevo_id}
    except Exception as e:
        conexion.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conexion.close()

@router.get("/listado")
def listar_proveedores(solo_activos: bool = False):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # Unimos con la tabla de Cta Cte para traer el saldo real
    query = '''
        SELECT p.*, IFNULL(c.saldo_deudor, 0) as saldo_deudor 
        FROM proveedores p
        LEFT JOIN proveedores_ctacte c ON p.id = c.proveedor_id
    '''
    if solo_activos:
        query += " WHERE p.activo = 1"
    
    cursor.execute(query + " ORDER BY p.nombre_comercial ASC")
    res = [dict(p) for p in cursor.fetchall()]
    conexion.close()
    return res

@router.put("/actualizar/{prov_id}")
def actualizar_proveedor(prov_id: int, prov: NuevoProveedor):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # AGREGAMOS LAS OBSERVACIONES AL UPDATE
        cursor.execute("UPDATE proveedores SET nombre_comercial=?, cuit=?, telefono_vendedor=?, observaciones=? WHERE id=?", 
                       (prov.nombre_comercial, prov.cuit, prov.telefono_vendedor, prov.observaciones, prov_id))
        conexion.commit()
        return {"mensaje": "Proveedor actualizado"}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()

@router.delete("/baja/{prov_id}")
def baja_proveedor(prov_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    cursor.execute("UPDATE proveedores SET activo = 0 WHERE id = ?", (prov_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Proveedor desactivado"}

@router.put("/reactivar/{prov_id}")
def reactivar_proveedor(prov_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    cursor.execute("UPDATE proveedores SET activo = 1 WHERE id = ?", (prov_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Proveedor reactivado"}

# --- EL CORAZÓN DE LOS PAGOS (PARCHE AQUÍ) ---
# --- REGISTRAR PAGO Y DESCONTAR DEUDA ---
# --- REGISTRAR PAGO Y DESCONTAR DEUDA ---
@router.post("/pagar")
def registrar_pago_proveedor(pago: PagoProveedor):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # 0. Creamos la tabla de pagos si por alguna razón no se creó al inicio
        cursor.execute('''CREATE TABLE IF NOT EXISTS pagos_proveedores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proveedor_id INTEGER,
            fecha_pago TEXT,
            monto_total_pagado REAL,
            metodo_pago TEXT,
            observaciones TEXT
        )''')

        # 1. Registramos el pago en el historial (Columna correcta: monto_total_pagado)
        cursor.execute('''
            INSERT INTO pagos_proveedores (proveedor_id, fecha_pago, monto_total_pagado, metodo_pago, observaciones)
            VALUES (?, datetime('now', 'localtime'), ?, ?, ?)
        ''', (pago.proveedor_id, pago.monto_pagado, pago.metodo_pago, pago.observaciones))
        
        # 2. DESCONTAMOS LA DEUDA (EL PARCHE: Usamos la tabla proveedores_ctacte y la columna saldo_deudor)
        cursor.execute("UPDATE proveedores_ctacte SET saldo_deudor = saldo_deudor - ? WHERE proveedor_id = ?", 
                       (pago.monto_pagado, pago.proveedor_id))

        # 3. Si es efectivo de caja, registramos el retiro
        if "CAJA" in pago.metodo_pago.upper():
            cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO' ORDER BY id DESC LIMIT 1")
            turno = cursor.fetchone()
            if turno:
                cursor.execute('''
                    INSERT INTO movimientos_caja (turno_id, tipo_movimiento, monto, motivo)
                    VALUES (?, 'RETIRO', ?, ?)
                ''', (turno[0], pago.monto_pagado, f"Pago a Proveedor ID {pago.proveedor_id}"))

        conexion.commit()
        return {"mensaje": "Pago realizado con éxito"}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()

# --- 2. INGRESO DE MERCADERÍA (CON ACTUALIZACIÓN DE SALDO) ---
@router.post("/cargar_factura")
def ingresar_mercaderia(factura: NuevaFacturaCompra):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        fecha_actual = datetime.now().strftime("%Y-%m-%d")
        total_acumulado = 0.0
        
        # 1. Creamos la cabecera de la compra
        cursor.execute('''
            INSERT INTO compras_cabecera (proveedor_id, numero_factura, fecha_compra, total_factura, condicion_pago)
            VALUES (?, ?, ?, 0, ?)
        ''', (factura.proveedor_id, factura.numero_factura, fecha_actual, factura.condicion_pago))
        compra_id = cursor.lastrowid
        
        # 2. Procesamos cada producto que llegó en el camión
        for item in factura.items:
            subtotal_item = item.cantidad_comprada * item.costo_unitario
            total_acumulado += subtotal_item
            
            # Buscamos el nombre para el historial
            cursor.execute("SELECT nombre FROM productos WHERE id = ?", (item.producto_id,))
            prod = cursor.fetchone()

            # A. Guardamos el detalle de la factura
            cursor.execute('''
                INSERT INTO compras_detalle 
                (compra_id, producto_id, descripcion_historica, cantidad_comprada, costo_unitario, fecha_vencimiento, numero_lote_proveedor)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (compra_id, item.producto_id, prod['nombre'], item.cantidad_comprada, item.costo_unitario, item.fecha_vencimiento, item.numero_lote_proveedor))
            
            # B. SUMAMOS EL STOCK (Creamos el Lote)
            cursor.execute('''
                INSERT INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo')
            ''', (item.producto_id, item.numero_lote_proveedor, fecha_actual, item.fecha_vencimiento, item.cantidad_comprada, item.cantidad_comprada, item.costo_unitario))
            
            # C. ACTUALIZAMOS EL PRECIO MAESTRO (Si el usuario lo cambió en la ventanita)
            if item.nuevo_precio_venta is not None:
                cursor.execute('''
                    UPDATE productos 
                    SET precio_venta_final = ?, costo_sin_iva = ? 
                    WHERE id = ?
                ''', (item.nuevo_precio_venta, item.costo_unitario, item.producto_id))

# 3. ACTUALIZAMOS EL TOTAL DE LA FACTURA (Sumando los cargos extra)
        total_final_real = total_acumulado + factura.cargos_extra
        cursor.execute("UPDATE compras_cabecera SET total_factura = ? WHERE id = ?", (total_final_real, compra_id))
        
        # 4. SUMAMOS A LA DEUDA (Si es Cuenta Corriente) - PARCHE BLINDADO
        if factura.condicion_pago == "Cuenta Corriente":
            cursor.execute("SELECT id FROM proveedores_ctacte WHERE proveedor_id = ?", (factura.proveedor_id,))
            if cursor.fetchone():
                cursor.execute("UPDATE proveedores_ctacte SET saldo_deudor = saldo_deudor + ? WHERE proveedor_id = ?", (total_final_real, factura.proveedor_id))
            else:
                cursor.execute("INSERT INTO proveedores_ctacte (proveedor_id, saldo_deudor) VALUES (?, ?)", (factura.proveedor_id, total_final_real))

        conexion.commit()
        conexion.close()
        return {"mensaje": "Stock, Precios y Deuda actualizados correctamente", "total": total_final_real}
        
    except Exception as e:
        conexion.rollback()
        conexion.close()
        return {"error": str(e)}
    
    # --- HISTORIAL DE COMPRAS ---
@router.get("/historial/{proveedor_id}")
def ver_historial_compras(proveedor_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # Traemos las cabeceras de las facturas
        cursor.execute('''
            SELECT id, numero_factura, fecha_compra, total_factura, condicion_pago
            FROM compras_cabecera
            WHERE proveedor_id = ?
            ORDER BY fecha_compra DESC
        ''', (proveedor_id,))
        compras = [dict(c) for c in cursor.fetchall()]
        
        conexion.close()
        return {"historial": compras}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}
    
    # --- VER DETALLE DE UNA FACTURA ESPECÍFICA ---
# --- VER DETALLE DE UNA FACTURA ESPECÍFICA ---
@router.get("/factura_detalle/{compra_id}")
def ver_detalle_factura(compra_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # 1. Traemos los productos
        cursor.execute('''
            SELECT descripcion_historica, cantidad_comprada, costo_unitario, 
                   (cantidad_comprada * costo_unitario) as subtotal
            FROM compras_detalle WHERE compra_id = ?
        ''', (compra_id,))
        detalle = [dict(c) for c in cursor.fetchall()]
        
        # 2. Calculamos la suma de mercadería pura
        suma_mercaderia = sum(d['subtotal'] for d in detalle)
        
        # 3. Traemos el total final que se guardó en la cabecera
        cursor.execute("SELECT total_factura FROM compras_cabecera WHERE id = ?", (compra_id,))
        cabecera = cursor.fetchone()
        total_real = cabecera['total_factura'] if cabecera else 0
        
        # 4. Los cargos extra son simplemente la diferencia
        cargos_calculados = total_real - suma_mercaderia
        
        conexion.close()
        return {
            "detalle": detalle, 
            "cargos_extra": cargos_calculados,
            "total_factura": total_real
        }
    except Exception as e:
        conexion.close()
        return {"error": str(e)}
    
@router.get("/historial_pagos/{proveedor_id}")
def ver_pagos(proveedor_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT id, fecha_pago, monto_total_pagado as monto, metodo_pago, observaciones 
            FROM pagos_proveedores 
            WHERE proveedor_id = ? 
            ORDER BY fecha_pago DESC
        ''', (proveedor_id,))
        pagos = [dict(row) for row in cursor.fetchall()]
        return {"pagos": pagos}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()
        
def migrar_proveedores():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        cursor.execute("ALTER TABLE proveedores ADD COLUMN observaciones TEXT DEFAULT ''")
        conexion.commit()
    except:
        pass # Si ya existe, no hace nada
    conexion.close()

migrar_proveedores()