from fastapi import APIRouter, Query, Depends
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone, timedelta
import sqlite3
from fastapi import BackgroundTasks
import requests
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol
from backend.mod_tesoreria.rutas_tesoreria import mover_tesoreria, crear_pendiente

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


def asegurar_columnas_fondo_turno():
    """fondo_dejado: cambio que el cierre deja en el cajón. fondo_esperado/motivo_apertura:
    lo que el siguiente turno debía encontrar y por qué abrió con otro monto."""
    conexion = obtener_conexion()
    try:
        for col, tipo in (("fondo_dejado", "REAL"), ("fondo_esperado", "REAL"), ("motivo_apertura", "TEXT")):
            try:
                conexion.execute(f"ALTER TABLE turnos_caja ADD COLUMN {col} {tipo}")
            except sqlite3.OperationalError:
                pass
        conexion.commit()
    finally:
        conexion.close()


asegurar_columnas_fondo_turno()


def asegurar_tabla_retiros_dueno():
    conexion = obtener_conexion()
    try:
        conexion.execute('''
            CREATE TABLE IF NOT EXISTS retiros_dueno (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha_hora TEXT NOT NULL,
                monto REAL NOT NULL,
                origen TEXT NOT NULL,
                motivo TEXT,
                usuario_id INTEGER,
                autorizado_por TEXT,
                turno_id INTEGER,
                movimiento_caja_id INTEGER,
                estado TEXT NOT NULL DEFAULT 'ACTIVO',
                anulado_en TEXT,
                anulado_por INTEGER
            )
        ''')
        conexion.execute("CREATE INDEX IF NOT EXISTS idx_retiros_dueno_fecha ON retiros_dueno (fecha_hora)")
        conexion.commit()
    finally:
        conexion.close()


asegurar_tabla_retiros_dueno()

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

# Retiro del dueño: plata que sale del negocio. No es gasto (no toca la ganancia) ni sangría (la sangría queda en el negocio).
ORIGENES_RETIRO_DUENO = {
    "CAJON": "Cajón del mostrador",
    "CAJA_FUERTE": "Caja fuerte",
    "MERCADOPAGO": "Mercado Pago del negocio",
    "BANCO": "Banco del negocio",
}

def _sumar_medio(cursor, turno_id, patron):
    """Cobrado y comisión: ventas de un solo medio más cada pata de un mixto. No toca el efectivo del cajón."""
    cursor.execute(
        """
        SELECT IFNULL(SUM(total_venta), 0), IFNULL(SUM(IFNULL(comision_medio, 0)), 0)
        FROM ventas_cabecera
        WHERE UPPER(metodo_pago) LIKE ? AND turno_id = ? AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
        """,
        (patron, turno_id),
    )
    bruto, comision = cursor.fetchone()
    mixto_bruto, mixto_comision = 0.0, 0.0
    try:
        cursor.execute(
            """
            SELECT IFNULL(SUM(m.monto), 0), IFNULL(SUM(IFNULL(m.comision, 0)), 0)
            FROM ventas_pagos_mixtos m
            JOIN ventas_cabecera c ON c.id = m.venta_id
            WHERE UPPER(m.metodo_pago) LIKE ? AND c.turno_id = ? AND c.estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
            """,
            (patron, turno_id),
        )
        mixto_bruto, mixto_comision = cursor.fetchone()
    except sqlite3.OperationalError:
        pass
    return float(bruto or 0) + float(mixto_bruto or 0), float(comision or 0) + float(mixto_comision or 0)


def _fiado_mixto(cursor, turno_id):
    try:
        cursor.execute(
            """
            SELECT IFNULL(SUM(m.monto), 0)
            FROM ventas_pagos_mixtos m
            JOIN ventas_cabecera c ON c.id = m.venta_id
            WHERE UPPER(m.metodo_pago) IN ('FIADO', 'CUENTA CORRIENTE', 'CTA_CTE')
              AND c.turno_id = ?
              AND c.estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
            """,
            (turno_id,),
        )
        return float(cursor.fetchone()[0] or 0)
    except sqlite3.OperationalError:
        return 0.0


def _sumar_transferencias(cursor, turno_id):
    bruto, _comision = _sumar_medio(cursor, turno_id, "%TRANSFERENCIA%")
    return bruto


def _detalle_retiros_turno(cursor, turno_id):
    cursor.execute(
        '''
        SELECT monto, IFNULL(observaciones, '') AS obs
        FROM movimientos_caja
        WHERE tipo_movimiento = 'RETIRO' AND turno_id = ?
        ORDER BY id ASC
        ''',
        (turno_id,),
    )
    return [{"monto": row["monto"] or 0, "obs": row["obs"] or ""} for row in cursor.fetchall()]


def _horas_abierto(fecha_apertura, fecha_cierre):
    try:
        a = datetime.strptime(str(fecha_apertura)[:19], "%Y-%m-%d %H:%M:%S")
        c = datetime.strptime(str(fecha_cierre)[:19], "%Y-%m-%d %H:%M:%S")
        return max((c - a).total_seconds() / 3600.0, 0)
    except (TypeError, ValueError):
        return 0.0


def disparar_avisos_cierre(payload_z, fecha_apertura, fecha_cierre, cajero, turno_id, solo_admin=False):
    from backend.whatsapp_puente import avisar_cierre_z, avisar_faltantes_del_turno
    if solo_admin:
        print("WhatsApp puente: caja solo_admin, Cierre Z y faltantes omitidos.")
        return
    avisar_cierre_z(payload_z)
    if _horas_abierto(fecha_apertura, fecha_cierre) > 20:
        print("WhatsApp puente: turno de más de 20 h, digest de faltantes omitido.")
        return
    avisar_faltantes_del_turno(turno_id, fecha_apertura, fecha_cierre, cajero)

class AperturaCaja(BaseModel):
    caja_id: int = 1
    usuario_id: int = 1 
    monto_inicial: float
    motivo_diferencia: Optional[str] = None

class MovimientoCaja(BaseModel):
    usuario_id: int = 1
    tipo_movimiento: str 
    monto: float
    observaciones: str
    turno_id: int
    es_sangria: Optional[bool] = False  # <-- NUEVO: True = Retiro físico/tesorería (NO es Gasto Operativo)

class CierreCaja(BaseModel):
    turno_id: int
    monto_final_declarado: float 
    # Cambio que queda en el cajón. None = pantalla vieja o cierre forzado: no arma sobre.
    fondo_dejado: Optional[float] = None
    
@router.get("/cajas_fisicas")
def listar_cajas_fisicas(payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    rol = ((payload or {}).get("rol") or "").upper()
    if rol == "CAJERO":
        cursor.execute(
            "SELECT id, nombre, IFNULL(solo_admin, 0) AS solo_admin FROM cajas_fisicas WHERE activa = 1 AND IFNULL(solo_admin, 0) = 0 ORDER BY id ASC"
        )
    else:
        cursor.execute(
            "SELECT id, nombre, IFNULL(solo_admin, 0) AS solo_admin FROM cajas_fisicas WHERE activa = 1 ORDER BY id ASC"
        )
    cajas = [dict(row) for row in cursor.fetchall()]
    conexion.close()
    return {"cajas": cajas}

@router.post("/abrir", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def abrir_turno(apertura: AperturaCaja, background_tasks: BackgroundTasks):
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

        if apertura.monto_inicial is None or apertura.monto_inicial < 0:
            raise Exception("El monto inicial no puede ser negativo.")

        # Conteo a ciegas: el cajero no ve lo que dejó el cierre anterior. Si no coincide,
        # recuenta o explica; el dueño recibe los dos números.
        cursor.execute('''
            SELECT id, fondo_dejado FROM turnos_caja
            WHERE caja_id = ? AND estado_turno = 'CERRADO' ORDER BY id DESC LIMIT 1
        ''', (apertura.caja_id,))
        anterior = cursor.fetchone()
        fondo_esperado = None
        motivo = " ".join((apertura.motivo_diferencia or "").split())[:200]
        if anterior and anterior[1] is not None:
            fondo_esperado = round(float(anterior[1]), 2)
            if abs(round(apertura.monto_inicial, 2) - fondo_esperado) >= 0.01:
                if len(motivo) < 3:
                    return {
                        "error": "Lo que contaste no coincide con el cambio que dejó el turno anterior. "
                                 "Volvé a contar; si está bien, escribí el motivo.",
                        "requiere_motivo": True,
                    }
            else:
                motivo = ""

        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute('''
            INSERT INTO turnos_caja (caja_id, usuario_id, fecha_hora_apertura, monto_inicial, estado_turno, fondo_esperado, motivo_apertura)
            VALUES (?, ?, ?, ?, 'ABIERTO', ?, ?)
        ''', (apertura.caja_id, apertura.usuario_id, fecha_actual, apertura.monto_inicial, fondo_esperado, motivo or None))
        
        turno_id = cursor.lastrowid
        conexion.commit()
        if motivo and not caja_fisica[2]:
            from backend.whatsapp_puente import enviar_whatsapp, nombre_usuario
            background_tasks.add_task(
                enviar_whatsapp,
                f"Apertura con diferencia\n{caja_fisica[0]} - turno #{turno_id}\n"
                f"Quién: {nombre_usuario(apertura.usuario_id)}\n"
                f"El turno anterior (#{anterior[0]}) dejó: ${fondo_esperado:,.2f}\n"
                f"Contó: ${apertura.monto_inicial:,.2f}\n"
                f"Motivo: {motivo}",
            )
        return {"mensaje": f"¡Turno de caja #{turno_id} abierto con éxito!", "turno_id": turno_id}
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

@router.post("/movimiento")
def registrar_movimiento(mov: MovimientoCaja, background_tasks: BackgroundTasks,
                         sesion: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        mov.usuario_id = _usuario_de(sesion) or mov.usuario_id
        if not mov.monto or mov.monto <= 0:
            raise Exception("El monto tiene que ser mayor a 0.")
        cursor.execute("SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (mov.turno_id,))
        if not cursor.fetchone(): raise Exception("El turno especificado no está abierto.")
            
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        # EL SELLO DE SEGURIDAD: Limpiamos espacios y forzamos mayúsculas
        tipo_mayuscula = mov.tipo_movimiento.strip().upper()

        # ETIQUETA DE TESORERÍA: si es Sangría física, lo marcamos clarito en la
        # observación para diferenciarlo en la Auditoría de Turno de un retiro por Gasto Operativo.
        observacion_final = mov.observaciones
        if tipo_mayuscula == 'RETIRO' and mov.es_sangria:
            observacion_final = f"[SANGRÍA/RETIRO FÍSICO] {mov.observaciones}"
        
        cursor.execute('''
            INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (fecha_actual, mov.usuario_id, tipo_mayuscula, mov.monto, observacion_final, mov.turno_id))
        if tipo_mayuscula == 'RETIRO' and mov.es_sangria:
            concepto = f"Sangría turno #{mov.turno_id}: {mov.observaciones or ''}".strip()
            # Solo el dueño suma directo: lo de otro queda por recibir hasta que él lo cuente.
            if _rol_de(sesion) == "ADMIN":
                mover_tesoreria(cursor, "CAJA_FUERTE", mov.monto, concepto, "SANGRIA", cursor.lastrowid, mov.usuario_id)
            else:
                crear_pendiente(cursor, "CAJA_FUERTE", mov.monto, concepto, "SANGRIA", cursor.lastrowid,
                                mov.turno_id, mov.usuario_id)

        conexion.commit()
        if tipo_mayuscula == 'RETIRO':
            from backend.whatsapp_puente import avisar_retiro, nombre_usuario
            background_tasks.add_task(
                avisar_retiro,
                mov.monto,
                observacion_final or "Retiro",
                nombre_usuario(mov.usuario_id),
                mov.turno_id,
            )
        return {"mensaje": f"¡{tipo_mayuscula} de ${mov.monto} registrado correctamente!"}
    except Exception as e:
        if conexion: conexion.rollback()
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

class RetiroDueno(BaseModel):
    monto: float
    origen: str
    motivo: Optional[str] = ""
    turno_id: Optional[int] = None
    autorizado_por: Optional[str] = None


def _usuario_de(sesion):
    try:
        return int((sesion or {}).get("sub"))
    except (TypeError, ValueError):
        return None


def _rol_de(sesion):
    return ((sesion or {}).get("rol") or "").upper()


@router.post("/retiro_dueno")
def registrar_retiro_dueno(body: RetiroDueno, background_tasks: BackgroundTasks,
                           sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        monto = round(float(body.monto or 0), 2)
        if monto <= 0.009:
            raise Exception("El monto del retiro tiene que ser mayor a 0.")
        origen = (body.origen or "").strip().upper()
        if origen not in ORIGENES_RETIRO_DUENO:
            raise Exception("Origen de retiro inválido.")
        motivo = " ".join((body.motivo or "").split())[:200] or "Retiro del dueño"
        usuario_id = _usuario_de(sesion)
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

        turno_id = None
        movimiento_id = None
        if origen == "CAJON":
            if not body.turno_id:
                raise Exception("Abrí un turno de caja para retirar del cajón.")
            cursor.execute("SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (body.turno_id,))
            if not cursor.fetchone():
                raise Exception("El turno de caja está cerrado.")
            turno_id = body.turno_id
            cursor.execute('''
                INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
                VALUES (?, ?, 'RETIRO', ?, ?, ?)
            ''', (fecha_actual, usuario_id, monto, f"[RETIRO DUEÑO] {motivo}", turno_id))
            movimiento_id = cursor.lastrowid

        cursor.execute('''
            INSERT INTO retiros_dueno (fecha_hora, monto, origen, motivo, usuario_id, autorizado_por, turno_id, movimiento_caja_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (fecha_actual, monto, origen, motivo, usuario_id, (body.autorizado_por or "")[:100] or None, turno_id, movimiento_id))
        retiro_id = cursor.lastrowid
        if origen == "CAJA_FUERTE":
            mover_tesoreria(cursor, "CAJA_FUERTE", -monto, f"Retiro del dueño: {motivo}", "RETIRO_DUENO", retiro_id, usuario_id)
        conexion.commit()

        if origen == "CAJON":
            from backend.whatsapp_puente import avisar_retiro, nombre_usuario
            background_tasks.add_task(
                avisar_retiro, monto, f"[RETIRO DUEÑO] {motivo}", nombre_usuario(usuario_id), turno_id,
            )
        return {"mensaje": f"Retiro del dueño de ${monto:,.2f} registrado.", "id": retiro_id}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/retiros_dueno", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_retiros_dueno(mes: Optional[str] = None):
    mes = (mes or datetime.now(ZONA_AR).strftime("%Y-%m"))[:7]
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        filas = conexion.execute('''
            SELECT id, fecha_hora, monto, origen, motivo, autorizado_por, turno_id, estado
            FROM retiros_dueno
            WHERE strftime('%Y-%m', fecha_hora) = ?
            ORDER BY fecha_hora DESC, id DESC
        ''', (mes,)).fetchall()
        retiros = []
        total = 0.0
        por_origen = {}
        for f in filas:
            r = dict(f)
            r["origen_texto"] = ORIGENES_RETIRO_DUENO.get(r["origen"], r["origen"])
            if r["estado"] == "ACTIVO":
                total += float(r["monto"] or 0)
                por_origen[r["origen"]] = round(por_origen.get(r["origen"], 0) + float(r["monto"] or 0), 2)
            retiros.append(r)
        return {"mes": mes, "total": round(total, 2), "por_origen": por_origen, "retiros": retiros}
    finally:
        conexion.close()


@router.put("/retiro_dueno/{retiro_id}/anular")
def anular_retiro_dueno(retiro_id: int, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        r = cursor.execute("SELECT * FROM retiros_dueno WHERE id = ?", (retiro_id,)).fetchone()
        if not r:
            raise Exception("Ese retiro no existe.")
        if r["estado"] != "ACTIVO":
            raise Exception("Ese retiro ya está anulado.")
        usuario_id = _usuario_de(sesion)
        ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        if r["origen"] == "CAJON":
            turno = cursor.execute(
                "SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (r["turno_id"],)
            ).fetchone()
            if not turno:
                raise Exception("El turno de ese retiro ya cerró: el cierre Z ya lo contó. Corregilo con un ingreso en la caja.")
            cursor.execute('''
                INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
                VALUES (?, ?, 'INGRESO', ?, ?, ?)
            ''', (ahora, usuario_id, r["monto"], f"[ANULA RETIRO DUEÑO #{retiro_id}]", r["turno_id"]))
        elif r["origen"] == "CAJA_FUERTE":
            mover_tesoreria(cursor, "CAJA_FUERTE", r["monto"], f"Anula retiro del dueño #{retiro_id}", "ANULACION", retiro_id, usuario_id)
        cursor.execute(
            "UPDATE retiros_dueno SET estado = 'ANULADO', anulado_en = ?, anulado_por = ? WHERE id = ?",
            (ahora, usuario_id, retiro_id),
        )
        conexion.commit()
        return {"mensaje": "Retiro anulado."}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.put("/cerrar")
def cerrar_turno(cierre: CierreCaja, background_tasks: BackgroundTasks,
                 sesion: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (cierre.turno_id,))
        turno = cursor.fetchone()
        if not turno: raise Exception("Ese turno no existe o ya fue cerrado.")

        fondo_dejado = None
        a_guardar = 0.0
        if cierre.fondo_dejado is not None:
            fondo_dejado = round(float(cierre.fondo_dejado), 2)
            if fondo_dejado < 0:
                raise Exception("El cambio que queda no puede ser negativo.")
            if fondo_dejado - cierre.monto_final_declarado > 0.009:
                raise Exception("El cambio que queda no puede ser más de lo que contaste.")
            a_guardar = round(cierre.monto_final_declarado - fondo_dejado, 2)
            
        fecha_cierre = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) = 'EFECTIVO' AND turno_id = ? AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')", (cierre.turno_id,))
        ventas_efectivo = cursor.fetchone()[0] or 0.0
        
        ventas_tarjeta, comision_tarjeta = _sumar_medio(cursor, cierre.turno_id, "%TARJETA%")
        ventas_qr, comision_qr = _sumar_medio(cursor, cierre.turno_id, "%QR%")
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%BILLETERA%' AND turno_id = ? AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')", (cierre.turno_id,))
        ventas_virtual = cursor.fetchone()[0] or 0.0    
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) IN ('FIADO', 'CUENTA CORRIENTE') AND turno_id = ? AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')", (cierre.turno_id,))
        ventas_fiados = cursor.fetchone()[0] or 0.0
        ventas_fiados += _fiado_mixto(cursor, cierre.turno_id)
        ventas_transferencia = _sumar_transferencias(cursor, cierre.turno_id)
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'RETIRO' AND turno_id = ?", (cierre.turno_id,))
        total_retiros = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'INGRESO' AND turno_id = ?", (cierre.turno_id,))
        total_ingresos = cursor.fetchone()[0] or 0.0
        
        monto_esperado_sistema = turno['monto_inicial'] + ventas_efectivo + total_ingresos - total_retiros
        diferencia = cierre.monto_final_declarado - monto_esperado_sistema
        
        cursor.execute('''
            UPDATE turnos_caja 
            SET fecha_hora_cierre = ?, monto_final_sistema = ?, monto_final_declarado = ?, diferencia = ?, estado_turno = 'CERRADO',
                fondo_dejado = ?
            WHERE id = ?
        ''', (fecha_cierre, monto_esperado_sistema, cierre.monto_final_declarado, diferencia, fondo_dejado, cierre.turno_id))

        # Lo que no queda de cambio sale del cajón. Si cierra el dueño, él lo contó: entra a la
        # caja fuerte. Si cierra otro, es un sobre por recibir hasta que el dueño lo cuente.
        destino_guardado = None
        if a_guardar >= 0.01:
            concepto = f"Cierre turno #{cierre.turno_id}"
            if _rol_de(sesion) == "ADMIN":
                mover_tesoreria(cursor, "CAJA_FUERTE", a_guardar, concepto, "CIERRE_TURNO", cierre.turno_id, _usuario_de(sesion))
                destino_guardado = "CAJA_FUERTE"
            else:
                crear_pendiente(cursor, "CAJA_FUERTE", a_guardar, concepto, "CIERRE_TURNO", cierre.turno_id,
                                cierre.turno_id, _usuario_de(sesion) or turno['usuario_id'])
                destino_guardado = "POR_RECIBIR"

        cursor.execute("SELECT nombre_completo FROM usuarios WHERE id = ?", (turno['usuario_id'],))
        fila_cajero = cursor.fetchone()
        nombre_cajero = fila_cajero['nombre_completo'] if fila_cajero else f"Usuario #{turno['usuario_id']}"
        detalle_retiros = _detalle_retiros_turno(cursor, cierre.turno_id)
        fecha_apertura = turno['fecha_hora_apertura']
        cursor.execute("SELECT IFNULL(solo_admin, 0) FROM cajas_fisicas WHERE id = ?", (turno["caja_id"],))
        fila_caja = cursor.fetchone()
        solo_admin = bool(fila_caja[0]) if fila_caja else False
        
        conexion.commit()
        payload_z = {
            "turno_id": cierre.turno_id,
            "cajero": nombre_cajero,
            "fondo_inicial": turno['monto_inicial'],
            "ventas_efectivo": ventas_efectivo,
            "ventas_tarjeta": ventas_tarjeta,
            "comision_tarjeta": comision_tarjeta,
            "neto_tarjeta": round(ventas_tarjeta - comision_tarjeta, 2),
            "ventas_qr": ventas_qr,
            "comision_qr": comision_qr,
            "neto_qr": round(ventas_qr - comision_qr, 2),
            "ventas_transferencia": ventas_transferencia,
            "ventas_virtual": ventas_virtual,
            "ventas_fiados": ventas_fiados,
            "ingresos": total_ingresos,
            "retiros": total_retiros,
            "detalle_retiros": detalle_retiros,
            "esperado": monto_esperado_sistema,
            "declarado": cierre.monto_final_declarado,
            "diferencia": diferencia,
            "queda_de_cambio": fondo_dejado,
            "a_guardar": a_guardar,
            "destino_guardado": destino_guardado,
        }
        background_tasks.add_task(
            disparar_avisos_cierre,
            payload_z,
            fecha_apertura,
            fecha_cierre,
            nombre_cajero,
            cierre.turno_id,
            solo_admin,
        )
        return {
            "mensaje": "¡Cierre Z realizado con éxito!",
            "resumen": {
                "fondo_inicial": turno['monto_inicial'],
                "ventas_en_efectivo": ventas_efectivo,
                "ventas_tarjeta": ventas_tarjeta,
                "comision_tarjeta": comision_tarjeta,
                "neto_tarjeta": round(ventas_tarjeta - comision_tarjeta, 2),
                "ventas_qr": ventas_qr,
                "comision_qr": comision_qr,
                "neto_qr": round(ventas_qr - comision_qr, 2),
                "ventas_virtual": ventas_virtual,
                "ventas_transferencia": ventas_transferencia,
                "ventas_fiados": ventas_fiados,
                "ingresos_extras": total_ingresos,
                "retiros_y_gastos": total_retiros,
                "sistema_esperaba": monto_esperado_sistema,
                "vos_declaraste": cierre.monto_final_declarado,
                "diferencia": diferencia,
                "queda_de_cambio": fondo_dejado,
                "a_guardar": a_guardar if fondo_dejado is not None else None,
                "destino_guardado": destino_guardado,
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
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) = 'EFECTIVO' AND turno_id = ? AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')", (turno_id,))
        v_efectivo = cursor.fetchone()[0] or 0.0
        
        v_tarjeta, comision_tarjeta = _sumar_medio(cursor, turno_id, "%TARJETA%")
        v_qr, comision_qr = _sumar_medio(cursor, turno_id, "%QR%")
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) LIKE '%BILLETERA%' AND turno_id = ? AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')", (turno_id,))
        v_virtual = cursor.fetchone()[0] or 0.0
        
        cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE UPPER(metodo_pago) IN ('FIADO', 'CUENTA CORRIENTE') AND turno_id = ? AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')", (turno_id,))
        v_fiados = cursor.fetchone()[0] or 0.0
        v_fiados += _fiado_mixto(cursor, turno_id)
        v_transferencia = _sumar_transferencias(cursor, turno_id)
        
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
                "comision_tarjeta": comision_tarjeta,
                "neto_tarjeta": round(v_tarjeta - comision_tarjeta, 2),
                "ventas_qr": v_qr,
                "comision_qr": comision_qr,
                "neto_qr": round(v_qr - comision_qr, 2),
                "ventas_virtual": v_virtual,
                "ventas_transferencia": v_transferencia,
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
    
@router.get("/monitor_vivo", dependencies=[Depends(VerificarRol(["ADMIN"]))])
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
            cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE metodo_pago = 'EFECTIVO' AND turno_id = ? AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')", (turno_id_actual,))
            ventas_efectivo = cursor.fetchone()[0] or 0.0
            ventas_tarjeta, _comision_tarjeta = _sumar_medio(cursor, turno_id_actual, "%TARJETA%")
            ventas_qr, _comision_qr = _sumar_medio(cursor, turno_id_actual, "%QR%")
            cursor.execute("SELECT SUM(total_venta) FROM ventas_cabecera WHERE metodo_pago LIKE '%Billetera%' AND turno_id = ?", (turno_id_actual,))
            ventas_virtual = cursor.fetchone()[0] or 0.0
            cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'RETIRO' AND turno_id = ?", (turno_id_actual,))
            retiros = cursor.fetchone()[0] or 0.0
            cursor.execute("SELECT SUM(monto) FROM movimientos_caja WHERE tipo_movimiento = 'INGRESO' AND turno_id = ?", (turno_id_actual,))
            ingresos = cursor.fetchone()[0] or 0.0
            
            turno['ventas_efectivo'] = ventas_efectivo
            turno['ventas_tarjeta'] = ventas_tarjeta
            turno['ventas_qr'] = ventas_qr
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
    from backend.mod_venta_deposito.rutas_deposito import liquidar_pedido_mayorista

    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        if cobro.metodo_pago == "MIXTO" and cobro.pagos_mixtos:
            pagos = [{"metodo": p.metodo, "monto": p.monto} for p in cobro.pagos_mixtos]
        else:
            cursor.execute("SELECT total_venta FROM ventas_cabecera WHERE id = ?", (cobro.pedido_id,))
            pedido = cursor.fetchone()
            if not pedido:
                raise Exception("El documento no existe.")
            pagos = [{"metodo": cobro.metodo_pago, "monto": pedido["total_venta"]}]
        resultado = liquidar_pedido_mayorista(cursor, cobro.pedido_id, pagos, "CAJA", cobro.turno_id)
        conexion.commit()
        return resultado
    except Exception as e:
        if conexion: conexion.rollback()
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

# --- 1. AUDITORÍA DE TURNO ARREGLADA (CON NOMBRE DE CAJERO) ---
@router.get("/auditoria/{turno_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def auditar_turno(turno_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        linea_tiempo = []

        # Atrapamos el turno y el nombre del cajero
        cursor.execute('''
            SELECT t.fecha_hora_apertura, t.monto_inicial, u.nombre_completo as cajero
            FROM turnos_caja t
            LEFT JOIN usuarios u ON t.usuario_id = u.id
            WHERE t.id = ?
        ''', (turno_id,))
        turno = cursor.fetchone()
        nombre_cajero = turno['cajero'] if turno and turno['cajero'] else "Cajero Desconocido"

        if turno:
            linea_tiempo.append({
                "fecha_hora_cruda": turno['fecha_hora_apertura'],
                "hora": turno['fecha_hora_apertura'][11:16] if turno['fecha_hora_apertura'] else "-",
                "tipo": "APERTURA",
                "accion": "Apertura de Caja",
                "detalle": f"Fondo inicial - Abrió: {nombre_cajero}",
                "metodo": "EFECTIVO",
                "monto": turno['monto_inicial']
            })

        cursor.execute('''
            SELECT v.id, v.fecha_hora, v.metodo_pago, v.total_venta, v.estado,
                   COALESCE(NULLIF(TRIM(c.nombre_completo), ''), NULLIF(TRIM(v.nombre_cliente_factura), '')) AS nombre_cliente
            FROM ventas_cabecera v
            LEFT JOIN clientes c ON c.id = v.cliente_id
            WHERE v.turno_id = ?
        ''', (turno_id,))
        for v in cursor.fetchall():
            estado_str = "VENTA ANULADA" if v['estado'] == 'ANULADA' else "VENTA"
            metodo = (v['metodo_pago'] or '').upper()
            nombre_fiado = (v['nombre_cliente'] or '').strip()
            if metodo in ('FIADO', 'CUENTA CORRIENTE') and nombre_fiado:
                detalle_venta = f"Fiado a {nombre_fiado} · Cobró: {nombre_cajero}"
            else:
                detalle_venta = f"Venta de mostrador - Cobró: {nombre_cajero}"
            linea_tiempo.append({
                "fecha_hora_cruda": v['fecha_hora'],
                "hora": v['fecha_hora'][11:16] if v['fecha_hora'] else "-",
                "tipo": estado_str,
                "accion": f"Ticket #{v['id']}",
                "detalle": detalle_venta,
                "metodo": v['metodo_pago'],
                "monto": v['total_venta']
            })

        cursor.execute('''
            SELECT fecha_hora, tipo_movimiento, monto, observaciones 
            FROM movimientos_caja 
            WHERE turno_id = ?
        ''', (turno_id,))
        for m in cursor.fetchall():
            linea_tiempo.append({
                "fecha_hora_cruda": m['fecha_hora'],
                "hora": m['fecha_hora'][11:16] if m['fecha_hora'] else "-",
                "tipo": m['tipo_movimiento'].upper(),
                "accion": m['tipo_movimiento'].upper() + " DE CAJA",
                "detalle": m['observaciones'],
                "metodo": "EFECTIVO",
                "monto": m['monto']
            })

        linea_tiempo.sort(key=lambda x: x['fecha_hora_cruda'], reverse=True)
        # Devolvemos también el nombre del cajero al frontend
        return {"linea_tiempo": linea_tiempo, "cajero": nombre_cajero}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()

# --- 2. RUTA NUEVA: BUSCAR TURNOS POR FECHA ---
@router.get("/turnos_por_fecha", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def obtener_turnos_por_fecha(fecha: str):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT t.id as turno_id, t.caja_id, t.fecha_hora_apertura, t.fecha_hora_cierre, 
                   t.monto_final_declarado, t.diferencia, t.estado_turno, 
                   u.nombre_completo as cajero
            FROM turnos_caja t
            LEFT JOIN usuarios u ON t.usuario_id = u.id
            WHERE date(t.fecha_hora_apertura) = ? OR date(t.fecha_hora_cierre) = ?
            ORDER BY t.id DESC
        ''', (fecha, fecha))
        turnos = [dict(t) for t in cursor.fetchall()]
        return {"turnos": turnos}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conexion: conexion.close()