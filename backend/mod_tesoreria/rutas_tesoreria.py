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
        return {
            "cuenta": cuenta,
            "nombre": CUENTAS[cuenta],
            "saldo": saldo_cuenta(cursor, cuenta),
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
