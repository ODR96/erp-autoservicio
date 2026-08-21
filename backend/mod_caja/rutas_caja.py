from fastapi import APIRouter, Query, Depends
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone, timedelta
import sqlite3
from fastapi import BackgroundTasks
import requests
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

# --- NUEVA MIGRACIÓN: TABLA DE CAJAS FÍSICAS MÚLTIPLES ---
# --- NUEVA MIGRACIÓN: TABLA DE CAJAS FÍSICAS MÚLTIPLES ---
def asegurar_tabla_cajas_fisicas():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cajas_fisicas (
            id INTEGER PRIMARY KEY,
            nombre TEXT NOT NULL,
            activa BOOLEAN DEFAULT 1,
            solo_admin BOOLEAN DEFAULT 0
        )
    ''')
    
    # --- EL PARCHE: Inyectar columnas si la tabla ya existía de antes ---
    try: cursor.execute("ALTER TABLE cajas_fisicas ADD COLUMN activa BOOLEAN DEFAULT 1")
    except: pass
    try: cursor.execute("ALTER TABLE cajas_fisicas ADD COLUMN solo_admin BOOLEAN DEFAULT 0")
    except: pass
    # ---------------------------------------------------------------------

    # Insertar cajas por defecto si la tabla está vacía
    cursor.execute("SELECT COUNT(*) FROM cajas_fisicas")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO cajas_fisicas (id, nombre, activa, solo_admin) VALUES (1, 'Caja 1 (Mostrador Principal)', 1, 0)")
        cursor.execute("INSERT INTO cajas_fisicas (id, nombre, activa, solo_admin) VALUES (99, 'Caja 99 (Oficina Admin)', 1, 1)")
        
    conexion.commit()
    conexion.close()

asegurar_tabla_cajas_fisicas()
# ---------------------------------------------------------


router = APIRouter()

ZONA_AR = timezone(timedelta(hours=-3))

def disparar_alerta_cierre(turno_id, cajero, ventas, declarado, diferencia):
    # Por ahora dejamos la URL vacía hasta que conectemos tu n8n o tu API definitiva
    url_webhook = "AQUI_IRA_LA_URL_DE_TU_AUTOMATIZADOR"
    
    # Empaquetamos los datos clave de tu negocio de forma segura
    payload = {
        "evento": "CIERRE_Z",
        "sucursal": "Autoservicio 20 de Junio",
        "turno": turno_id,
        "cajero": cajero,
        "ventas_sistema": ventas,
        "plata_declarada": declarado,
        "diferencia": diferencia
    }
    
    try:
        # El servidor dispara el aviso y sigue de largo
        if url_webhook != "AQUI_IRA_LA_URL_DE_TU_AUTOMATIZADOR":
            requests.post(url_webhook, json=payload, timeout=5)
            print("Alerta de Cierre Z disparada con éxito.")
    except Exception as e:
        print(f"Error al disparar la alerta: {e}")

# --- 1. LOS GUARDIAS DE LA CAJA ---
class AperturaCaja(BaseModel):
    caja_id: int = 1
    usuario_id: int = 1 # Por ahora simulamos que sos vos (ID 1)
    monto_inicial: float

class MovimientoCaja(BaseModel):
    usuario_id: int = 1
    tipo_movimiento: str # "RETIRO" (Sangría) o "INGRESO" (Cambio extra)
    monto: float
    observaciones: str
    turno_id: int

class CierreCaja(BaseModel):
    turno_id: int
    monto_final_declarado: float # Los billetes reales que contaste con la mano
    
@router.get("/cajas_fisicas")
def listar_cajas_fisicas():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # Solo mandamos al mostrador las cajas que estén "Activas"
    cursor.execute("SELECT id, nombre FROM cajas_fisicas WHERE activa = 1 ORDER BY id ASC")
    cajas = [dict(row) for row in cursor.fetchall()]
    conexion.close()
    return {"cajas": cajas}

# --- 2. ABRIR EL TURNO ---
@router.post("/abrir", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def abrir_turno(apertura: AperturaCaja):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    try:
        # 1. EL BLINDAJE NUEVO: ¿Existe la caja y tengo permiso?
        cursor.execute("SELECT nombre, activa, solo_admin FROM cajas_fisicas WHERE id = ?", (apertura.caja_id,))
        caja_fisica = cursor.fetchone()
        
        if not caja_fisica:
            raise Exception("Esta terminal no está registrada como una caja válida en el sistema.")
        if not caja_fisica[1]: # activa == False
            raise Exception("Esta caja está deshabilitada temporalmente por la administración.")
            
        # Si la caja tiene el candado "solo_admin = True"
        if caja_fisica[2]: 
            cursor.execute("SELECT rol FROM usuarios WHERE id = ?", (apertura.usuario_id,))
            usuario = cursor.fetchone()
            if not usuario or usuario[0] not in ['ADMIN', 'ENCARGADO']:
                raise Exception("ACCESO DENEGADO: Esta terminal es de uso exclusivo para Administración. Inicie sesión en una caja de mostrador.")

        # 2. Verificamos que no haya otro turno abierto en esta caja
        cursor.execute("SELECT id FROM turnos_caja WHERE caja_id = ? AND estado_turno = 'ABIERTO'", (apertura.caja_id,))
        if cursor.fetchone():
            raise Exception("Ya hay un turno abierto en esta caja. Tenés que cerrarlo primero.")
            
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        cursor.execute('''
            INSERT INTO turnos_caja (caja_id, usuario_id, fecha_hora_apertura, monto_inicial, estado_turno)
            VALUES (?, ?, ?, ?, 'ABIERTO')
        ''', (apertura.caja_id, apertura.usuario_id, fecha_actual, apertura.monto_inicial))
        
        turno_id = cursor.lastrowid
        conexion.commit()
        return {"mensaje": f"¡Turno de caja #{turno_id} abierto con éxito!", "turno_id": turno_id}
        
    except Exception as e:
        if conexion:
            conexion.close()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            return {"error": "No se pudo abrir la caja por un error interno."}
        return {"error": mensaje_error}
    finally:
        if conexion:
            conexion.close()

# --- 3. REGISTRAR MOVIMIENTOS (INGRESO/RETIRO) ---
@router.post("/movimiento", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_movimiento(mov: MovimientoCaja):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    try:
        # Verificamos que haya una caja abierta para poder sacar o meter plata
        cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO'")
        if not cursor.fetchone():
            raise Exception("No podés registrar movimientos de plata si la caja está cerrada.")
            
        fecha_actual = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # PARCHE CLAVE: Forzamos a que siempre se guarde en MAYÚSCULAS
        tipo_mayuscula = mov.tipo_movimiento.upper()
        
        cursor.execute('''
            INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones)
            VALUES (?, ?, ?, ?, ?)
        ''', (fecha_actual, mov.usuario_id, tipo_mayuscula, mov.monto, mov.observaciones))
        
        conexion.commit()
        conexion.close()
        return {"mensaje": f"¡{tipo_mayuscula} de ${mov.monto} registrado correctamente!"}
        
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 No se pudo registrar el movimiento: {mensaje_error}")
            return {"error": "No se pudo registrar el movimiento."}
            
        return {"error": mensaje_error}

# --- 4. CIERRE Z (Arqueo Final Blindado, Corregido y con Sincronización) ---
@router.put("/cerrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def cerrar_turno(cierre: CierreCaja, background_tasks: BackgroundTasks):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        cursor.execute("SELECT * FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (cierre.turno_id,))
        turno = cursor.fetchone()
        if not turno:
            raise Exception("Ese turno no existe o ya fue cerrado.")
            
        fecha_cierre = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        fecha_apertura = turno['fecha_hora_apertura']
        
        # 1. Ventas en Efectivo
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) = 'EFECTIVO' AND turno_id = ? AND estado = 'COMPLETADA'", (cierre.turno_id,))
        ventas_efectivo = cursor.fetchone()[0] or 0.0
        
        # 2. Otros Medios (Tarjeta y Billetera)
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%TARJETA%' AND turno_id = ? AND estado = 'COMPLETADA'", (cierre.turno_id,))
        ventas_tarjeta = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%BILLETERA%' AND turno_id = ? AND estado = 'COMPLETADA'", (cierre.turno_id,))
        ventas_virtual = cursor.fetchone()[0] or 0.0    
        
        # EL PARCHE DEL FIADO: Buscamos ambos nombres
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) IN ('FIADO', 'CUENTA CORRIENTE') AND turno_id = ? AND estado = 'COMPLETADA'", (fecha_apertura,))
        ventas_fiados = cursor.fetchone()[0] or 0.0
        
        # 3. Movimientos de Caja
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'RETIRO' AND turno_id = ?", (fecha_apertura,))
        total_retiros = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'INGRESO' AND turno_id = ?", (fecha_apertura,))
        total_ingresos = cursor.fetchone()[0] or 0.0
        
        # CÁLCULO DE CAJA: Solo el efectivo físico que debe haber en el cajón
        monto_esperado_sistema = turno['monto_inicial'] + ventas_efectivo + total_ingresos - total_retiros
        diferencia = cierre.monto_final_declarado - monto_esperado_sistema
        
        cursor.execute('''
            UPDATE turnos_caja 
            SET fecha_hora_cierre = ?, monto_final_sistema = ?, monto_final_declarado = ?, diferencia = ?, estado_turno = 'CERRADO'
            WHERE id = ?
        ''', (fecha_cierre, monto_esperado_sistema, cierre.monto_final_declarado, diferencia, cierre.turno_id))
        
        conexion.commit()
        conexion.close()
                
        # ---> GATILLO 4: ALERTA DE WHATSAPP AL DUEÑO <---
        background_tasks.add_task(
            disparar_alerta_cierre,
            turno_id=cierre.turno_id,
            ventas_efectivo=ventas_efectivo,
            declarado=cierre.monto_final_declarado,
            diferencia=diferencia
        )
        
        return {
            "mensaje": "¡Cierre Z realizado con éxito! Sincronizando datos con la nube...",
            "resumen": {
                "fondo_inicial": turno['monto_inicial'],
                "ventas_en_efectivo": ventas_efectivo,
                "ventas_tarjeta": ventas_tarjeta,
                "ventas_virtual": ventas_virtual,
                "ventas_fiados": ventas_fiados,
                "ingresos_extras": total_ingresos,
                "retiros_y_gastos": total_retiros,
                "sistema_esperaba": monto_esperado_sistema,
                "vos_declaraste": cierre.monto_final_declarado,
                "diferencia": diferencia
            }
        }
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 No se pudo cerrar el turno: {mensaje_error}")
            return {"error": "Error interno al cerrar caja. Contacte a soporte."}
            
        return {"error": mensaje_error}

# --- 5. INFORME X (Datos Reales al Momento) ---
@router.get("/informe_x/{turno_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def sacar_informe_x(turno_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        cursor.execute("SELECT * FROM turnos_caja WHERE id = ?", (turno_id,))
        turno = cursor.fetchone()
        fecha_apertura = turno['fecha_hora_apertura']
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) = 'EFECTIVO' AND fecha_hora >= ? AND estado = 'COMPLETADA'", (fecha_apertura,))
        v_efectivo = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%TARJETA%' AND fecha_hora >= ? AND estado = 'COMPLETADA'", (fecha_apertura,))
        v_tarjeta = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%BILLETERA%' AND fecha_hora >= ? AND estado = 'COMPLETADA'", (fecha_apertura,))
        v_virtual = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) IN ('FIADO', 'CUENTA CORRIENTE') AND fecha_hora >= ? AND estado = 'COMPLETADA'", (fecha_apertura,))
        v_fiados = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'RETIRO' AND fecha_hora >= ?", (fecha_apertura,))
        retiros = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'INGRESO' AND fecha_hora >= ?", (fecha_apertura,))
        ingresos = cursor.fetchone()[0] or 0.0
        
        esperado = turno['monto_inicial'] + v_efectivo + ingresos - retiros
        conexion.close()
        
        return {
            "resumen_parcial": {
                "fondo_inicial": turno['monto_inicial'],
                "ventas_en_efectivo": v_efectivo,
                "ventas_tarjeta": v_tarjeta,
                "ventas_virtual": v_virtual,
                "ventas_fiados": v_fiados,
                "ingresos_extras": ingresos,
                "retiros_y_gastos": retiros,
                "plata_que_deberia_haber_ahora": esperado
            }
        }
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 No se generar el informe X: {mensaje_error}")
            return {"error": "Error interno: No se genero el informe. Contacte a soporte."}
            
        return {"error": mensaje_error}
    
# --- 6. MONITOR EN VIVO (Para el panel de Admin) ---
@router.get("/monitor_vivo", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def monitor_cajas_vivo():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT t.id as turno_id, t.caja_id, t.fecha_hora_apertura, t.monto_inicial, u.nombre_completo as cajero
            FROM turnos_caja t
            LEFT JOIN usuarios u ON t.usuario_id = u.id
            WHERE t.estado_turno = 'ABIERTO'
        ''')
        turnos_abiertos = [dict(t) for t in cursor.fetchall()]
        
        fecha_corte = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for turno in turnos_abiertos:
            fecha_apertura = turno['fecha_hora_apertura']
            
            # Efectivo
            cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE metodo_pago = 'EFECTIVO' AND fecha_hora >= ?", (fecha_apertura,))
            ventas_efectivo = cursor.fetchone()[0] or 0.0
            
            # Tarjeta / POS
            cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE metodo_pago LIKE '%Tarjeta%' AND fecha_hora >= ?", (fecha_apertura,))
            ventas_tarjeta = cursor.fetchone()[0] or 0.0
            
            # Billetera / QR
            cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE metodo_pago LIKE '%Billetera%' AND fecha_hora >= ?", (fecha_apertura,))
            ventas_virtual = cursor.fetchone()[0] or 0.0
            
            # Ingresos y Retiros
            cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'RETIRO' AND fecha_hora >= ?", (fecha_apertura,))
            retiros = cursor.fetchone()[0] or 0.0
            
            cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'INGRESO' AND fecha_hora >= ?", (fecha_apertura,))
            ingresos = cursor.fetchone()[0] or 0.0
            
            turno['ventas_efectivo'] = ventas_efectivo
            turno['ventas_tarjeta'] = ventas_tarjeta
            turno['ventas_virtual'] = ventas_virtual
            turno['retiros'] = retiros
            turno['ingresos'] = ingresos
            turno['total_esperado'] = turno['monto_inicial'] + ventas_efectivo + ingresos - retiros
            
        conexion.close()
        return {"turnos_vivos": turnos_abiertos}
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 No se puede visualizar la caja en vivo: {mensaje_error}")
            return {"error": "No se puede visualizar la caja. Contacte a soporte."}
            
        return {"error": mensaje_error}
    
    # --- 8. VERIFICAR ESTADO DE CAJA (Para que el POS tenga memoria) ---
@router.get("/estado", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def estado_caja(caja_id: int = 1):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # Buscamos el último turno registrado de esta caja
        cursor.execute('''
            SELECT id, estado_turno 
            FROM turnos_caja 
            WHERE caja_id = ? 
            ORDER BY id DESC LIMIT 1
        ''', (caja_id,))
        turno = cursor.fetchone()
        conexion.close()
        
        # Si hay un turno y dice ABIERTO, le avisamos al frontend
        if turno and turno['estado_turno'] == 'ABIERTO':
            return {"estado": "ABIERTO", "turno_id": turno['id']}
        else:
            return {"estado": "CERRADO"}
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 No se puede ver el estado de la caja: {mensaje_error}")
            return {"error": "Error interno. Contacte a soporte."}
            
        return {"error": mensaje_error}
    
# --- EL GUARDIÁN DEL COBRO MAYORISTA (Ahora acepta mixtos) ---
class PagoMixtoCaja(BaseModel):
    metodo: str
    monto: float

class CobroPedido(BaseModel):
    pedido_id: int
    monto_total: float
    metodo_pago: str
    pagos_mixtos: Optional[List[PagoMixtoCaja]] = None
    observaciones: Optional[str] = ""
    turno_id: int

# --- RUTA OFICIAL: CONECTAR COBRO CON LOGÍSTICA ---
@router.post("/cobrar_pedido", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def cobrar_pedido_mayorista(cobro: CobroPedido):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        # 1. Buscamos el turno abierto
        cursor.execute("SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO' ORDER BY id DESC LIMIT 1")
        turno_abierto = cursor.fetchone()
        
        if not turno_abierto:
            raise Exception("No hay ningún turno de caja abierto en este momento. ¡Abra la caja primero!")
            
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        # 2. Armamos la lista de pagos a procesar (sea 1 solo o mixto)
        pagos_a_procesar = []
        if cobro.metodo_pago == 'MIXTO' and cobro.pagos_mixtos:
            pagos_a_procesar = cobro.pagos_mixtos
        else:
            pagos_a_procesar = [PagoMixtoCaja(metodo=cobro.metodo_pago, monto=cobro.monto_total)]

        # 3. Guardamos cada pago en la caja o en la cuenta corriente
        for pago in pagos_a_procesar:
            if pago.monto > 0:
                if pago.metodo != 'CTA_CTE':
                    detalle_pago = f"Cobro Pedido Mayorista #{cobro.pedido_id} ({pago.metodo})"
                    cursor.execute('''
                        INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones)
                        VALUES (?, 1, 'INGRESO', ?, ?)
                    ''', (fecha_actual, pago.monto, detalle_pago))
                else:
                    # Fiado (Cuenta Corriente)
                    cursor.execute("SELECT cliente_id FROM ventas_cabecera WHERE id = ?", (cobro.pedido_id,))
                    row_pedido = cursor.fetchone()
                    if row_pedido and row_pedido['cliente_id']:
                        cliente_id = row_pedido['cliente_id']
                        cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor + ? WHERE id = ?", (pago.monto, cliente_id))
                        cursor.execute('''
                            INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
                            VALUES (?, ?, 'DEUDA', ?, ?, 1)
                        ''', (cliente_id, fecha_actual, pago.monto, f"Pedido Mayorista #{cobro.pedido_id} (Pago Mixto)"))

        # 4. LA CLAVE LOGÍSTICA
        cursor.execute('''
            UPDATE ventas_cabecera 
            SET estado = 'PAGADO_PENDIENTE_ENTREGA', metodo_pago = ? 
            WHERE id = ? AND estado = 'PENDIENTE_PAGO'
        ''', (cobro.metodo_pago, cobro.pedido_id))
        
        if cursor.rowcount == 0:
            raise Exception("El pedido no existe, no es válido o ya fue cobrado.")
            
        conexion.commit()
        return {"mensaje": "¡Cobro registrado exitosamente!"}
        
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 Error al cobrar pedido mayorista: {mensaje_error}")
            return {"error": "Error interno. Contacte a soporte."}
            
        return {"error": mensaje_error}
    finally:
        conexion.close()
        
class NuevaCaja(BaseModel):
    id: int # Vos elegís el número (Ej: 3, 4, 99)
    nombre: str
    solo_admin: bool

@router.post("/cajas_fisicas/crear", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def crear_caja_fisica(caja: NuevaCaja):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id FROM cajas_fisicas WHERE id = ?", (caja.id,))
        if cursor.fetchone():
            raise Exception(f"Ya existe una terminal con el ID {caja.id}. Elegí otro número.")
            
        cursor.execute('''
            INSERT INTO cajas_fisicas (id, nombre, activa, solo_admin) 
            VALUES (?, ?, 1, ?)
        ''', (caja.id, caja.nombre, caja.solo_admin))
        conexion.commit()
        return {"mensaje": "Terminal registrada correctamente."}
    except Exception as e:
        if conexion: conexion.rollback()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

@router.put("/cajas_fisicas/toggle/{caja_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def toggle_caja_fisica(caja_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT activa FROM cajas_fisicas WHERE id = ?", (caja_id,))
        caja = cursor.fetchone()
        if not caja: raise Exception("La caja no existe.")
        
        nuevo_estado = 0 if caja[0] == 1 else 1 # Invierte el estado
        cursor.execute("UPDATE cajas_fisicas SET activa = ? WHERE id = ?", (nuevo_estado, caja_id))
        conexion.commit()
        return {"mensaje": "Estado de la terminal actualizado.", "nuevo_estado": nuevo_estado}
    except Exception as e:
        if conexion: conexion.rollback()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

# RUTA ESPECIAL: Lista TODAS las cajas para el Admin (incluso las apagadas)
@router.get("/cajas_fisicas/admin_listado", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_todas_las_cajas():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT * FROM cajas_fisicas ORDER BY id ASC")
    cajas = [dict(row) for row in cursor.fetchall()]
    conexion.close()
    return {"cajas": cajas}