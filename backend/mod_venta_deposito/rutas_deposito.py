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


def _disponible(cursor, producto_id):
    cursor.execute(
        """
        SELECT IFNULL(SUM(cantidad_disponible), 0)
        FROM lotes_stock
        WHERE producto_id = ? AND estado_lote = 'Activo'
        """,
        (producto_id,),
    )
    fisico = float(cursor.fetchone()[0] or 0)
    cursor.execute(
        "SELECT nombre, IFNULL(stock_comprometido, 0) FROM productos WHERE id = ?",
        (producto_id,),
    )
    fila = cursor.fetchone()
    if not fila:
        raise Exception(f"El producto ID {producto_id} no existe.")
    return fisico - float(fila[1] or 0), fila[0]


def _reservar(cursor, producto_id, cantidad):
    cantidad = float(cantidad or 0)
    if cantidad <= 0:
        raise Exception("La cantidad a reservar tiene que ser mayor a cero.")
    disponible, nombre = _disponible(cursor, producto_id)
    if cantidad > disponible + 0.0001:
        raise Exception(
            f"No alcanza '{nombre}'. Sin reservar hay {round(disponible, 2)} y este pedido pide {cantidad}."
        )
    cursor.execute(
        "UPDATE productos SET stock_comprometido = IFNULL(stock_comprometido, 0) + ? WHERE id = ?",
        (cantidad, producto_id),
    )


def _soltar(cursor, producto_id, cantidad):
    cursor.execute(
        """
        UPDATE productos
        SET stock_comprometido = MAX(0, IFNULL(stock_comprometido, 0) - ?)
        WHERE id = ?
        """,
        (float(cantidad or 0), producto_id),
    )


def reconstruir_stock_comprometido():
    """El número viejo no sirve. La reserva es la suma de los pedidos que todavía no se entregaron."""
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute(
            """
            UPDATE productos
            SET stock_comprometido = (
                SELECT IFNULL(SUM(d.cantidad), 0)
                FROM ventas_detalle d
                JOIN ventas_cabecera c ON c.id = d.venta_id
                WHERE d.producto_id = productos.id
                  AND c.tipo_comprobante = 'PEDIDO'
                  AND c.estado IN ('PENDIENTE_PAGO', 'PAGADO_PENDIENTE_ENTREGA')
            )
            """
        )
        conexion.commit()
    finally:
        conexion.close()


reconstruir_stock_comprometido()

router = APIRouter()

_MEDIOS_PEDIDO = {
    "EFECTIVO": "EFECTIVO",
    "TARJETA": "TARJETA",
    "TARJETA DEBITO": "TARJETA DEBITO",
    "TARJETA CREDITO": "TARJETA CREDITO",
    "TRANSFERENCIA": "TRANSFERENCIA",
    "QR": "QR",
    "CTA_CTE": "CUENTA CORRIENTE",
    "FIADO": "CUENTA CORRIENTE",
    "CUENTA CORRIENTE": "CUENTA CORRIENTE",
}


def liquidar_pedido_mayorista(cursor, pedido_id, pagos, origen, turno_id=None):
    """Un solo cobro. CAJA deja el turno y el efectivo en el cajón. DEPOSITO no toca el cajón."""
    origen = (origen or "").upper()
    if origen not in ("CAJA", "DEPOSITO"):
        raise Exception("Origen de cobro inválido.")

    cursor.execute(
        "SELECT id, estado, total_venta, cliente_id, tipo_comprobante FROM ventas_cabecera WHERE id = ?",
        (pedido_id,),
    )
    pedido = cursor.fetchone()
    if not pedido:
        raise Exception("El documento no existe.")
    if pedido["tipo_comprobante"] != "PEDIDO":
        raise Exception("No podés cobrar un presupuesto. Tenés que pasarlo a pedido primero.")
    if pedido["estado"] != "PENDIENTE_PAGO":
        raise Exception(f"Este pedido ya está en estado {pedido['estado']}.")

    patas = []
    for pago in pagos or []:
        crudo = str(pago.get("metodo") or "").upper().strip()
        metodo = _MEDIOS_PEDIDO.get(crudo)
        if not metodo:
            raise Exception(f"Medio no válido: {pago.get('metodo')}.")
        monto = round(float(pago.get("monto") or 0), 2)
        if monto <= 0:
            continue
        if origen == "DEPOSITO" and metodo == "EFECTIVO":
            metodo = "EFECTIVO OFICINA"
        patas.append({"metodo": metodo, "monto": monto})
    if not patas:
        raise Exception("El cobro no tiene montos.")

    total = round(float(pedido["total_venta"] or 0), 2)
    suma = round(sum(p["monto"] for p in patas), 2)
    if abs(suma - total) > 0.05:
        raise Exception(f"El cobro cierra en ${suma:.2f} y el pedido es ${total:.2f}.")

    fiado = round(sum(p["monto"] for p in patas if p["metodo"] == "CUENTA CORRIENTE"), 2)
    if fiado > 0:
        if not pedido["cliente_id"]:
            raise Exception("Para fiar el pedido tiene que tener un cliente.")
        cursor.execute(
            "SELECT nombre_completo, saldo_actual_deudor, limite_credito FROM clientes WHERE id = ?",
            (pedido["cliente_id"],),
        )
        cliente = cursor.fetchone()
        if not cliente:
            raise Exception("El cliente del pedido no existe.")
        saldo = float(cliente["saldo_actual_deudor"] or 0)
        limite = float(cliente["limite_credito"] or 0)
        if saldo + fiado > limite + 0.05:
            raise Exception(f"{cliente['nombre_completo']} supera el límite de cuenta.")

    turno_guardar = None
    if origen == "CAJA":
        if not turno_id:
            raise Exception("La caja no tiene un turno abierto.")
        cursor.execute(
            "SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'",
            (turno_id,),
        )
        if not cursor.fetchone():
            raise Exception("Este turno de caja no está activo o no existe.")
        turno_guardar = turno_id

    metodo_header = patas[0]["metodo"] if len(patas) == 1 else "MIXTO"
    cursor.execute(
        """
        UPDATE ventas_cabecera
        SET estado = 'PAGADO_PENDIENTE_ENTREGA', metodo_pago = ?, turno_id = ?
        WHERE id = ? AND estado = 'PENDIENTE_PAGO'
        """,
        (metodo_header, turno_guardar, pedido_id),
    )
    if cursor.rowcount != 1:
        raise Exception("El pedido no existe o ya fue cobrado.")

    if len(patas) > 1:
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS ventas_pagos_mixtos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                venta_id INTEGER,
                metodo_pago TEXT,
                monto REAL,
                comision REAL DEFAULT 0
            )
            """
        )
        for pata in patas:
            cursor.execute(
                "INSERT INTO ventas_pagos_mixtos (venta_id, metodo_pago, monto, comision) VALUES (?, ?, ?, 0)",
                (pedido_id, pata["metodo"], pata["monto"]),
            )

    if fiado > 0:
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute(
            "UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor + ? WHERE id = ?",
            (fiado, pedido["cliente_id"]),
        )
        cursor.execute(
            """
            INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
            VALUES (?, ?, 'CARGO', ?, ?, 1)
            """,
            (pedido["cliente_id"], fecha_actual, fiado, f"Pedido mayorista #{pedido_id}"),
        )

    if origen == "CAJA" and len(patas) > 1:
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        for pata in patas:
            if pata["metodo"] != "EFECTIVO":
                continue
            cursor.execute(
                """
                INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
                VALUES (?, 1, 'INGRESO', ?, ?, ?)
                """,
                (fecha_actual, pata["monto"], f"Efectivo de pedido mayorista #{pedido_id}", turno_guardar),
            )

    return {
        "mensaje": "Pedido cobrado. Queda listo para entregar.",
        "metodo": metodo_header,
        "total": total,
    }

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
                _reservar(cursor, item.producto_id, item.cantidad)
                
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

# --- 3. COBRAR EN EL DEPÓSITO (no entra al cajón del salón) ---
class CobroEnDeposito(BaseModel):
    metodo_pago: str

@router.put("/cobrar/{pedido_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def cobrar_pedido_en_deposito(pedido_id: int, pago: CobroEnDeposito):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT total_venta FROM ventas_cabecera WHERE id = ?", (pedido_id,))
        pedido = cursor.fetchone()
        if not pedido:
            raise Exception("El documento no existe.")
        resultado = liquidar_pedido_mayorista(
            cursor,
            pedido_id,
            [{"metodo": pago.metodo_pago, "monto": pedido["total_venta"]}],
            "DEPOSITO",
        )
        conexion.commit()
        return resultado
    except Exception as e:
        conexion.rollback()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}
    finally:
        conexion.close()

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
                
            _soltar(cursor, item["producto_id"], item["cantidad"])
                
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
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute(
            "SELECT tipo_comprobante, estado FROM ventas_cabecera WHERE id = ?",
            (doc_id,),
        )
        doc = cursor.fetchone()
        if not doc or doc["tipo_comprobante"] != "PRESUPUESTO":
            return {"error": "No se pudo convertir. Verifique que sea un Presupuesto válido."}
        if doc["estado"] != "PRESUPUESTO_ACTIVO":
            return {"error": "Ese presupuesto está vencido. Armá uno nuevo."}
        cursor.execute(
            "SELECT producto_id, cantidad FROM ventas_detalle WHERE venta_id = ?",
            (doc_id,),
        )
        for item in cursor.fetchall():
            _reservar(cursor, item["producto_id"], item["cantidad"])
        cursor.execute(
            """
            UPDATE ventas_cabecera
            SET tipo_comprobante = 'PEDIDO', estado = 'PENDIENTE_PAGO'
            WHERE id = ? AND tipo_comprobante = 'PRESUPUESTO' AND estado = 'PRESUPUESTO_ACTIVO'
            """,
            (doc_id,),
        )
        if cursor.rowcount != 1:
            raise Exception("No se pudo convertir. Verifique que sea un Presupuesto válido.")
        conexion.commit()
        return {"mensaje": "¡Convertido! La mercadería quedó reservada. El cliente puede pasar por caja a pagar."}
    except Exception as e:
        conexion.rollback()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}
    finally:
        conexion.close()


@router.put("/anular/{doc_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def anular_pedido_sin_cobro(doc_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute(
            "SELECT tipo_comprobante, estado FROM ventas_cabecera WHERE id = ?",
            (doc_id,),
        )
        doc = cursor.fetchone()
        if not doc or doc["tipo_comprobante"] != "PEDIDO":
            return {"error": "Ese documento no es un pedido."}
        if doc["estado"] != "PENDIENTE_PAGO":
            return {"error": "Solo se anula un pedido que todavía no se cobró."}
        cursor.execute(
            "SELECT producto_id, cantidad FROM ventas_detalle WHERE venta_id = ?",
            (doc_id,),
        )
        for item in cursor.fetchall():
            _soltar(cursor, item["producto_id"], item["cantidad"])
        cursor.execute(
            """
            UPDATE ventas_cabecera
            SET estado = 'ANULADO'
            WHERE id = ? AND estado = 'PENDIENTE_PAGO'
            """,
            (doc_id,),
        )
        if cursor.rowcount != 1:
            raise Exception("Ese pedido ya no está pendiente de pago.")
        conexion.commit()
        return {"mensaje": "Pedido anulado. La reserva volvió al disponible."}
    except Exception as e:
        conexion.rollback()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}
    finally:
        conexion.close()