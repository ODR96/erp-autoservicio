from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone, timedelta
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

CUENTAS = {
    "CAJA_FUERTE": "Caja fuerte",
}


def asegurar_tablas_tesoreria_cuentas():
    conexion = obtener_conexion()
    try:
        # Libro de movimientos: el saldo es la suma, nunca un número que se pisa.
        # monto con signo: positivo entra, negativo sale.
        conexion.execute('''
            CREATE TABLE IF NOT EXISTS tesoreria_movimientos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha_hora TEXT NOT NULL,
                cuenta TEXT NOT NULL,
                monto REAL NOT NULL,
                concepto TEXT NOT NULL,
                origen_tipo TEXT NOT NULL,
                origen_id INTEGER,
                usuario_id INTEGER
            )
        ''')
        conexion.execute("CREATE INDEX IF NOT EXISTS idx_tes_mov_cuenta ON tesoreria_movimientos (cuenta, fecha_hora)")
        conexion.execute('''
            CREATE TABLE IF NOT EXISTS tesoreria_arqueos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha_hora TEXT NOT NULL,
                cuenta TEXT NOT NULL,
                saldo_sistema REAL NOT NULL,
                monto_contado REAL NOT NULL,
                diferencia REAL NOT NULL,
                motivo TEXT,
                usuario_id INTEGER
            )
        ''')
        # Plata declarada por alguien que no es el dueño (sobre de cierre, sangría del cajero).
        # No suma a la cuenta hasta que el dueño la cuenta: entra lo contado, no lo declarado.
        conexion.execute('''
            CREATE TABLE IF NOT EXISTS tesoreria_pendientes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha_hora TEXT NOT NULL,
                cuenta TEXT NOT NULL,
                monto_declarado REAL NOT NULL,
                concepto TEXT NOT NULL,
                origen_tipo TEXT NOT NULL,
                origen_id INTEGER,
                turno_id INTEGER,
                usuario_id INTEGER,
                estado TEXT NOT NULL DEFAULT 'PENDIENTE',
                recibido_en TEXT,
                recibido_por INTEGER,
                monto_contado REAL,
                diferencia REAL,
                nota TEXT,
                movimiento_id INTEGER
            )
        ''')
        conexion.execute("CREATE INDEX IF NOT EXISTS idx_tes_pend_estado ON tesoreria_pendientes (estado, fecha_hora)")
        conexion.commit()
    finally:
        conexion.close()


asegurar_tablas_tesoreria_cuentas()


class ErrorTesoreria(Exception):
    pass


def saldo_cuenta(cursor, cuenta: str) -> float:
    fila = cursor.execute(
        "SELECT IFNULL(SUM(monto), 0) FROM tesoreria_movimientos WHERE cuenta = ?", (cuenta,)
    ).fetchone()
    return round(float(fila[0] or 0), 2)


def cuenta_inicializada(cursor, cuenta: str) -> bool:
    return cursor.execute(
        "SELECT 1 FROM tesoreria_arqueos WHERE cuenta = ? LIMIT 1", (cuenta,)
    ).fetchone() is not None


def mover_tesoreria(cursor, cuenta: str, monto: float, concepto: str, origen_tipo: str,
                    origen_id=None, usuario_id=None):
    """Asienta en el cursor del llamador (misma transacción). monto > 0 entra, < 0 sale.
    Hasta el primer arqueo el saldo no es confiable, así que no frena salidas."""
    if cuenta not in CUENTAS:
        raise ErrorTesoreria("Cuenta de tesorería inválida.")
    monto = round(float(monto or 0), 2)
    if abs(monto) < 0.01:
        return None
    if monto < 0 and cuenta_inicializada(cursor, cuenta):
        saldo = saldo_cuenta(cursor, cuenta)
        if saldo + monto < -0.009:
            raise ErrorTesoreria(
                f"La {CUENTAS[cuenta].lower()} tiene ${saldo:,.2f} según el sistema y querés sacar ${-monto:,.2f}. "
                f"Si en realidad hay más, hacé un arqueo en Tesorería."
            )
    cursor.execute('''
        INSERT INTO tesoreria_movimientos (fecha_hora, cuenta, monto, concepto, origen_tipo, origen_id, usuario_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S"), cuenta, monto, (concepto or "")[:200],
          origen_tipo, origen_id, usuario_id))
    return cursor.lastrowid


def crear_pendiente(cursor, cuenta: str, monto: float, concepto: str, origen_tipo: str,
                    origen_id=None, turno_id=None, usuario_id=None):
    """Misma transacción que el llamador. No toca el saldo: queda por recibir."""
    if cuenta not in CUENTAS:
        raise ErrorTesoreria("Cuenta de tesorería inválida.")
    monto = round(float(monto or 0), 2)
    if monto < 0.01:
        return None
    cursor.execute('''
        INSERT INTO tesoreria_pendientes (fecha_hora, cuenta, monto_declarado, concepto, origen_tipo, origen_id, turno_id, usuario_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S"), cuenta, monto, (concepto or "")[:200],
          origen_tipo, origen_id, turno_id, usuario_id))
    return cursor.lastrowid


def _usuario_de(sesion):
    try:
        return int((sesion or {}).get("sub"))
    except (TypeError, ValueError):
        return None


@router.get("/cuenta/{cuenta}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def estado_cuenta(cuenta: str, limite: int = 50):
    cuenta = (cuenta or "").upper()
    if cuenta not in CUENTAS:
        raise HTTPException(status_code=404, detail="Cuenta de tesorería inválida.")
    limite = max(1, min(int(limite or 50), 300))
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        cursor = conexion.cursor()
        ultimo = cursor.execute(
            "SELECT fecha_hora, saldo_sistema, monto_contado, diferencia, motivo FROM tesoreria_arqueos "
            "WHERE cuenta = ? ORDER BY id DESC LIMIT 1", (cuenta,)
        ).fetchone()
        movimientos = cursor.execute('''
            SELECT id, fecha_hora, monto, concepto, origen_tipo
            FROM tesoreria_movimientos WHERE cuenta = ?
            ORDER BY fecha_hora DESC, id DESC LIMIT ?
        ''', (cuenta, limite)).fetchall()
        por_recibir = cursor.execute(
            "SELECT COUNT(*), IFNULL(SUM(monto_declarado), 0) FROM tesoreria_pendientes WHERE cuenta = ? AND estado = 'PENDIENTE'",
            (cuenta,),
        ).fetchone()
        return {
            "cuenta": cuenta,
            "nombre": CUENTAS[cuenta],
            "saldo": saldo_cuenta(cursor, cuenta),
            "por_recibir": {"cantidad": por_recibir[0], "total": round(float(por_recibir[1] or 0), 2)},
            "inicializada": ultimo is not None,
            "ultimo_arqueo": dict(ultimo) if ultimo else None,
            "movimientos": [dict(m) for m in movimientos],
        }
    finally:
        conexion.close()


class Arqueo(BaseModel):
    cuenta: str = "CAJA_FUERTE"
    monto_contado: float
    motivo: Optional[str] = ""


@router.post("/arqueo")
def registrar_arqueo(body: Arqueo, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    cuenta = (body.cuenta or "").upper()
    if cuenta not in CUENTAS:
        raise HTTPException(status_code=400, detail="Cuenta de tesorería inválida.")
    contado = round(float(body.monto_contado or 0), 2)
    if contado < 0:
        raise HTTPException(status_code=400, detail="Lo contado no puede ser negativo.")
    motivo = " ".join((body.motivo or "").split())[:200]
    usuario_id = _usuario_de(sesion)

    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        primero = not cuenta_inicializada(cursor, cuenta)
        saldo = saldo_cuenta(cursor, cuenta)
        diferencia = round(contado - saldo, 2)
        if abs(diferencia) >= 0.01 and not primero and len(motivo) < 5:
            raise HTTPException(status_code=400, detail="Hay diferencia: escribí el motivo (5 letras o más).")
        if primero and not motivo:
            motivo = "Saldo inicial"
        ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute('''
            INSERT INTO tesoreria_arqueos (fecha_hora, cuenta, saldo_sistema, monto_contado, diferencia, motivo, usuario_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (ahora, cuenta, saldo, contado, diferencia, motivo or None, usuario_id))
        arqueo_id = cursor.lastrowid
        if abs(diferencia) >= 0.01:
            cursor.execute('''
                INSERT INTO tesoreria_movimientos (fecha_hora, cuenta, monto, concepto, origen_tipo, origen_id, usuario_id)
                VALUES (?, ?, ?, ?, 'ARQUEO', ?, ?)
            ''', (ahora, cuenta, diferencia, f"Ajuste de arqueo: {motivo}", arqueo_id, usuario_id))
        conexion.commit()
        if abs(diferencia) < 0.01:
            mensaje = "Arqueo registrado. Coincide con el sistema."
        elif primero:
            mensaje = f"Saldo inicial cargado: ${contado:,.2f}."
        else:
            mensaje = f"Arqueo registrado. {'Sobraban' if diferencia > 0 else 'Faltaban'} ${abs(diferencia):,.2f}; quedó ajustado."
        return {"mensaje": mensaje, "saldo": contado, "diferencia": diferencia}
    except HTTPException:
        conexion.rollback()
        raise
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo registrar el arqueo.")
    finally:
        conexion.close()


@router.get("/pendientes", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_pendientes(cuenta: str = "CAJA_FUERTE", recibidos: int = 10):
    """Por recibir (todos) + los últimos recibidos, para ver diferencias de cada sobre."""
    cuenta = (cuenta or "").upper()
    if cuenta not in CUENTAS:
        raise HTTPException(status_code=404, detail="Cuenta de tesorería inválida.")
    recibidos = max(0, min(int(recibidos or 0), 50))
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        consulta = '''
            SELECT p.id, p.fecha_hora, p.monto_declarado, p.concepto, p.origen_tipo, p.turno_id, p.estado,
                   p.recibido_en, p.monto_contado, p.diferencia, p.nota,
                   IFNULL(u.nombre_completo, '') AS declarado_por
            FROM tesoreria_pendientes p
            LEFT JOIN usuarios u ON u.id = p.usuario_id
            WHERE p.cuenta = ? AND p.estado = ?
        '''
        pendientes = conexion.execute(consulta + " ORDER BY p.fecha_hora ASC, p.id ASC", (cuenta, "PENDIENTE")).fetchall()
        ultimos = conexion.execute(consulta + " ORDER BY p.recibido_en DESC, p.id DESC LIMIT ?", (cuenta, "RECIBIDO", recibidos)).fetchall()
        return {
            "pendientes": [dict(p) for p in pendientes],
            "total_pendiente": round(sum(float(p["monto_declarado"] or 0) for p in pendientes), 2),
            "recibidos": [dict(p) for p in ultimos],
        }
    finally:
        conexion.close()


class RecepcionPendiente(BaseModel):
    monto_contado: float
    nota: Optional[str] = ""


@router.post("/pendientes/{pendiente_id}/recibir")
def recibir_pendiente(pendiente_id: int, body: RecepcionPendiente, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    contado = round(float(body.monto_contado or 0), 2)
    if contado < 0:
        raise HTTPException(status_code=400, detail="Lo contado no puede ser negativo.")
    nota = " ".join((body.nota or "").split())[:200]
    usuario_id = _usuario_de(sesion)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        p = cursor.execute("SELECT * FROM tesoreria_pendientes WHERE id = ?", (pendiente_id,)).fetchone()
        if not p:
            raise HTTPException(status_code=404, detail="Ese pendiente no existe.")
        if p["estado"] != "PENDIENTE":
            raise HTTPException(status_code=400, detail="Ese pendiente ya se recibió.")
        diferencia = round(contado - float(p["monto_declarado"] or 0), 2)
        movimiento_id = mover_tesoreria(
            cursor, p["cuenta"], contado,
            f"{p['concepto']} (contado por el dueño)", p["origen_tipo"], p["id"], usuario_id,
        )
        ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute('''
            UPDATE tesoreria_pendientes
            SET estado = 'RECIBIDO', recibido_en = ?, recibido_por = ?, monto_contado = ?, diferencia = ?, nota = ?, movimiento_id = ?
            WHERE id = ?
        ''', (ahora, usuario_id, contado, diferencia, nota or None, movimiento_id, pendiente_id))
        conexion.commit()
        if abs(diferencia) < 0.01:
            mensaje = f"Recibido: ${contado:,.2f}. Coincide con lo declarado."
        else:
            mensaje = (f"Recibido: ${contado:,.2f}. {'Faltaron' if diferencia < 0 else 'Sobraron'} ${abs(diferencia):,.2f} "
                       f"contra lo declarado; queda anotado en ese sobre.")
        return {"mensaje": mensaje, "diferencia": diferencia}
    except HTTPException:
        conexion.rollback()
        raise
    except ErrorTesoreria as e:
        conexion.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo registrar la recepción.")
    finally:
        conexion.close()
