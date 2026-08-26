from fastapi import APIRouter, Query, Depends
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone, timedelta
import sqlite3
from fastapi import BackgroundTasks
import requests
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

def asegurar_tabla_cajas_fisicas():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cajas_fisicas (
            id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, activa BOOLEAN DEFAULT 1, solo_admin BOOLEAN DEFAULT 0
        )
    ''')
    try: cursor.execute("ALTER TABLE cajas_fisicas ADD COLUMN activa BOOLEAN DEFAULT 1")
    except: pass
    try: cursor.execute("ALTER TABLE cajas_fisicas ADD COLUMN solo_admin BOOLEAN DEFAULT 0")
    except: pass
    cursor.execute("SELECT COUNT(*) FROM cajas_fisicas")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO cajas_fisicas (id, nombre, activa, solo_admin) VALUES (1, 'Caja 1 (Mostrador Principal)', 1, 0)")
        cursor.execute("INSERT INTO cajas_fisicas (id, nombre, activa, solo_admin) VALUES (99, 'Caja 99 (Oficina Admin)', 1, 1)")
    conexion.commit()
    conexion.close()

asegurar_tabla_cajas_fisicas()

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

def disparar_alerta_cierre(turno_id, cajero, ventas, declarado, diferencia):
    pass # ACÁ VA TU N8N LUEGO

class AperturaCaja(BaseModel):
    caja_id: int = 1
    usuario_id: int = 1 
    monto_inicial: float

class MovimientoCaja(BaseModel):
    usuario_id: int = 1
    tipo_movimiento: str 
    monto: float
    observaciones: str
    turno_id: int

class CierreCaja(BaseModel):
    turno_id: int
    monto_final_declarado: float 
    
@router.get("/cajas_fisicas")
def listar_cajas_fisicas():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT id, nombre FROM cajas_fisicas WHERE activa = 1 ORDER BY id ASC")
    cajas = [dict(row) for row in cursor.fetchall()]
    conexion.close()
    return {"cajas": cajas}

@router.post("/abrir", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def abrir_turno(apertura: AperturaCaja):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT nombre, activa, solo_admin FROM cajas_fisicas WHERE id = ?", (apertura.caja_id,))
        caja_fisica = cursor.fetchone()
        if not caja_fisica: raise Exception("Esta terminal no está registrada.")
        if not caja_fisica[1]: raise Exception("Esta caja está deshabilitada.")
        if caja_fisica[2]: 
            cursor.execute("SELECT rol FROM usuarios WHERE id = ?", (apertura.usuario_id,))
            usuario = cursor.fetchone()
            if not usuario or usuario[0] not in ['ADMIN', 'ENCARGADO']: raise Exception("Caja exclusiva para Administración.")

        cursor.execute("SELECT id FROM turnos_caja WHERE caja_id = ? AND estado_turno = 'ABIERTO'", (apertura.caja_id,))
        if cursor.fetchone(): raise Exception("Ya hay un turno abierto en esta caja.")
            
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute('''
            INSERT INTO turnos_caja (caja_id, usuario_id, fecha_hora_apertura, monto_inicial, estado_turno)
            VALUES (?, ?, ?, ?, 'ABIERTO')
        ''', (apertura.caja_id, apertura.usuario_id, fecha_actual, apertura.monto_inicial))
        
        turno_id = cursor.lastrowid
        conexion.commit()
        return {"mensaje": f"¡Turno de caja #{turno_id} abierto con éxito!", "turno_id": turno_id}
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

@router.post("/movimiento", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_movimiento(mov: MovimientoCaja):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (mov.turno_id,))
        if not cursor.fetchone(): raise Exception("El turno especificado no está abierto.")
            
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        # EL SELLO DE SEGURIDAD: Limpiamos espacios y forzamos mayúsculas
        tipo_mayuscula = mov.tipo_movimiento.strip().upper()
        
        cursor.execute('''
            INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (fecha_actual, mov.usuario_id, tipo_mayuscula, mov.monto, mov.observaciones, mov.turno_id))
        
        conexion.commit()
        return {"mensaje": f"¡{tipo_mayuscula} de ${mov.monto} registrado correctamente!"}
    except Exception as e:
        if conexion: conexion.rollback()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

@router.put("/cerrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def cerrar_turno(cierre: CierreCaja, background_tasks: BackgroundTasks):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (cierre.turno_id,))
        turno = cursor.fetchone()
        if not turno: raise Exception("Ese turno no existe o ya fue cerrado.")
            
        fecha_cierre = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) = 'EFECTIVO' AND turno_id = ? AND estado = 'COMPLETADA'", (cierre.turno_id,))
        ventas_efectivo = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%TARJETA%' AND turno_id = ? AND estado = 'COMPLETADA'", (cierre.turno_id,))
        ventas_tarjeta = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%BILLETERA%' AND turno_id = ? AND estado = 'COMPLETADA'", (cierre.turno_id,))
        ventas_virtual = cursor.fetchone()[0] or 0.0    
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) IN ('FIADO', 'CUENTA CORRIENTE') AND turno_id = ? AND estado = 'COMPLETADA'", (cierre.turno_id,))
        ventas_fiados = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'RETIRO' AND turno_id = ?", (cierre.turno_id,))
        total_retiros = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'INGRESO' AND turno_id = ?", (cierre.turno_id,))
        total_ingresos = cursor.fetchone()[0] or 0.0
        
        monto_esperado_sistema = turno['monto_inicial'] + ventas_efectivo + total_ingresos - total_retiros
        diferencia = cierre.monto_final_declarado - monto_esperado_sistema
        
        cursor.execute('''
            UPDATE turnos_caja 
            SET fecha_hora_cierre = ?, monto_final_sistema = ?, monto_final_declarado = ?, diferencia = ?, estado_turno = 'CERRADO'
            WHERE id = ?
        ''', (fecha_cierre, monto_esperado_sistema, cierre.monto_final_declarado, diferencia, cierre.turno_id))
        
        conexion.commit()
        return {
            "mensaje": "¡Cierre Z realizado con éxito!",
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
        if conexion: conexion.rollback()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

@router.get("/informe_x/{turno_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def sacar_informe_x(turno_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT monto_inicial FROM turnos_caja WHERE id = ?", (turno_id,))
        turno = cursor.fetchone()
        if not turno: raise Exception("Turno no encontrado.")
            
        fondo_inicial = turno['monto_inicial']
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) = 'EFECTIVO' AND turno_id = ? AND estado = 'COMPLETADA'", (turno_id,))
        v_efectivo = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%TARJETA%' AND turno_id = ? AND estado = 'COMPLETADA'", (turno_id,))
        v_tarjeta = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%BILLETERA%' AND turno_id = ? AND estado = 'COMPLETADA'", (turno_id,))
        v_virtual = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) IN ('FIADO', 'CUENTA CORRIENTE') AND turno_id = ? AND estado = 'COMPLETADA'", (turno_id,))
        v_fiados = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'RETIRO' AND turno_id = ?", (turno_id,))
        retiros = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'INGRESO' AND turno_id = ?", (turno_id,))
        ingresos = cursor.fetchone()[0] or 0.0
        
        esperado = fondo_inicial + v_efectivo + ingresos - retiros
        
        return {
            "resumen_parcial": {
                "fondo_inicial": fondo_inicial,
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
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()
    
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
        
        for turno in turnos_abiertos:
            turno_id_actual = turno['turno_id']
            cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE metodo_pago = 'EFECTIVO' AND turno_id = ?", (turno_id_actual,))
            ventas_efectivo = cursor.fetchone()[0] or 0.0
            cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE metodo_pago LIKE '%Tarjeta%' AND turno_id = ?", (turno_id_actual,))
            ventas_tarjeta = cursor.fetchone()[0] or 0.0
            cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE metodo_pago LIKE '%Billetera%' AND turno_id = ?", (turno_id_actual,))
            ventas_virtual = cursor.fetchone()[0] or 0.0
            cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'RETIRO' AND turno_id = ?", (turno_id_actual,))
            retiros = cursor.fetchone()[0] or 0.0
            cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'INGRESO' AND turno_id = ?", (turno_id_actual,))
            ingresos = cursor.fetchone()[0] or 0.0
            
            turno['ventas_efectivo'] = ventas_efectivo
            turno['ventas_tarjeta'] = ventas_tarjeta
            turno['ventas_virtual'] = ventas_virtual
            turno['retiros'] = retiros
            turno['ingresos'] = ingresos
            turno['total_esperado'] = turno['monto_inicial'] + ventas_efectivo + ingresos - retiros
            
        return {"turnos_vivos": turnos_abiertos}
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}

@router.get("/estado", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def estado_caja(caja_id: int = 1):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT id, estado_turno 
            FROM turnos_caja 
            WHERE caja_id = ? 
            ORDER BY id DESC LIMIT 1
        ''', (caja_id,))
        turno = cursor.fetchone()
        if turno and turno['estado_turno'] == 'ABIERTO':
            return {"estado": "ABIERTO", "turno_id": turno['id']}
        else:
            return {"estado": "CERRADO"}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()
    
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

@router.post("/cobrar_pedido", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def cobrar_pedido_mayorista(cobro: CobroPedido):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # EL ARREGLO: Ya no buscamos el turno a ciegas, usamos el que mandó el cajero
        cursor.execute("SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (cobro.turno_id,))
        turno_abierto = cursor.fetchone()
        if not turno_abierto: raise Exception("Este turno de caja no está activo o no existe.")
            
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        pagos_a_procesar = cobro.pagos_mixtos if cobro.metodo_pago == 'MIXTO' and cobro.pagos_mixtos else [PagoMixtoCaja(metodo=cobro.metodo_pago, monto=cobro.monto_total)]

        for pago in pagos_a_procesar:
            if pago.monto > 0:
                if pago.metodo != 'CTA_CTE':
                    cursor.execute('''
                        INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
                        VALUES (?, 1, 'INGRESO', ?, ?, ?)
                    ''', (fecha_actual, pago.monto, f"Cobro Pedido Mayorista #{cobro.pedido_id} ({pago.metodo})", cobro.turno_id))
                else:
                    cursor.execute("SELECT cliente_id FROM ventas_cabecera WHERE id = ?", (cobro.pedido_id,))
                    row_pedido = cursor.fetchone()
                    if row_pedido and row_pedido['cliente_id']:
                        cliente_id = row_pedido['cliente_id']
                        cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor + ? WHERE id = ?", (pago.monto, cliente_id))
                        cursor.execute('''
                            INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
                            VALUES (?, ?, 'DEUDA', ?, ?, 1)
                        ''', (cliente_id, fecha_actual, pago.monto, f"Pedido Mayorista #{cobro.pedido_id} (Pago Mixto)"))

        cursor.execute('''
            UPDATE ventas_cabecera 
            SET estado = 'PAGADO_PENDIENTE_ENTREGA', metodo_pago = ? 
            WHERE id = ? AND estado = 'PENDIENTE_PAGO'
        ''', (cobro.metodo_pago, cobro.pedido_id))
        
        if cursor.rowcount == 0: raise Exception("El pedido no existe o ya fue cobrado.")
            
        conexion.commit()
        return {"mensaje": "¡Cobro registrado exitosamente!"}
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()
        
class NuevaCaja(BaseModel):
    id: int 
    nombre: str
    solo_admin: bool

@router.post("/cajas_fisicas/crear", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def crear_caja_fisica(caja: NuevaCaja):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id FROM cajas_fisicas WHERE id = ?", (caja.id,))
        if cursor.fetchone(): raise Exception(f"Ya existe una terminal con el ID {caja.id}. Elegí otro número.")
            
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
        
        nuevo_estado = 0 if caja[0] == 1 else 1
        cursor.execute("UPDATE cajas_fisicas SET activa = ? WHERE id = ?", (nuevo_estado, caja_id))
        conexion.commit()
        return {"mensaje": "Estado de la terminal actualizado.", "nuevo_estado": nuevo_estado}
    except Exception as e:
        if conexion: conexion.rollback()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

@router.get("/cajas_fisicas/admin_listado", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_todas_las_cajas():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT * FROM cajas_fisicas ORDER BY id ASC")
    cajas = [dict(row) for row in cursor.fetchall()]
    conexion.close()
    return {"cajas": cajas}