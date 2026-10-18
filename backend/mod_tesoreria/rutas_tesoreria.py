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
    "MERCADOPAGO": "Mercado Pago",
    "BANCO": "Banco",
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
        # Cheque propio: la deuda o el gasto se anota al emitirlo.
        # Depositado no mueve el banco: avisa que ya lo presentaron.
        # Cobrado (estado DEBITADO) es el único paso que resta de Banco.
        conexion.execute('''
            CREATE TABLE IF NOT EXISTS cheques_propios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha_emision TEXT NOT NULL,
                fecha_cobro TEXT,
                numero TEXT NOT NULL,
                banco TEXT,
                monto REAL NOT NULL,
                beneficiario TEXT,
                destino TEXT NOT NULL,
                proveedor_id INTEGER,
                pago_id INTEGER,
                gasto_id INTEGER,
                retiro_id INTEGER,
                detalle TEXT,
                estado TEXT NOT NULL DEFAULT 'EMITIDO',
                depositado_en TEXT,
                debitado_en TEXT,
                anulado_en TEXT,
                usuario_id INTEGER
            )
        ''')
        columnas_cheque = {fila[1] for fila in conexion.execute("PRAGMA table_info(cheques_propios)")}
        if "depositado_en" not in columnas_cheque:
            conexion.execute("ALTER TABLE cheques_propios ADD COLUMN depositado_en TEXT")
        # Deuda de tarjeta: el saldo es lo que se debe. Positivo suma deuda, negativo la baja.
        conexion.execute('''
            CREATE TABLE IF NOT EXISTS deudas_movimientos (
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
        conexion.commit()
    finally:
        conexion.close()


asegurar_tablas_tesoreria_cuentas()

DEUDAS = {"TARJETA": "Tarjeta"}


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
                f"{CUENTAS[cuenta]} tiene ${saldo:,.2f} según el sistema y querés sacar ${-monto:,.2f}. "
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


def asentar_cobro_qr(cursor, cobro_id, monto, comision):
    """El neto del QR entra a Mercado Pago. Si ya se asentó este cobro, no lo repite."""
    ya = cursor.execute(
        "SELECT 1 FROM tesoreria_movimientos WHERE origen_tipo = 'COBRO_QR' AND origen_id = ?",
        (cobro_id,),
    ).fetchone()
    if ya:
        return None
    neto = round(float(monto or 0) - float(comision or 0), 2)
    if neto < 0.01:
        return None
    return mover_tesoreria(cursor, "MERCADOPAGO", neto, f"QR #{cobro_id}", "COBRO_QR", cobro_id, None)


def revertir_cobro_qr(cursor, cobro_id):
    """Saca de Mercado Pago el neto que había entrado con ese QR."""
    ya = cursor.execute(
        "SELECT 1 FROM tesoreria_movimientos WHERE origen_tipo = 'REEMBOLSO_QR' AND origen_id = ?",
        (cobro_id,),
    ).fetchone()
    if ya:
        return None
    fila = cursor.execute(
        "SELECT monto FROM tesoreria_movimientos WHERE origen_tipo = 'COBRO_QR' AND origen_id = ?",
        (cobro_id,),
    ).fetchone()
    if not fila:
        return None
    return mover_tesoreria(cursor, "MERCADOPAGO", -float(fila[0]), f"Reembolso QR #{cobro_id}", "REEMBOLSO_QR", cobro_id, None)


def saldo_deuda(cursor, cuenta: str) -> float:
    fila = cursor.execute(
        "SELECT IFNULL(SUM(monto), 0) FROM deudas_movimientos WHERE cuenta = ?", (cuenta,)
    ).fetchone()
    return round(float(fila[0] or 0), 2)


def deuda_inicializada(cursor, cuenta: str) -> bool:
    return cursor.execute(
        "SELECT 1 FROM deudas_movimientos WHERE cuenta = ? AND origen_tipo IN ('SALDO_INICIAL', 'AJUSTE_DEUDA') LIMIT 1",
        (cuenta,),
    ).fetchone() is not None


def mover_deuda(cursor, cuenta: str, monto: float, concepto: str, origen_tipo: str,
                origen_id=None, usuario_id=None):
    """monto > 0 suma lo que se debe. monto < 0 lo baja. No es plata en una cuenta."""
    if cuenta not in DEUDAS:
        raise ErrorTesoreria("Esa deuda no existe.")
    monto = round(float(monto or 0), 2)
    if abs(monto) < 0.01:
        return None
    if monto < 0 and deuda_inicializada(cursor, cuenta):
        saldo = saldo_deuda(cursor, cuenta)
        if saldo + monto < -0.009:
            raise ErrorTesoreria(
                f"La {DEUDAS[cuenta].lower()} debe ${saldo:,.2f} y querés pagar ${-monto:,.2f}."
            )
    cursor.execute('''
        INSERT INTO deudas_movimientos (fecha_hora, cuenta, monto, concepto, origen_tipo, origen_id, usuario_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S"), cuenta, monto, (concepto or "")[:200],
          origen_tipo, origen_id, usuario_id))
    return cursor.lastrowid


def crear_cheque_propio(cursor, monto, numero, banco, fecha_cobro, destino, beneficiario,
                        detalle, usuario_id, proveedor_id=None, pago_id=None, gasto_id=None, retiro_id=None):
    """El cheque queda emitido. No toca el banco: eso pasa al debitarlo."""
    ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute('''
        INSERT INTO cheques_propios (
            fecha_emision, fecha_cobro, numero, banco, monto, beneficiario, destino,
            proveedor_id, pago_id, gasto_id, retiro_id, detalle, estado, usuario_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EMITIDO', ?)
    ''', (ahora, fecha_cobro or None, numero, banco or None, monto, beneficiario or None, destino,
          proveedor_id, pago_id, gasto_id, retiro_id, detalle or None, usuario_id))
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


class Transferencia(BaseModel):
    origen: str
    destino: str
    monto: float
    motivo: Optional[str] = ""


@router.post("/transferencia")
def transferir(body: Transferencia, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    """Pasa plata de una cuenta a otra. No es un gasto: sale de una y entra en la otra."""
    origen = (body.origen or "").upper()
    destino = (body.destino or "").upper()
    if origen not in CUENTAS or destino not in CUENTAS:
        raise HTTPException(status_code=400, detail="Cuenta de tesorería inválida.")
    if origen == destino:
        raise HTTPException(status_code=400, detail="Elegí dos cuentas distintas.")
    monto = round(float(body.monto or 0), 2)
    if monto < 0.01:
        raise HTTPException(status_code=400, detail="El monto tiene que ser mayor a 0.")
    motivo = " ".join((body.motivo or "").split())[:120]
    nota = f": {motivo}" if motivo else ""
    usuario_id = _usuario_de(sesion)
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        sale = mover_tesoreria(cursor, origen, -monto, f"Pasa a {CUENTAS[destino]}{nota}", "TRANSFERENCIA", None, usuario_id)
        mover_tesoreria(cursor, destino, monto, f"Entra de {CUENTAS[origen]}{nota}", "TRANSFERENCIA", sale, usuario_id)
        conexion.commit()
        return {"mensaje": f"Pasaron ${monto:,.2f} de {CUENTAS[origen]} a {CUENTAS[destino]}."}
    except ErrorTesoreria as e:
        conexion.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo pasar la plata.")
    finally:
        conexion.close()


class ChequeNuevo(BaseModel):
    destino: str
    monto: float
    numero: str
    banco: Optional[str] = ""
    fecha_cobro: Optional[str] = ""
    detalle: Optional[str] = ""
    proveedor_id: Optional[int] = None
    categoria_id: Optional[int] = None


def _numero_cheque(numero: str) -> str:
    limpio = " ".join((numero or "").split())
    if len(limpio) < 1:
        raise HTTPException(status_code=400, detail="Cargá el número de cheque.")
    return limpio[:40]


@router.get("/cheques", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_cheques():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        filas = conexion.execute('''
            SELECT c.*, IFNULL(p.nombre_comercial, '') AS proveedor
            FROM cheques_propios c
            LEFT JOIN proveedores p ON p.id = c.proveedor_id
            ORDER BY
                CASE c.estado WHEN 'DEPOSITADO' THEN 0 WHEN 'EMITIDO' THEN 1 WHEN 'DEBITADO' THEN 2 ELSE 3 END,
                CASE WHEN c.estado IN ('DEPOSITADO', 'EMITIDO') THEN IFNULL(c.fecha_cobro, '9999-12-31') ELSE '0000' END,
                c.id DESC
            LIMIT 200
        ''').fetchall()
        depositados = conexion.execute(
            "SELECT COUNT(*), IFNULL(SUM(monto), 0) FROM cheques_propios WHERE estado = 'DEPOSITADO'"
        ).fetchone()
        return {
            "cheques": [dict(f) for f in filas],
            "depositados": {
                "cantidad": depositados[0],
                "total": round(float(depositados[1] or 0), 2),
            },
            "saldo_banco": saldo_cuenta(conexion.cursor(), "BANCO"),
        }
    finally:
        conexion.close()


@router.post("/cheque")
def emitir_cheque(body: ChequeNuevo, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    """Emitir un cheque que no es de proveedor: gasto del local o retiro del dueño.
    El de proveedor se emite al pagarle, desde Proveedores."""
    destino = (body.destino or "").upper()
    if destino not in ("GASTO", "RETIRO"):
        raise HTTPException(status_code=400, detail="Si es de un proveedor, cargalo en Proveedores. Acá: gasto del local o retiro tuyo.")
    monto = round(float(body.monto or 0), 2)
    if monto < 0.01:
        raise HTTPException(status_code=400, detail="El monto tiene que ser mayor a 0.")
    numero = _numero_cheque(body.numero)
    banco = " ".join((body.banco or "").split())[:80]
    fecha_cobro = (body.fecha_cobro or "").strip()[:10] or None
    detalle = " ".join((body.detalle or "").split())[:200]
    if len(detalle) < 3:
        raise HTTPException(status_code=400, detail="Escribí a quién o para qué es el cheque.")
    usuario_id = _usuario_de(sesion)
    ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        repetido = cursor.execute(
            "SELECT id FROM cheques_propios WHERE numero = ? AND IFNULL(banco, '') = ? AND estado != 'ANULADO'",
            (numero, banco),
        ).fetchone()
        if repetido:
            raise HTTPException(status_code=400, detail="Ese número de cheque ya está emitido o debitado.")
        gasto_id = None
        retiro_id = None
        if destino == "GASTO":
            if not body.categoria_id:
                raise HTTPException(status_code=400, detail="Elegí la categoría del gasto.")
            from backend.mod_gastos.rutas_gastos import _es_categoria_pago_proveedor, _es_categoria_sueldos
            cat = cursor.execute(
                "SELECT nombre, IFNULL(tipo_categoria, 'OPERATIVO') AS tipo FROM categorias_gasto WHERE id = ?",
                (body.categoria_id,),
            ).fetchone()
            if not cat:
                raise HTTPException(status_code=400, detail="La categoría no existe.")
            if _es_categoria_pago_proveedor(cat["nombre"] or ""):
                raise HTTPException(status_code=400, detail="Un pago a proveedor se carga en Proveedores, con método Cheque.")
            if _es_categoria_sueldos(cat["nombre"] or ""):
                raise HTTPException(status_code=400, detail="Los sueldos van por RRHH.")
            if (cat["tipo"] or "").upper() != "OPERATIVO":
                raise HTTPException(status_code=400, detail="Esa categoría no es un gasto del local.")
            cursor.execute('''
                INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago, origen_fondos, usuario_id, turno_id)
                VALUES (?, ?, ?, ?, 'CHEQUE', 'CHEQUE', ?, NULL)
            ''', (ahora, body.categoria_id, f"Cheque {numero}: {detalle}", monto, usuario_id))
            gasto_id = cursor.lastrowid
        else:
            cursor.execute('''
                INSERT INTO retiros_dueno (fecha_hora, monto, origen, motivo, usuario_id, estado)
                VALUES (?, ?, 'CHEQUE', ?, ?, 'ACTIVO')
            ''', (ahora, monto, f"Cheque {numero}: {detalle}", usuario_id))
            retiro_id = cursor.lastrowid
        cheque_id = crear_cheque_propio(
            cursor, monto, numero, banco, fecha_cobro, destino, detalle, detalle, usuario_id,
            gasto_id=gasto_id, retiro_id=retiro_id,
        )
        conexion.commit()
        return {"mensaje": f"Cheque {numero} emitido. El banco no se movió: marcalo cobrado cuando lo debiten.", "id": cheque_id}
    except HTTPException:
        conexion.rollback()
        raise
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo emitir el cheque.")
    finally:
        conexion.close()


@router.put("/cheque/{cheque_id}/depositar")
def depositar_cheque(cheque_id: int, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    """El beneficiario ya lo presentó. No mueve el banco: sirve para ver cuánto tiene que haber mañana."""
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        ch = cursor.execute("SELECT * FROM cheques_propios WHERE id = ?", (cheque_id,)).fetchone()
        if not ch:
            raise HTTPException(status_code=404, detail="Ese cheque no existe.")
        if ch["estado"] != "EMITIDO":
            raise HTTPException(status_code=400, detail="Solo un cheque emitido se marca depositado.")
        ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute(
            "UPDATE cheques_propios SET estado = 'DEPOSITADO', depositado_en = ? WHERE id = ?",
            (ahora, cheque_id),
        )
        conexion.commit()
        return {"mensaje": f"Cheque {ch['numero']} depositado. El banco no se movió."}
    except HTTPException:
        conexion.rollback()
        raise
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo marcar el cheque depositado.")
    finally:
        conexion.close()


@router.put("/cheque/{cheque_id}/debitar")
def debitar_cheque(cheque_id: int, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    """Cobrado: el banco ya lo debitó. Único paso que resta de Banco."""
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        ch = cursor.execute("SELECT * FROM cheques_propios WHERE id = ?", (cheque_id,)).fetchone()
        if not ch:
            raise HTTPException(status_code=404, detail="Ese cheque no existe.")
        if ch["estado"] not in ("EMITIDO", "DEPOSITADO"):
            raise HTTPException(status_code=400, detail="Ese cheque no está pendiente de cobro.")
        ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        mover_tesoreria(cursor, "BANCO", -float(ch["monto"]), f"Cobro cheque {ch['numero']}", "CHEQUE", cheque_id, _usuario_de(sesion))
        cursor.execute("UPDATE cheques_propios SET estado = 'DEBITADO', debitado_en = ? WHERE id = ?", (ahora, cheque_id))
        conexion.commit()
        return {"mensaje": f"Cheque {ch['numero']} cobrado. Salió del banco."}
    except HTTPException:
        conexion.rollback()
        raise
    except ErrorTesoreria as e:
        conexion.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo debitar el cheque.")
    finally:
        conexion.close()


def _anular_efecto_cheque(cursor, ch):
    monto = float(ch["monto"] or 0)
    if ch["destino"] == "PROVEEDOR" and ch["proveedor_id"]:
        cursor.execute(
            "UPDATE proveedores_ctacte SET saldo_deudor = saldo_deudor + ? WHERE proveedor_id = ?",
            (monto, ch["proveedor_id"]),
        )
    elif ch["destino"] == "GASTO" and ch["gasto_id"]:
        cursor.execute("UPDATE gastos_operativos SET estado = 'ANULADO' WHERE id = ?", (ch["gasto_id"],))
    elif ch["destino"] == "RETIRO" and ch["retiro_id"]:
        cursor.execute("UPDATE retiros_dueno SET estado = 'ANULADO' WHERE id = ?", (ch["retiro_id"],))


@router.put("/cheque/{cheque_id}/anular")
def anular_cheque(cheque_id: int, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        ch = cursor.execute("SELECT * FROM cheques_propios WHERE id = ?", (cheque_id,)).fetchone()
        if not ch:
            raise HTTPException(status_code=404, detail="Ese cheque no existe.")
        if ch["estado"] == "ANULADO":
            raise HTTPException(status_code=400, detail="Ese cheque ya está anulado.")
        ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        if ch["estado"] == "DEBITADO":
            mover_tesoreria(cursor, "BANCO", float(ch["monto"]), f"Anula débito cheque {ch['numero']}", "ANULACION", cheque_id, _usuario_de(sesion))
        _anular_efecto_cheque(cursor, ch)
        cursor.execute("UPDATE cheques_propios SET estado = 'ANULADO', anulado_en = ? WHERE id = ?", (ahora, cheque_id))
        conexion.commit()
        return {"mensaje": f"Cheque {ch['numero']} anulado."}
    except HTTPException:
        conexion.rollback()
        raise
    except ErrorTesoreria as e:
        conexion.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo anular el cheque.")
    finally:
        conexion.close()


def _deuda_o_404(cuenta: str) -> str:
    cuenta = (cuenta or "").upper()
    if cuenta not in DEUDAS:
        raise HTTPException(status_code=404, detail="Esa deuda no existe.")
    return cuenta


@router.get("/deuda/{cuenta}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def estado_deuda(cuenta: str):
    cuenta = _deuda_o_404(cuenta)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        cursor = conexion.cursor()
        movimientos = cursor.execute('''
            SELECT id, fecha_hora, monto, concepto, origen_tipo
            FROM deudas_movimientos WHERE cuenta = ?
            ORDER BY fecha_hora DESC, id DESC LIMIT 40
        ''', (cuenta,)).fetchall()
        return {
            "cuenta": cuenta,
            "nombre": DEUDAS[cuenta],
            "saldo": saldo_deuda(cursor, cuenta),
            "inicializada": deuda_inicializada(cursor, cuenta),
            "movimientos": [dict(m) for m in movimientos],
        }
    finally:
        conexion.close()


class SaldoDeuda(BaseModel):
    monto_adeudado: float


@router.post("/deuda/{cuenta}/saldo")
def fijar_saldo_deuda(cuenta: str, body: SaldoDeuda, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    cuenta = _deuda_o_404(cuenta)
    adeudado = round(float(body.monto_adeudado or 0), 2)
    if adeudado < 0:
        raise HTTPException(status_code=400, detail="Lo que debés no puede ser negativo.")
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        saldo = saldo_deuda(cursor, cuenta)
        primero = not deuda_inicializada(cursor, cuenta)
        diferencia = round(adeudado - saldo, 2)
        if abs(diferencia) >= 0.01:
            mover_deuda(cursor, cuenta, diferencia,
                        "Saldo de la deuda" if primero else "Ajuste de la deuda",
                        "SALDO_INICIAL" if primero else "AJUSTE_DEUDA", None, _usuario_de(sesion))
        conexion.commit()
        if primero:
            mensaje = f"Quedó cargado lo que debés en {DEUDAS[cuenta]}: ${adeudado:,.2f}."
        elif abs(diferencia) < 0.01:
            mensaje = "Coincide con lo que ya tenía el sistema."
        else:
            mensaje = f"Ajustado. Ahora {DEUDAS[cuenta]} debe ${adeudado:,.2f}."
        return {"mensaje": mensaje, "saldo": adeudado}
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


class PagoDeuda(BaseModel):
    origen: str
    monto: float


@router.post("/deuda/{cuenta}/pagar")
def pagar_deuda(cuenta: str, body: PagoDeuda, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    cuenta = _deuda_o_404(cuenta)
    origen = (body.origen or "").upper()
    if origen not in ("CAJA_FUERTE", "BANCO"):
        raise HTTPException(status_code=400, detail="El resumen se paga desde la caja fuerte o el banco.")
    monto = round(float(body.monto or 0), 2)
    if monto < 0.01:
        raise HTTPException(status_code=400, detail="El monto tiene que ser mayor a 0.")
    usuario_id = _usuario_de(sesion)
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        mover_tesoreria(cursor, origen, -monto, f"Pago resumen {DEUDAS[cuenta]}", "PAGO_DEUDA", None, usuario_id)
        mover_deuda(cursor, cuenta, -monto, f"Pago desde {CUENTAS[origen]}", "PAGO", None, usuario_id)
        conexion.commit()
        return {"mensaje": f"Pagaste ${monto:,.2f} de {DEUDAS[cuenta]} desde {CUENTAS[origen]}. No es un gasto."}
    except ErrorTesoreria as e:
        conexion.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo pagar el resumen.")
    finally:
        conexion.close()


class CargoDeuda(BaseModel):
    monto: float
    detalle: str
    categoria_id: int


@router.post("/deuda/{cuenta}/consumo")
def consumo_deuda(cuenta: str, body: CargoDeuda, sesion: dict = Depends(VerificarRol(["ADMIN"]))):
    """Gasto o interés que quedó en la tarjeta. Suma la deuda y anota el gasto del mes. No sale plata."""
    cuenta = _deuda_o_404(cuenta)
    monto = round(float(body.monto or 0), 2)
    if monto < 0.01:
        raise HTTPException(status_code=400, detail="El monto tiene que ser mayor a 0.")
    detalle = " ".join((body.detalle or "").split())[:200]
    if len(detalle) < 3:
        raise HTTPException(status_code=400, detail="Escribí qué es (interés, abono, servicio).")
    usuario_id = _usuario_de(sesion)
    ahora = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        from backend.mod_gastos.rutas_gastos import _es_categoria_pago_proveedor, _es_categoria_sueldos
        cat = cursor.execute(
            "SELECT nombre, IFNULL(tipo_categoria, 'OPERATIVO') AS tipo FROM categorias_gasto WHERE id = ?",
            (body.categoria_id,),
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=400, detail="La categoría no existe.")
        if _es_categoria_pago_proveedor(cat["nombre"] or ""):
            raise HTTPException(status_code=400, detail="La mercadería se carga en Proveedores, pagando con Tarjeta.")
        if _es_categoria_sueldos(cat["nombre"] or ""):
            raise HTTPException(status_code=400, detail="Los sueldos van por RRHH.")
        if (cat["tipo"] or "").upper() != "OPERATIVO":
            raise HTTPException(status_code=400, detail="Esa categoría no es un gasto del local.")
        cursor.execute('''
            INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago, origen_fondos, usuario_id, turno_id)
            VALUES (?, ?, ?, ?, 'TARJETA', 'TARJETA', ?, NULL)
        ''', (ahora, body.categoria_id, detalle, monto, usuario_id))
        gasto_id = cursor.lastrowid
        mover_deuda(cursor, cuenta, monto, detalle, "CONSUMO", gasto_id, usuario_id)
        conexion.commit()
        return {"mensaje": f"Quedó en la {DEUDAS[cuenta].lower()}: ${monto:,.2f}. Es gasto del mes y no salió plata."}
    except HTTPException:
        conexion.rollback()
        raise
    except Exception:
        conexion.rollback()
        raise HTTPException(status_code=500, detail="No se pudo cargar el consumo.")
    finally:
        conexion.close()
