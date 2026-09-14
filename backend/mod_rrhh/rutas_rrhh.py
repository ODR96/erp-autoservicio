from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from typing import Optional, Literal, List
from datetime import date, datetime, timezone, timedelta
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol, verificar_pin
from backend.mod_lotes.rutas_lotes import ejecutar_descuento_fifo

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

# Whitelists validadas por Pydantic (Literal) — nada de strings sueltos comparados
# a mano por el código. Si mañana se necesita otra modalidad (ej: POR_COMISION),
# se agrega acá y en ningún otro lado.
ModalidadPago = Literal["MENSUAL", "JORNAL", "POR_HORA"]
PeriodicidadPago = Literal["SEMANAL", "QUINCENAL", "MENSUAL"]
ResolucionConsumo = Literal["DESCUENTA_SUELDO", "GASTO_LOCAL"]


# =================================================================
# 1. MIGRACIÓN AUTOMÁTICA DE TABLAS (mismo patrón que el resto del proyecto)
# =================================================================
def asegurar_tablas_rrhh():
    conexion = obtener_conexion()
    cursor = conexion.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS historial_tarifas_empleado (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER NOT NULL,
            modalidad_pago TEXT NOT NULL,
            periodicidad_pago TEXT NOT NULL,
            valor REAL NOT NULL,
            vigente_desde TEXT NOT NULL,
            vigente_hasta TEXT,
            creado_por INTEGER NOT NULL,
            fecha_creacion TEXT NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS partes_de_trabajo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER NOT NULL,
            fecha TEXT NOT NULL,
            horas_trabajadas REAL,
            presente REAL DEFAULT 1,
            observaciones TEXT,
            registrado_por INTEGER NOT NULL,
            fecha_registro TEXT NOT NULL,
            liquidacion_id INTEGER
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS movimientos_cuenta_empleado (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER NOT NULL,
            fecha_hora TEXT NOT NULL,
            tipo_movimiento TEXT NOT NULL,
            monto REAL NOT NULL,
            detalle TEXT,
            referencia_movimiento_stock_id INTEGER,
            liquidacion_id INTEGER,
            usuario_registro INTEGER NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS liquidaciones_sueldos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER NOT NULL,
            periodo_desde TEXT NOT NULL,
            periodo_hasta TEXT NOT NULL,
            modalidad_aplicada TEXT NOT NULL,
            cantidad_unidades REAL NOT NULL,
            valor_unitario REAL NOT NULL,
            monto_bruto REAL NOT NULL,
            total_descuentos_aplicados REAL NOT NULL DEFAULT 0,
            monto_neto_pagado REAL NOT NULL,
            saldo_pendiente_arrastrado REAL NOT NULL DEFAULT 0,
            tope_pct_usado REAL NOT NULL,
            categoria_gasto_id INTEGER NOT NULL,
            gasto_operativo_id INTEGER,
            fecha_liquidacion TEXT NOT NULL,
            liquidado_por INTEGER NOT NULL,
            estado TEXT NOT NULL DEFAULT 'PAGADO'
        )
    ''')

    # Detalle de qué deuda (adelanto/consumo) se pagó, y cuánto, en cada liquidación.
    # Necesario para soportar pagos PARCIALES (una deuda grande se cobra de a partes en
    # varias liquidaciones) y para poder anular una liquidación revirtiendo exactamente
    # los montos que aplicó, ni un centavo más ni menos.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS liquidacion_descuentos_detalle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            liquidacion_id INTEGER NOT NULL,
            movimiento_cuenta_empleado_id INTEGER NOT NULL,
            monto_aplicado REAL NOT NULL
        )
    ''')

    # Migración: columna para soportar pago PARCIAL de una deuda (adelanto/consumo) cuando
    # es más grande que el margen que deja el tope en una sola liquidación.
    cursor.execute("PRAGMA table_info(movimientos_cuenta_empleado)")
    cols_cuenta = [c[1] for c in cursor.fetchall()]
    if 'monto_saldado' not in cols_cuenta:
        cursor.execute("ALTER TABLE movimientos_cuenta_empleado ADD COLUMN monto_saldado REAL NOT NULL DEFAULT 0")

    # Semilla amigable: si todavía no existe ninguna categoría de gasto para sueldos,
    # creamos una por defecto (OPERATIVO, para que impacte la rentabilidad y el Punto de
    # Equilibrio). El usuario puede después crear categorías más específicas si quiere
    # separar "Sueldo Gerencia" de "Sueldo Empleados" desde la pantalla de Gastos.
    # (defensivo: si mod_gastos todavía no creó la tabla, no rompemos el arranque)
    try:
        cursor.execute("SELECT COUNT(*) FROM categorias_gasto WHERE nombre = 'Sueldos'")
        if cursor.fetchone()[0] == 0:
            cursor.execute("INSERT INTO categorias_gasto (nombre, tipo_categoria) VALUES ('Sueldos', 'OPERATIVO')")
    except sqlite3.OperationalError:
        pass

    conexion.commit()
    conexion.close()

asegurar_tablas_rrhh()


# =================================================================
# 2. MODELOS
# =================================================================
class TarifaNueva(BaseModel):
    usuario_id: int
    modalidad_pago: ModalidadPago
    periodicidad_pago: PeriodicidadPago
    valor: float = Field(..., gt=0)
    vigente_desde: date
    creado_por: int

class ParteTrabajoNuevo(BaseModel):
    usuario_id: int
    fecha: date
    horas_trabajadas: Optional[float] = Field(None, ge=0)
    presente: float = Field(1.0, ge=0, le=1)
    observaciones: Optional[str] = ""
    registrado_por: int

class AdelantoNuevo(BaseModel):
    usuario_id: int
    monto: float = Field(..., gt=0)
    detalle: str = Field(..., min_length=3, max_length=255)
    turno_id: int
    usuario_registro: int
    pin_autorizante: str

class ConsumoMercaderiaNuevo(BaseModel):
    usuario_id: int
    producto_id: int
    cantidad: float = Field(..., gt=0)
    resolucion: ResolucionConsumo
    categoria_gasto_id: Optional[int] = None  # obligatorio si resolucion == GASTO_LOCAL
    detalle: Optional[str] = ""
    usuario_registro: int
    pin_autorizante: str

class LiquidacionNueva(BaseModel):
    usuario_id: int
    periodo_desde: date
    periodo_hasta: date
    categoria_gasto_id: int
    liquidado_por: int
    pin_autorizante: str

class AnulacionLiquidacion(BaseModel):
    pin_autorizante: str
    motivo: Optional[str] = ""


# =================================================================
# 3. HELPERS INTERNOS (seguridad + cálculo, reutilizados por varios endpoints)
# =================================================================
def _verificar_pin_admin(cursor, pin_secreto: str) -> bool:
    """Valida el PIN contra CUALQUIER usuario ADMIN activo (reutiliza bcrypt de mod_usuarios)."""
    cursor.execute("SELECT pin_secreto FROM usuarios WHERE rol = 'ADMIN' AND estado = 'ACTIVO'")
    for admin in cursor.fetchall():
        if verificar_pin(pin_secreto, admin[0]):
            return True
    return False


def _obtener_tarifa_para_periodo(cursor, usuario_id: int, desde_str: str, hasta_str: str):
    """Exige UNA sola tarifa que cubra todo el período. Si cambió a mitad de camino,
    obliga a liquidar en tramos separados en vez de adivinar un promedio."""
    cursor.execute('''
        SELECT * FROM historial_tarifas_empleado 
        WHERE usuario_id = ? AND vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
        ORDER BY vigente_desde DESC LIMIT 1
    ''', (usuario_id, desde_str, hasta_str))
    tarifa = cursor.fetchone()
    if not tarifa:
        # En vez de un mensaje genérico, buscamos el historial completo para poder explicar
        # EXACTAMENTE por qué el período no está cubierto (es la causa #1 de confusión: la
        # tarifa se configuró "desde hoy" por defecto, y no cubre retroactivamente los días
        # anteriores a esa fecha).
        cursor.execute('''
            SELECT vigente_desde, vigente_hasta FROM historial_tarifas_empleado
            WHERE usuario_id = ? ORDER BY vigente_desde ASC
        ''', (usuario_id,))
        todas = cursor.fetchall()
        if not todas:
            raise Exception(
                "Este empleado todavía no tiene ninguna tarifa configurada. Cargá una en la "
                "pestaña 'Tarifa / Sueldo' antes de intentar liquidar."
            )
        primera_desde = todas[0]['vigente_desde']
        if desde_str < primera_desde:
            raise Exception(
                f"El período elegido empieza el {desde_str}, pero la tarifa de este empleado recién "
                f"está configurada desde el {primera_desde} (no cubre retroactivamente días anteriores). "
                f"Si trabajó antes con otra tarifa, cargala en 'Tarifa / Sueldo' con esa fecha real de "
                f"inicio, o cambiá el período para que empiece el {primera_desde} o después."
            )
        raise Exception(
            "No hay una tarifa vigente que cubra TODO el período indicado (probablemente cambió a "
            "mitad de camino). Revisá el historial en la pestaña 'Tarifa / Sueldo' y liquidá en dos "
            "tramos separados, uno por cada tarifa."
        )
    return tarifa


def _calcular_bruto_periodo(cursor, usuario_id: int, tarifa, desde_str: str, hasta_str: str):
    """Devuelve (modalidad, valor_unitario, cantidad_unidades, monto_bruto, ids_partes_a_marcar)."""
    modalidad = tarifa['modalidad_pago']
    valor_unitario = tarifa['valor']
    partes_ids: List[int] = []

    if modalidad == 'MENSUAL':
        cantidad_unidades = 1.0
    else:
        cursor.execute('''
            SELECT id, presente, horas_trabajadas FROM partes_de_trabajo 
            WHERE usuario_id = ? AND fecha BETWEEN ? AND ? AND liquidacion_id IS NULL
            ORDER BY fecha ASC
        ''', (usuario_id, desde_str, hasta_str))
        partes = cursor.fetchall()
        if not partes:
            cursor.execute('''
                SELECT fecha FROM partes_de_trabajo
                WHERE usuario_id = ? AND liquidacion_id IS NULL
                ORDER BY fecha ASC
            ''', (usuario_id,))
            pendientes = [p['fecha'] for p in cursor.fetchall()]
            if pendientes:
                raise Exception(
                    f"No hay días pendientes entre {desde_str} y {hasta_str}. "
                    f"Los días que SÍ están pendientes de pago son: {', '.join(pendientes)}. "
                    f"Ajustá el período para incluir esas fechas (el calendario del sistema "
                    f"usa año-mes-día, no el formato inglés mes/día)."
                )
            raise Exception(
                "Este empleado no tiene ningún día/hora pendiente de pago. "
                "Cargá la asistencia en la pestaña 'Asistencia' antes de liquidar "
                "(o, si cobra sueldo mensual fijo, no hace falta asistencia)."
            )

        partes_ids = [p['id'] for p in partes]
        if modalidad == 'JORNAL':
            cantidad_unidades = sum(p['presente'] or 0 for p in partes)
        else:  # POR_HORA
            cantidad_unidades = sum(p['horas_trabajadas'] or 0 for p in partes)

        if cantidad_unidades <= 0:
            raise Exception("Los partes de trabajo del período no registran días ni horas efectivas.")

    monto_bruto = round(cantidad_unidades * valor_unitario, 2)
    return modalidad, valor_unitario, cantidad_unidades, monto_bruto, partes_ids


def _calcular_descuento_con_tope(cursor, usuario_id: int, monto_bruto: float):
    """Devuelve (tope_pct, descuento_aplicado, saldo_pendiente_arrastrado, detalle_aplicaciones).

    Aplica los adelantos/consumos más viejos primero (FIFO). Si una deuda es más grande que
    el margen que queda dentro del tope, se le aplica un pago PARCIAL (se cobra el máximo
    posible) y el resto queda pendiente para la próxima liquidación — en vez de "rendirse" y
    dejar sin cobrar también las deudas más nuevas que sí entrarían.

    `detalle_aplicaciones` es una lista de dicts: {movimiento_id, detalle, monto_aplicado,
    queda_saldado} — necesaria para poder reconstruir/revertir exactamente qué se cobró.
    """
    cursor.execute('''
        SELECT id, monto, monto_saldado, detalle FROM movimientos_cuenta_empleado 
        WHERE usuario_id = ? AND liquidacion_id IS NULL 
        ORDER BY fecha_hora ASC
    ''', (usuario_id,))
    pendientes = cursor.fetchall()
    saldo_total = round(sum(m['monto'] - (m['monto_saldado'] or 0) for m in pendientes), 2)

    cursor.execute("SELECT tope_maximo_descuento_sueldo_pct FROM configuracion_local WHERE id = 1")
    fila_config = cursor.fetchone()
    tope_pct = fila_config['tope_maximo_descuento_sueldo_pct'] if (fila_config and fila_config['tope_maximo_descuento_sueldo_pct'] is not None) else 50.0

    tope_monto = round(monto_bruto * (tope_pct / 100), 2)
    aplicado = 0.0
    detalle_aplicaciones: List[dict] = []

    for mov in pendientes:
        margen_restante = round(tope_monto - aplicado, 2)
        if margen_restante <= 0:
            break  # Ya no queda margen bajo el tope, no se puede cobrar nada más

        deuda_pendiente = round(mov['monto'] - (mov['monto_saldado'] or 0), 2)
        if deuda_pendiente <= 0:
            continue

        a_tomar = min(deuda_pendiente, margen_restante)
        aplicado = round(aplicado + a_tomar, 2)
        detalle_aplicaciones.append({
            "movimiento_id": mov['id'],
            "detalle": mov['detalle'],
            "monto_aplicado": a_tomar,
            "queda_saldado": a_tomar >= deuda_pendiente - 0.01  # tolerancia de redondeo
        })

    saldo_arrastrado = round(saldo_total - aplicado, 2)
    return tope_pct, aplicado, saldo_arrastrado, detalle_aplicaciones


# =================================================================
# 4. TARIFAS (configuración salarial con historial)
# =================================================================
@router.post("/tarifas", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def crear_tarifa(tarifa: TarifaNueva):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id FROM usuarios WHERE id = ?", (tarifa.usuario_id,))
        if not cursor.fetchone(): raise Exception("El empleado no existe.")

        vigente_desde_str = tarifa.vigente_desde.isoformat()

        cursor.execute('''
            SELECT vigente_desde FROM historial_tarifas_empleado 
            WHERE usuario_id = ? AND vigente_hasta IS NULL
        ''', (tarifa.usuario_id,))
        activa = cursor.fetchone()
        if activa and vigente_desde_str <= activa['vigente_desde']:
            raise Exception("La nueva tarifa debe tener una fecha de vigencia posterior a la tarifa activa actual.")

        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        dia_anterior = (tarifa.vigente_desde - timedelta(days=1)).isoformat()

        # Cerramos la tarifa vigente anterior (si existía)
        cursor.execute('''
            UPDATE historial_tarifas_empleado 
            SET vigente_hasta = ?
            WHERE usuario_id = ? AND vigente_hasta IS NULL
        ''', (dia_anterior, tarifa.usuario_id))

        cursor.execute('''
            INSERT INTO historial_tarifas_empleado 
            (usuario_id, modalidad_pago, periodicidad_pago, valor, vigente_desde, vigente_hasta, creado_por, fecha_creacion)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
        ''', (tarifa.usuario_id, tarifa.modalidad_pago, tarifa.periodicidad_pago, tarifa.valor,
              vigente_desde_str, tarifa.creado_por, fecha_actual))

        conexion.commit()
        return {"mensaje": "Tarifa configurada correctamente."}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/tarifas/{usuario_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_tarifas(usuario_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT * FROM historial_tarifas_empleado WHERE usuario_id = ? ORDER BY vigente_desde DESC
        ''', (usuario_id,))
        return {"tarifas": [dict(r) for r in cursor.fetchall()]}
    finally:
        conexion.close()


@router.get("/tarifa_vigente/{usuario_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def obtener_tarifa_vigente(usuario_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT * FROM historial_tarifas_empleado WHERE usuario_id = ? AND vigente_hasta IS NULL
        ''', (usuario_id,))
        tarifa = cursor.fetchone()
        return {"tarifa": dict(tarifa) if tarifa else None}
    finally:
        conexion.close()


# =================================================================
# 5. ASISTENCIA (partes de trabajo)
# =================================================================
@router.post("/asistencia", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def registrar_asistencia(parte: ParteTrabajoNuevo):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id FROM usuarios WHERE id = ?", (parte.usuario_id,))
        if not cursor.fetchone(): raise Exception("El empleado no existe.")

        fecha_str = parte.fecha.isoformat()
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

        cursor.execute('''
            SELECT id FROM partes_de_trabajo WHERE usuario_id = ? AND fecha = ?
        ''', (parte.usuario_id, fecha_str))
        existente = cursor.fetchone()

        if existente:
            cursor.execute('''
                UPDATE partes_de_trabajo 
                SET horas_trabajadas = ?, presente = ?, observaciones = ?, registrado_por = ?, fecha_registro = ?
                WHERE id = ? AND liquidacion_id IS NULL
            ''', (parte.horas_trabajadas, parte.presente, parte.observaciones, parte.registrado_por, fecha_actual, existente[0]))
            if cursor.rowcount == 0:
                raise Exception("Ese día ya fue liquidado, no se puede modificar.")
            mensaje = "Asistencia actualizada."
        else:
            cursor.execute('''
                INSERT INTO partes_de_trabajo (usuario_id, fecha, horas_trabajadas, presente, observaciones, registrado_por, fecha_registro)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (parte.usuario_id, fecha_str, parte.horas_trabajadas, parte.presente, parte.observaciones, parte.registrado_por, fecha_actual))
            mensaje = "Asistencia registrada."

        conexion.commit()
        return {"mensaje": mensaje}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/asistencia/{usuario_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_asistencia(usuario_id: int, desde: Optional[str] = None, hasta: Optional[str] = None):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        query = "SELECT * FROM partes_de_trabajo WHERE usuario_id = ?"
        params: list = [usuario_id]
        if desde:
            query += " AND fecha >= ?"; params.append(desde)
        if hasta:
            query += " AND fecha <= ?"; params.append(hasta)
        query += " ORDER BY fecha DESC"
        cursor.execute(query, params)
        partes = [dict(r) for r in cursor.fetchall()]

        pendientes = [p for p in partes if p['liquidacion_id'] is None]
        return {
            "partes": partes,
            "resumen_pendiente": {
                "dias_pendientes": round(sum(p['presente'] or 0 for p in pendientes), 2),
                "horas_pendientes": round(sum(p['horas_trabajadas'] or 0 for p in pendientes), 2)
            }
        }
    finally:
        conexion.close()


# =================================================================
# 6. CUENTA CORRIENTE DEL EMPLEADO (adelantos y consumo de mercadería)
# =================================================================
@router.post("/cuenta_empleado/adelanto", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def registrar_adelanto(adelanto: AdelantoNuevo):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        if not _verificar_pin_admin(cursor, adelanto.pin_autorizante):
            raise Exception("PIN incorrecto o sin privilegios de Administrador.")

        cursor.execute("SELECT id FROM usuarios WHERE id = ?", (adelanto.usuario_id,))
        if not cursor.fetchone(): raise Exception("El empleado no existe.")

        cursor.execute("SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'", (adelanto.turno_id,))
        if not cursor.fetchone(): raise Exception("El turno de caja indicado no está abierto.")

        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

        # 1. Sale plata física del cajón: se registra como RETIRO de tesorería (NO es Gasto Operativo,
        #    igual que una Sangría de Caja) para que el Cierre Z siga cuadrando.
        cursor.execute('''
            INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
            VALUES (?, ?, 'RETIRO', ?, ?, ?)
        ''', (fecha_actual, adelanto.usuario_registro, adelanto.monto,
              f"[ADELANTO DE SUELDO] {adelanto.detalle}", adelanto.turno_id))

        # 2. Queda como deuda del empleado, pendiente de descontarse en su próxima liquidación
        cursor.execute('''
            INSERT INTO movimientos_cuenta_empleado (usuario_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_registro)
            VALUES (?, ?, 'ADELANTO', ?, ?, ?)
        ''', (adelanto.usuario_id, fecha_actual, adelanto.monto, adelanto.detalle, adelanto.usuario_registro))

        conexion.commit()
        return {"mensaje": f"Adelanto de ${adelanto.monto} registrado. Se descontará en la próxima liquidación."}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.post("/cuenta_empleado/consumo", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def registrar_consumo_mercaderia(consumo: ConsumoMercaderiaNuevo):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        if not _verificar_pin_admin(cursor, consumo.pin_autorizante):
            raise Exception("PIN incorrecto o sin privilegios de Administrador.")

        cursor.execute("SELECT id FROM usuarios WHERE id = ?", (consumo.usuario_id,))
        if not cursor.fetchone(): raise Exception("El empleado no existe.")

        cursor.execute("SELECT nombre, costo_sin_iva, precio_venta_final FROM productos WHERE id = ?", (consumo.producto_id,))
        producto = cursor.fetchone()
        if not producto: raise Exception("El producto no existe.")

        if consumo.resolucion == "GASTO_LOCAL":
            if not consumo.categoria_gasto_id:
                raise Exception("Debés indicar la categoría de gasto para registrarlo como beneficio del local.")
            cursor.execute("SELECT id, tipo_categoria FROM categorias_gasto WHERE id = ?", (consumo.categoria_gasto_id,))
            categoria_consumo = cursor.fetchone()
            if not categoria_consumo: raise Exception("La categoría de gasto indicada no existe.")
            if (categoria_consumo['tipo_categoria'] or 'OPERATIVO') != 'OPERATIVO':
                raise Exception("Un beneficio regalado por el local siempre es un Gasto Operativo: elegí una categoría de ese tipo.")

        # El precio a aplicar depende de QUIÉN se hace cargo del costo real:
        # - Si se lo descontamos al empleado, es una "venta interna": paga lo mismo que pagaría
        #   cualquier cliente (precio de venta). Si no, el negocio le estaría regalando el margen.
        # - Si el local lo regala, lo que el negocio efectivamente pierde es lo que le costó
        #   comprarlo (costo), no la venta que nunca existió.
        if consumo.resolucion == "DESCUENTA_SUELDO":
            precio_unitario = producto['precio_venta_final'] or 0.0
        else:
            precio_unitario = producto['costo_sin_iva'] or 0.0

        monto_total = round(precio_unitario * consumo.cantidad, 2)
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        detalle_final = consumo.detalle or f"Consumo personal: {producto['nombre']}"

        # 1. Descontamos stock a costo, vía FIFO, DENTRO de esta misma transacción (auditoría completa)
        faltante = ejecutar_descuento_fifo(
            cursor, consumo.producto_id, consumo.cantidad,
            tipo_movimiento='CONSUMO_PERSONAL',
            motivo=f"{detalle_final} (Empleado #{consumo.usuario_id})",
            usuario_id=consumo.usuario_registro,
            fecha_hora=fecha_actual
        )
        if faltante > 0:
            raise Exception(f"No hay stock suficiente. Faltan {faltante} unidades.")

        if consumo.resolucion == "DESCUENTA_SUELDO":
            # 2a. Se lo descontamos de su próxima liquidación, a precio de venta (no a costo):
            #     es una venta interna, no un regalo. NO es gasto del local.
            cursor.execute('''
                INSERT INTO movimientos_cuenta_empleado (usuario_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_registro)
                VALUES (?, ?, 'CONSUMO_MERCADERIA', ?, ?, ?)
            ''', (consumo.usuario_id, fecha_actual, monto_total, detalle_final, consumo.usuario_registro))
            mensaje = f"Consumo registrado. Se descontará ${monto_total} de su próxima liquidación."
        else:
            # 2b. El local lo regala como beneficio: a costo, porque eso es lo que realmente pierde
            #     el negocio (SÍ impacta Ganancia Neta). No se mueve movimientos_caja porque no es
            #     una salida de efectivo del cajón.
            cursor.execute('''
                INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago, origen_fondos, usuario_id, turno_id)
                VALUES (?, ?, ?, ?, 'MERCADERIA', 'CONSUMO_PERSONAL', ?, NULL)
            ''', (fecha_actual, consumo.categoria_gasto_id, f"{detalle_final} (Empleado #{consumo.usuario_id})",
                  monto_total, consumo.usuario_registro))
            mensaje = f"Consumo registrado como beneficio del local (${monto_total})."

        conexion.commit()
        return {"mensaje": mensaje, "monto_total": monto_total, "precio_unitario_usado": precio_unitario}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/cuenta_empleado/{usuario_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def obtener_cuenta_empleado(usuario_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT * FROM movimientos_cuenta_empleado WHERE usuario_id = ? ORDER BY fecha_hora DESC
        ''', (usuario_id,))
        movimientos = [dict(r) for r in cursor.fetchall()]
        for m in movimientos:
            m['monto_saldado'] = m.get('monto_saldado') or 0
            m['saldo_restante'] = round(m['monto'] - m['monto_saldado'], 2)
        pendientes = [m for m in movimientos if m['liquidacion_id'] is None]
        return {
            "movimientos": movimientos,
            "saldo_pendiente": round(sum(m['saldo_restante'] for m in pendientes), 2)
        }
    finally:
        conexion.close()


# =================================================================
# 7. LIQUIDACIÓN DE SUELDOS
# =================================================================
@router.get("/liquidar/preview", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def previsualizar_liquidacion(usuario_id: int, periodo_desde: date, periodo_hasta: date):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        if periodo_hasta < periodo_desde:
            raise Exception("El período de liquidación es inválido (la fecha 'hasta' es anterior a 'desde').")

        cursor.execute("SELECT nombre_completo FROM usuarios WHERE id = ?", (usuario_id,))
        empleado = cursor.fetchone()
        if not empleado: raise Exception("El empleado no existe.")

        desde_str, hasta_str = periodo_desde.isoformat(), periodo_hasta.isoformat()
        tarifa = _obtener_tarifa_para_periodo(cursor, usuario_id, desde_str, hasta_str)
        modalidad, valor_unitario, cantidad_unidades, monto_bruto, _ = _calcular_bruto_periodo(cursor, usuario_id, tarifa, desde_str, hasta_str)
        tope_pct, descuento_aplicado, saldo_arrastrado, detalle_aplicaciones = _calcular_descuento_con_tope(cursor, usuario_id, monto_bruto)

        return {
            "empleado": empleado['nombre_completo'],
            "modalidad": modalidad,
            "valor_unitario": valor_unitario,
            "cantidad_unidades": cantidad_unidades,
            "monto_bruto": monto_bruto,
            "descuento_aplicado": descuento_aplicado,
            "monto_neto_estimado": round(monto_bruto - descuento_aplicado, 2),
            "saldo_pendiente_arrastrado": saldo_arrastrado,
            "tope_pct_usado": tope_pct,
            "detalle_descuentos": detalle_aplicaciones
        }
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()


@router.post("/liquidar", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def liquidar_sueldo(liq: LiquidacionNueva):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        if not _verificar_pin_admin(cursor, liq.pin_autorizante):
            raise Exception("PIN incorrecto o sin privilegios de Administrador.")

        if liq.periodo_hasta < liq.periodo_desde:
            raise Exception("El período de liquidación es inválido (la fecha 'hasta' es anterior a 'desde').")

        cursor.execute("SELECT id, nombre_completo FROM usuarios WHERE id = ?", (liq.usuario_id,))
        empleado = cursor.fetchone()
        if not empleado: raise Exception("El empleado no existe.")

        cursor.execute("SELECT id, tipo_categoria FROM categorias_gasto WHERE id = ?", (liq.categoria_gasto_id,))
        categoria = cursor.fetchone()
        if not categoria: raise Exception("La categoría de gasto indicada no existe.")
        if (categoria['tipo_categoria'] or 'OPERATIVO') != 'OPERATIVO':
            raise Exception("Un sueldo siempre es un Gasto Operativo: elegí una categoría de ese tipo.")

        desde_str, hasta_str = liq.periodo_desde.isoformat(), liq.periodo_hasta.isoformat()

        tarifa = _obtener_tarifa_para_periodo(cursor, liq.usuario_id, desde_str, hasta_str)
        modalidad, valor_unitario, cantidad_unidades, monto_bruto, partes_a_marcar = _calcular_bruto_periodo(
            cursor, liq.usuario_id, tarifa, desde_str, hasta_str
        )
        tope_pct, descuento_aplicado, saldo_arrastrado, detalle_aplicaciones = _calcular_descuento_con_tope(
            cursor, liq.usuario_id, monto_bruto
        )
        monto_neto_pagado = round(monto_bruto - descuento_aplicado, 2)
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

        # 1. El costo real del empleado SIEMPRE impacta como Gasto Operativo por el BRUTO completo,
        #    haya sido adelantado en parte o no (ese es el verdadero costo de tenerlo trabajando).
        cursor.execute('''
            INSERT INTO gastos_operativos (fecha, categoria_id, descripcion_detalle, monto, metodo_pago, origen_fondos, usuario_id, turno_id)
            VALUES (?, ?, ?, ?, 'LIQUIDACION_SUELDO', 'RRHH', ?, NULL)
        ''', (fecha_actual, liq.categoria_gasto_id,
              f"Liquidación {empleado['nombre_completo']} ({desde_str} a {hasta_str})",
              monto_bruto, liq.liquidado_por))
        gasto_id = cursor.lastrowid

        # 2. Insertamos la liquidación
        cursor.execute('''
            INSERT INTO liquidaciones_sueldos 
            (usuario_id, periodo_desde, periodo_hasta, modalidad_aplicada, cantidad_unidades, valor_unitario,
             monto_bruto, total_descuentos_aplicados, monto_neto_pagado, saldo_pendiente_arrastrado, tope_pct_usado,
             categoria_gasto_id, gasto_operativo_id, fecha_liquidacion, liquidado_por, estado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAGADO')
        ''', (liq.usuario_id, desde_str, hasta_str, modalidad, cantidad_unidades, valor_unitario,
              monto_bruto, descuento_aplicado, monto_neto_pagado, saldo_arrastrado, tope_pct,
              liq.categoria_gasto_id, gasto_id, fecha_actual, liq.liquidado_por))
        liquidacion_id = cursor.lastrowid

        # 3. Cerramos los partes de trabajo consumidos (si aplica la modalidad)
        if partes_a_marcar:
            placeholders = ','.join('?' for _ in partes_a_marcar)
            cursor.execute(
                f"UPDATE partes_de_trabajo SET liquidacion_id = ? WHERE id IN ({placeholders})",
                [liquidacion_id] + partes_a_marcar
            )

        # 4. Saldamos (total o PARCIALMENTE) los adelantos/consumos cubiertos por el tope.
        #    Si una deuda se saldó por completo, se marca liquidacion_id para que salga de la
        #    lista de "pendientes". Si quedó pagada solo en parte, sigue pendiente (liquidacion_id
        #    en NULL) pero con su monto_saldado actualizado, para que la próxima liquidación
        #    solo cobre el resto. En ambos casos queda un registro en el detalle para poder
        #    anular la liquidación con precisión más adelante.
        for item in detalle_aplicaciones:
            cursor.execute('''
                INSERT INTO liquidacion_descuentos_detalle (liquidacion_id, movimiento_cuenta_empleado_id, monto_aplicado)
                VALUES (?, ?, ?)
            ''', (liquidacion_id, item['movimiento_id'], item['monto_aplicado']))

            if item['queda_saldado']:
                cursor.execute('''
                    UPDATE movimientos_cuenta_empleado SET monto_saldado = monto, liquidacion_id = ?
                    WHERE id = ?
                ''', (liquidacion_id, item['movimiento_id']))
            else:
                cursor.execute('''
                    UPDATE movimientos_cuenta_empleado 
                    SET monto_saldado = ROUND(IFNULL(monto_saldado, 0) + ?, 2)
                    WHERE id = ?
                ''', (item['monto_aplicado'], item['movimiento_id']))

        conexion.commit()
        return {
            "mensaje": f"Liquidación #{liquidacion_id} generada con éxito.",
            "resumen": {
                "empleado": empleado['nombre_completo'],
                "modalidad": modalidad,
                "cantidad_unidades": cantidad_unidades,
                "valor_unitario": valor_unitario,
                "monto_bruto": monto_bruto,
                "descuento_aplicado": descuento_aplicado,
                "monto_neto_a_pagar": monto_neto_pagado,
                "saldo_pendiente_arrastrado": saldo_arrastrado,
                "detalle_descuentos": detalle_aplicaciones,
                "nota": "Si le pagás en efectivo del cajón, recordá registrar una Sangría de Caja por el monto neto."
            }
        }
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/liquidaciones/{usuario_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_liquidaciones(usuario_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT * FROM liquidaciones_sueldos WHERE usuario_id = ? ORDER BY fecha_liquidacion DESC
        ''', (usuario_id,))
        return {"liquidaciones": [dict(r) for r in cursor.fetchall()]}
    finally:
        conexion.close()


@router.put("/liquidaciones/{liquidacion_id}/anular", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def anular_liquidacion(liquidacion_id: int, anulacion: AnulacionLiquidacion):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        if not _verificar_pin_admin(cursor, anulacion.pin_autorizante):
            raise Exception("PIN incorrecto o sin privilegios de Administrador.")

        cursor.execute("SELECT * FROM liquidaciones_sueldos WHERE id = ?", (liquidacion_id,))
        liq = cursor.fetchone()
        if not liq: raise Exception("La liquidación no existe.")
        if liq['estado'] == 'ANULADO': raise Exception("Esta liquidación ya estaba anulada.")

        # Liberamos los partes de trabajo que esta liquidación había cerrado: vuelven a quedar
        # pendientes, disponibles para una nueva liquidación correcta.
        cursor.execute("UPDATE partes_de_trabajo SET liquidacion_id = NULL WHERE liquidacion_id = ?", (liquidacion_id,))

        # Revertimos con precisión los adelantos/consumos que esta liquidación pagó (total o
        # parcialmente), usando el detalle guardado en su momento: le devolvemos a cada
        # movimiento exactamente el monto que le habían aplicado, ni un centavo más ni menos.
        cursor.execute('''
            SELECT movimiento_cuenta_empleado_id, monto_aplicado 
            FROM liquidacion_descuentos_detalle WHERE liquidacion_id = ?
        ''', (liquidacion_id,))
        for detalle in cursor.fetchall():
            cursor.execute('''
                UPDATE movimientos_cuenta_empleado 
                SET monto_saldado = ROUND(MAX(IFNULL(monto_saldado, 0) - ?, 0), 2), liquidacion_id = NULL
                WHERE id = ?
            ''', (detalle['monto_aplicado'], detalle['movimiento_cuenta_empleado_id']))
        cursor.execute("DELETE FROM liquidacion_descuentos_detalle WHERE liquidacion_id = ?", (liquidacion_id,))

        # Red de seguridad para liquidaciones viejas (previas a esta migración) que no tengan
        # filas de detalle: las libera igual por las dudas, sin tocar monto_saldado.
        cursor.execute("UPDATE movimientos_cuenta_empleado SET liquidacion_id = NULL WHERE liquidacion_id = ?", (liquidacion_id,))

        # Soft-delete del gasto asociado (mismo patrón que ventas_cabecera.estado = 'ANULADA':
        # nunca se borra un registro contable, se marca).
        if liq['gasto_operativo_id']:
            cursor.execute("UPDATE gastos_operativos SET estado = 'ANULADO' WHERE id = ?", (liq['gasto_operativo_id'],))

        cursor.execute("UPDATE liquidaciones_sueldos SET estado = 'ANULADO' WHERE id = ?", (liquidacion_id,))

        conexion.commit()
        return {"mensaje": "Liquidación anulada. Los días/adelantos vuelven a estar disponibles para una nueva liquidación."}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()
