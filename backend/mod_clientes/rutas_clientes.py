from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import sqlite3
from backend.database import obtener_conexion

router = APIRouter()

# --- 1. MODELOS DE DATOS ---
class ClienteNuevo(BaseModel):
    nombre_completo: str
    cuit: Optional[str] = ""
    condicion_iva: str = "Consumidor Final" # <-- NUEVO BLINDAJE AFIP
    telefono_whatsapp: Optional[str] = ""
    direccion: Optional[str] = ""
    limite_credito: float = 50000.0

class PagoDeuda(BaseModel):
    monto_pago: float
    metodo_pago: str 
    observaciones: Optional[str] = ""
    usuario_id: int = 1
    afecta_caja: bool = False  # <-- EL SWITCH INTELIGENTE

# --- FUNCIÓN DE ARRANQUE (Mantenimiento Automático) ---
def inicializar_tabla_movimientos():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute('''CREATE TABLE IF NOT EXISTS movimientos_clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER,
        fecha_hora DATETIME,
        tipo_movimiento TEXT, 
        monto REAL,
        detalle TEXT,
        usuario_id INTEGER
    )''')
    
    # PARCHE DE MIGRACIÓN: Le inyectamos la columna IVA a tu tabla vieja sin romper nada
    try:
        cursor.execute("ALTER TABLE clientes ADD COLUMN condicion_iva TEXT DEFAULT 'Consumidor Final'")
    except sqlite3.OperationalError:
        pass # Si tira error es porque ya existe, seguimos de largo
        
    conexion.commit()
    conexion.close()

inicializar_tabla_movimientos()

# --- 2. GESTIÓN DE CLIENTES (Crear, Editar y Listar) ---
@router.post("/registrar")
def registrar_cliente(cli: ClienteNuevo):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            INSERT INTO clientes (nombre_completo, cuit, condicion_iva, telefono_whatsapp, direccion, limite_credito, saldo_actual_deudor)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        ''', (cli.nombre_completo, cli.cuit, cli.condicion_iva, cli.telefono_whatsapp, cli.direccion, cli.limite_credito))
        conexion.commit()
        return {"mensaje": f"Cliente {cli.nombre_completo} dado de alta con éxito."}
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
    finally:
        conexion.close()

@router.put("/actualizar/{cliente_id}")
def actualizar_cliente(cliente_id: int, cli: ClienteNuevo):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            UPDATE clientes 
            SET nombre_completo = ?, cuit = ?, condicion_iva = ?, telefono_whatsapp = ?, direccion = ?, limite_credito = ?
            WHERE id = ?
        ''', (cli.nombre_completo, cli.cuit, cli.condicion_iva, cli.telefono_whatsapp, cli.direccion, cli.limite_credito, cliente_id))
        conexion.commit()
        return {"mensaje": f"Ficha de {cli.nombre_completo} actualizada."}
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
    finally:
        conexion.close()

@router.get("/listado")
def listar_clientes():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT * FROM clientes ORDER BY nombre_completo ASC")
    clientes = [dict(c) for c in cursor.fetchall()]
    conexion.close()
    return {"clientes": clientes}

# --- 3. COBRO DE DEUDA (Multiuso: Admin o POS) ---
@router.put("/pagar_deuda/{cliente_id}")
def registrar_pago_deuda(cliente_id: int, pago: PagoDeuda):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        fecha_actual = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # 1. Le descontamos la deuda al cliente
        cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor - ? WHERE id = ?", (pago.monto_pago, cliente_id))

        # 2. Dejamos el registro en su historial
        origen = "Caja/Mostrador" if pago.afecta_caja else "Administración"
        cursor.execute('''
            INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
            VALUES (?, ?, 'PAGO', ?, ?, ?)
        ''', (cliente_id, fecha_actual, pago.monto_pago, f"Pago en {origen} ({pago.metodo_pago})", pago.usuario_id))
        
        # 3. EL SWITCH: Si afecta caja y es en efectivo, recién ahí inflamos el cajón del turno
        if pago.afecta_caja and pago.metodo_pago.upper() == "EFECTIVO":
            cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'")
            turno = cursor.fetchone()
            if turno:
                cursor.execute('''
                    INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones)
                    VALUES (?, ?, 'INGRESO', ?, ?)
                ''', (fecha_actual, pago.usuario_id, pago.monto_pago, f"Cobro Deuda Cliente ID: {cliente_id}"))

        conexion.commit()
        return {"mensaje": "Pago procesado correctamente."}
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
    finally:
        conexion.close()

# --- 4. HISTORIAL (La Película Completa) ---
@router.get("/historial/{cliente_id}")
def ver_historial_cliente(cliente_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT fecha_hora, tipo_movimiento, monto, detalle, usuario_id 
            FROM movimientos_clientes 
            WHERE cliente_id = ? 
            ORDER BY fecha_hora DESC
        ''', (cliente_id,))
        movimientos = [dict(m) for m in cursor.fetchall()]
        return {"movimientos": movimientos}
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
    finally:
        conexion.close()
        
        # --- 5. RECARGOS Y AJUSTES POR INFLACIÓN ---
class AjusteDeuda(BaseModel):
    monto: float
    motivo: str
    usuario_id: int = 1

@router.put("/aplicar_recargo/{cliente_id}")
def aplicar_recargo(cliente_id: int, ajuste: AjusteDeuda):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        fecha_actual = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # 1. Sumamos la deuda
        cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor + ? WHERE id = ?", (ajuste.monto, cliente_id))
        
        # 2. Registramos el movimiento
        cursor.execute('''
            INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
            VALUES (?, ?, 'RECARGO', ?, ?, ?)
        ''', (cliente_id, fecha_actual, ajuste.monto, ajuste.motivo, ajuste.usuario_id))
        
        conexion.commit()
        return {"mensaje": "Recargo aplicado correctamente."}
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
    finally:
        conexion.close()

@router.get("/simular_actualizacion/{cliente_id}")
def simular_actualizacion_precios(cliente_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # 1. Vemos cuánta plata debe hoy
        cursor.execute("SELECT saldo_actual_deudor FROM clientes WHERE id = ?", (cliente_id,))
        cliente = cursor.fetchone()
        if not cliente or cliente['saldo_actual_deudor'] <= 0:
            return {"error": "El cliente no tiene deuda para actualizar."}
            
        deuda_actual = cliente['saldo_actual_deudor']
        
        # 2. Buscamos los últimos tickets fiados hasta cubrir el monto de la deuda
        cursor.execute("SELECT detalle, monto FROM movimientos_clientes WHERE cliente_id = ? AND tipo_movimiento = 'CARGO' ORDER BY fecha_hora DESC", (cliente_id,))
        cargos = cursor.fetchall()
        
        deuda_restante = deuda_actual
        tickets_a_revisar = []
        for cargo in cargos:
            if deuda_restante <= 0: break
            if "Ticket POS #" in cargo['detalle']:
                try:
                    ticket_id = int(cargo['detalle'].split('#')[1])
                    tickets_a_revisar.append(ticket_id)
                except: pass
            deuda_restante -= cargo['monto']

        # 3. Viajamos al pasado, leemos qué llevó, y le ponemos el precio del futuro (hoy)
        valor_historico_total = 0
        nuevo_valor_total = 0
        
        for t_id in tickets_a_revisar:
            cursor.execute('''
                SELECT vd.cantidad, vd.precio_unitario_historico, p.precio_venta_final
                FROM ventas_detalle vd
                JOIN productos p ON vd.producto_id = p.id
                WHERE vd.venta_id = ?
            ''', (t_id,))
            items = cursor.fetchall()
            for item in items:
                valor_historico_total += (item['cantidad'] * item['precio_unitario_historico'])
                nuevo_valor_total += (item['cantidad'] * item['precio_venta_final'])
                
        diferencia = nuevo_valor_total - valor_historico_total
        
        # Ajustamos proporcionalmente por si ya pagó una parte de esos tickets
        if valor_historico_total > 0:
            porcentaje_impago = deuda_actual / valor_historico_total
            if porcentaje_impago > 1: porcentaje_impago = 1.0
            diferencia_real = diferencia * porcentaje_impago
        else:
            diferencia_real = 0

        return {
            "deuda_vieja": deuda_actual,
            "diferencia": round(diferencia_real, 2),
            "deuda_nueva": round(deuda_actual + diferencia_real, 2)
        }
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 Error en simulación de actualización de precios 🚨: {mensaje_error}")
            return {"error": "Error interno. Contacte al soporte técnico"}
            
        return {"error": mensaje_error}
    finally:
        conexion.close()
        
@router.get("/resumen_pendientes/{cliente_id}")
def resumen_pendientes(cliente_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        # 1. Buscamos al cliente y vemos cuánta plata debe
        cursor.execute("SELECT saldo_actual_deudor FROM clientes WHERE id = ?", (cliente_id,))
        cliente = cursor.fetchone()
        
        if not cliente or cliente['saldo_actual_deudor'] <= 0:
            return {"error": False, "articulos": [], "saldo_total": 0}
            
        deuda_restante = cliente['saldo_actual_deudor']
        
        # 2. Buscamos sus compras fiadas, de la MÁS NUEVA a la MÁS VIEJA
        cursor.execute('''
            SELECT id, total_venta 
            FROM ventas_cabecera 
            WHERE cliente_id = ? 
            AND UPPER(metodo_pago) IN ('CUENTA CORRIENTE', 'FIADO') 
            AND estado != 'ANULADA'
            ORDER BY fecha_hora DESC
        ''', (cliente_id,))
        ventas_fiadas = cursor.fetchall()
        
        articulos_agrupados = {}
        
        # 3. Recorremos los tickets de atrás para adelante
        for venta in ventas_fiadas:
            if deuda_restante <= 0:
                break # Si ya cubrimos la plata que debe, dejamos de buscar
                
            deuda_restante -= venta['total_venta']
            
            # Traemos los productos de este ticket (cruzando con la tabla productos)
            cursor.execute('''
                SELECT vd.cantidad, vd.subtotal, p.nombre, p.unidad_medida 
                FROM ventas_detalle vd
                LEFT JOIN productos p ON vd.producto_id = p.id
                WHERE vd.venta_id = ?
            ''', (venta['id'],))
            
            detalles = cursor.fetchall()
            
            for item in detalles:
                nombre_prod = item['nombre'] or "Artículo"
                unidad_prod = item['unidad_medida'] or "un"
                
                if nombre_prod in articulos_agrupados:
                    articulos_agrupados[nombre_prod]['cantidad'] += item['cantidad']
                    articulos_agrupados[nombre_prod]['subtotal'] += item['subtotal']
                else:
                    articulos_agrupados[nombre_prod] = {
                        "cantidad": item['cantidad'],
                        "unidad": unidad_prod,
                        "subtotal": item['subtotal']
                    }
                    
        # 4. Formateamos la lista final para el frontend
        lista_final = []
        for nombre, datos in articulos_agrupados.items():
            lista_final.append({
                "nombre": nombre,
                "cantidad": datos["cantidad"],
                "unidad": datos["unidad"],
                "subtotal": datos["subtotal"]
            })
            
        return {"error": False, "articulos": lista_final, "saldo_total": cliente['saldo_actual_deudor']}
        
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 No se pudo obtener el resumen del cliente {cliente_id} 🚨: {mensaje_error}")
            return {"error": "Error interno. Contacte al soporte técnico."}
            
        return {"error": mensaje_error}
    finally:
        conexion.close()