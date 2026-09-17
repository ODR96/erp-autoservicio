from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone, timedelta
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol
from backend.mod_productos.rutas_productos import compensar_deuda_stock

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3)) # <-- LA HORA ARGENTINA

class NuevoProveedor(BaseModel):
    nombre_comercial: str
    cuit: str = ""
    telefono_vendedor: str = ""
    observaciones: str = ""


class ItemFactura(BaseModel):
    producto_id: int
    cantidad_comprada: float
    costo_unitario: float
    nuevo_precio_venta: Optional[float] = None
    fecha_vencimiento: str = "2099-12-31"
    numero_lote_proveedor: str = "S/L"

class PagoInmediato(BaseModel):
    metodo_pago: str
    monto: float
    observaciones: str = ""
    turno_id: Optional[int] = None

class NuevaFacturaCompra(BaseModel):
    proveedor_id: int
    numero_factura: str
    condicion_pago: str
    cargos_extra: float = 0.0
    fecha_compra: str = ""
    forzar_duplicado: bool = False
    items: List[ItemFactura]
    pago_inmediato: Optional[PagoInmediato] = None
    
class PagoProveedor(BaseModel):
    proveedor_id: int
    monto_pagado: float
    metodo_pago: str
    observaciones: str = ""
    turno_id: Optional[int] = None

class DeudaRapida(BaseModel):
    proveedor_id: int
    numero_factura: str
    condicion_pago: str
    total_factura: float
    observaciones: str = ""
    fecha_compra: str = ""
    forzar_duplicado: bool = False
    pago_inmediato: Optional[PagoInmediato] = None


def _hoy_ar() -> str:
    return datetime.now(ZONA_AR).strftime("%Y-%m-%d")


def _normalizar_fecha_compra(fecha: Optional[str]) -> str:
    texto = (fecha or "").strip()[:10]
    if not texto:
        return _hoy_ar()
    try:
        datetime.strptime(texto, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Fecha de factura inválida.")
    return texto


def _numero_factura_clave(numero: str) -> str:
    return " ".join((numero or "").strip().upper().split())


def _buscar_factura_duplicada(cursor, proveedor_id: int, numero: str):
    clave = _numero_factura_clave(numero)
    if not clave:
        return None
    cursor.execute(
        '''
        SELECT id, numero_factura, fecha_compra, total_factura
        FROM compras_cabecera
        WHERE proveedor_id = ?
          AND UPPER(TRIM(numero_factura)) = ?
        ORDER BY id DESC
        LIMIT 1
        ''',
        (proveedor_id, clave),
    )
    return cursor.fetchone()


def _exigir_factura_unica(cursor, proveedor_id: int, numero: str, forzar: bool):
    dup = _buscar_factura_duplicada(cursor, proveedor_id, numero)
    if not dup:
        return
    if forzar:
        return
    fecha = dup["fecha_compra"] if isinstance(dup, sqlite3.Row) else dup[2]
    total = dup["total_factura"] if isinstance(dup, sqlite3.Row) else dup[3]
    raise HTTPException(
        status_code=409,
        detail=f"Ese N° ya está cargado ({fecha}, ${float(total or 0):.2f}). Revisá o confirmá el duplicado.",
    )


def _usuario_desde_payload(payload: dict) -> int:
    try:
        return int((payload or {}).get("sub") or 1)
    except (TypeError, ValueError):
        return 1


def _es_pago_efectivo_caja(metodo: str) -> bool:
    m = (metodo or "").strip().upper().replace("_", " ")
    return m == "EFECTIVO CAJA"


def _asegurar_ctacte(cursor, proveedor_id: int):
    cursor.execute("SELECT id FROM proveedores_ctacte WHERE proveedor_id = ?", (proveedor_id,))
    if not cursor.fetchone():
        cursor.execute(
            "INSERT INTO proveedores_ctacte (proveedor_id, saldo_deudor) VALUES (?, 0)",
            (proveedor_id,)
        )


def _sumar_deuda_proveedor(cursor, proveedor_id: int, monto: float):
    _asegurar_ctacte(cursor, proveedor_id)
    cursor.execute(
        "UPDATE proveedores_ctacte SET saldo_deudor = saldo_deudor + ? WHERE proveedor_id = ?",
        (monto, proveedor_id)
    )


def _asegurar_columna_usuario_pagos(cursor):
    cursor.execute('''CREATE TABLE IF NOT EXISTS pagos_proveedores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proveedor_id INTEGER,
        fecha_pago TEXT,
        monto_total_pagado REAL,
        metodo_pago TEXT,
        observaciones TEXT
    )''')
    cursor.execute("PRAGMA table_info(pagos_proveedores)")
    cols = [c[1] for c in cursor.fetchall()]
    if "usuario_id" not in cols:
        cursor.execute("ALTER TABLE pagos_proveedores ADD COLUMN usuario_id INTEGER DEFAULT 1")


def _registrar_pago_en_cursor(cursor, proveedor_id: int, monto: float, metodo: str,
                              observaciones: str, usuario_id: int, turno_id=None):
    """Historial + baja de saldo. Si es efectivo de registradora, RETIRO del turno. No toca gastos."""
    if monto <= 0:
        raise HTTPException(status_code=400, detail="El pago tiene que ser mayor a cero.")

    _asegurar_columna_usuario_pagos(cursor)
    _asegurar_ctacte(cursor, proveedor_id)
    fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute('''
        INSERT INTO pagos_proveedores (proveedor_id, fecha_pago, monto_total_pagado, metodo_pago, observaciones, usuario_id)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (proveedor_id, fecha_actual, monto, metodo, observaciones or "", usuario_id))

    cursor.execute(
        "UPDATE proveedores_ctacte SET saldo_deudor = saldo_deudor - ? WHERE proveedor_id = ?",
        (monto, proveedor_id)
    )

    retiro_caja = None
    if _es_pago_efectivo_caja(metodo):
        turno = None
        if turno_id:
            cursor.execute(
                "SELECT id FROM turnos_caja WHERE id = ? AND estado_turno = 'ABIERTO'",
                (turno_id,)
            )
            turno = cursor.fetchone()
        if not turno:
            cursor.execute(
                "SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO' ORDER BY id DESC LIMIT 1"
            )
            turno = cursor.fetchone()
        if not turno:
            raise HTTPException(
                status_code=400,
                detail="No hay caja abierta. Abrí un turno para pagar en efectivo de la registradora."
            )
        tid = turno[0] if not isinstance(turno, sqlite3.Row) else turno["id"]
        cursor.execute('''
            INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
            VALUES (?, ?, 'RETIRO', ?, ?, ?)
        ''', (fecha_actual, usuario_id, monto, f"Pago a proveedor #{proveedor_id}", tid))
        retiro_caja = tid

    return retiro_caja


def _aplicar_pago_inmediato(cursor, proveedor_id: int, total_factura: float, condicion: str,
                            pago: PagoInmediato, usuario_id: int):
    if pago.monto <= 0:
        raise HTTPException(status_code=400, detail="El pago inmediato tiene que ser mayor a cero.")
    if pago.monto > total_factura + 0.009:
        raise HTTPException(status_code=400, detail="El pago no puede ser mayor al total de la factura.")

    # Contado no sumaba saldo; si hay pago hay que abrir deuda y cancelarla (si es total, queda en 0).
    if condicion != "Cuenta Corriente":
        _sumar_deuda_proveedor(cursor, proveedor_id, total_factura)

    return _registrar_pago_en_cursor(
        cursor,
        proveedor_id,
        pago.monto,
        pago.metodo_pago,
        pago.observaciones,
        usuario_id,
        pago.turno_id,
    )


def _avisar_retiro_proveedor(background_tasks: BackgroundTasks, monto: float, proveedor_id: int,
                             usuario_id: int, turno_id):
    from backend.whatsapp_puente import avisar_retiro, nombre_usuario
    background_tasks.add_task(
        avisar_retiro,
        monto,
        f"Pago a proveedor #{proveedor_id}",
        nombre_usuario(usuario_id),
        turno_id,
    )

# --- 1. GESTIÓN DE PROVEEDORES (ABM COMPLETO) ---
@router.post("/alta", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def registrar_proveedor(prov: NuevoProveedor):
    conexion = obtener_conexion()
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

@router.get("/listado", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_proveedores(solo_activos: bool = False):
    conexion = obtener_conexion()
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

@router.put("/actualizar/{prov_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def actualizar_proveedor(prov_id: int, prov: NuevoProveedor): # <-- Borramos background_tasks
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        # AGREGAMOS LAS OBSERVACIONES AL UPDATE
        cursor.execute("UPDATE proveedores SET nombre_comercial=?, cuit=?, telefono_vendedor=?, observaciones=? WHERE id=?", 
                       (prov.nombre_comercial, prov.cuit, prov.telefono_vendedor, prov.observaciones, prov_id))
        
        conexion.commit()
        return {"mensaje": "Proveedor actualizado"}
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

@router.delete("/baja/{prov_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def baja_proveedor(prov_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute("UPDATE proveedores SET activo = 0 WHERE id = ?", (prov_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Proveedor desactivado"}

@router.put("/reactivar/{prov_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def reactivar_proveedor(prov_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute("UPDATE proveedores SET activo = 1 WHERE id = ?", (prov_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Proveedor reactivado"}

# --- EL CORAZÓN DE LOS PAGOS (PARCHE AQUÍ) ---
# --- REGISTRAR PAGO Y DESCONTAR DEUDA ---
# --- REGISTRAR PAGO Y DESCONTAR DEUDA ---
@router.post("/pagar")
def registrar_pago_proveedor(pago: PagoProveedor, background_tasks: BackgroundTasks,
                             payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))):
    usuario_id = _usuario_desde_payload(payload)
    rol = (payload or {}).get("rol") or ""
    if rol == "CAJERO" and not _es_pago_efectivo_caja(pago.metodo_pago):
        raise HTTPException(
            status_code=403,
            detail="El cajero solo puede pagar con efectivo de la registradora. Bolsillo o transferencia: Encargado o Admin."
        )

    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        retiro_caja = _registrar_pago_en_cursor(
            cursor,
            pago.proveedor_id,
            pago.monto_pagado,
            pago.metodo_pago,
            pago.observaciones,
            usuario_id,
            pago.turno_id,
        )
        conexion.commit()
        if retiro_caja is not None:
            _avisar_retiro_proveedor(background_tasks, pago.monto_pagado, pago.proveedor_id, usuario_id, retiro_caja)
        return {"mensaje": "Pago realizado con éxito"}
    except HTTPException:
        if conexion:
            conexion.rollback()
        raise
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

# --- DEUDA RÁPIDA (solo saldo + historial, sin stock) ---
@router.post("/deuda_rapida")
def registrar_deuda_rapida(deuda: DeudaRapida, background_tasks: BackgroundTasks,
                           payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    if deuda.total_factura <= 0:
        raise HTTPException(status_code=400, detail="El total tiene que ser mayor a cero.")
    if not deuda.numero_factura.strip():
        raise HTTPException(status_code=400, detail="Falta el número de factura o remito.")

    usuario_id = _usuario_desde_payload(payload)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id FROM proveedores WHERE id = ? AND IFNULL(activo, 1) = 1", (deuda.proveedor_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="El proveedor no existe o está inactivo.")

        numero = deuda.numero_factura.strip()
        _exigir_factura_unica(cursor, deuda.proveedor_id, numero, deuda.forzar_duplicado)
        fecha_compra = _normalizar_fecha_compra(deuda.fecha_compra)
        nota = (deuda.observaciones or "").strip() or "Carga rápida (sin detalle de ítems)"

        cursor.execute('''
            INSERT INTO compras_cabecera (proveedor_id, numero_factura, fecha_compra, total_factura, condicion_pago)
            VALUES (?, ?, ?, ?, ?)
        ''', (deuda.proveedor_id, numero, fecha_compra, deuda.total_factura, deuda.condicion_pago))
        compra_id = cursor.lastrowid

        cursor.execute('''
            INSERT INTO compras_detalle
                (compra_id, producto_id, descripcion_historica, cantidad_comprada, costo_unitario, fecha_vencimiento, numero_lote_proveedor)
            VALUES (?, NULL, ?, 1, ?, '2099-12-31', 'DEUDA-RAPIDA')
        ''', (compra_id, nota, deuda.total_factura))

        if deuda.condicion_pago == "Cuenta Corriente":
            _sumar_deuda_proveedor(cursor, deuda.proveedor_id, deuda.total_factura)

        retiro_caja = None
        if deuda.pago_inmediato:
            retiro_caja = _aplicar_pago_inmediato(
                cursor, deuda.proveedor_id, deuda.total_factura, deuda.condicion_pago,
                deuda.pago_inmediato, usuario_id
            )

        conexion.commit()
        if retiro_caja is not None:
            _avisar_retiro_proveedor(
                background_tasks, deuda.pago_inmediato.monto, deuda.proveedor_id, usuario_id, retiro_caja
            )
        return {
            "mensaje": "Deuda registrada. No se tocó el stock.",
            "id": compra_id,
            "total": deuda.total_factura
        }
    except HTTPException:
        conexion.rollback()
        raise
    except Exception as e:
        conexion.rollback()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}
    finally:
        conexion.close()

@router.get("/comprobar_factura", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def comprobar_factura(proveedor_id: int, numero: str):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        dup = _buscar_factura_duplicada(cursor, proveedor_id, numero)
        if not dup:
            return {"duplicada": False}
        return {
            "duplicada": True,
            "id": dup["id"],
            "numero_factura": dup["numero_factura"],
            "fecha_compra": dup["fecha_compra"],
            "total_factura": dup["total_factura"],
        }
    finally:
        conexion.close()


# --- 2. INGRESO DE MERCADERÍA (CON ACTUALIZACIÓN DE SALDO) ---
@router.post("/cargar_factura")
def ingresar_mercaderia(factura: NuevaFacturaCompra, background_tasks: BackgroundTasks,
                        payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    if not factura.items:
        raise HTTPException(status_code=400, detail="La factura no tiene productos.")
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        numero = (factura.numero_factura or "").strip() or f"INT-{int(datetime.now(ZONA_AR).timestamp())}"
        _exigir_factura_unica(cursor, factura.proveedor_id, numero, factura.forzar_duplicado)
        fecha_compra = _normalizar_fecha_compra(factura.fecha_compra)
        total_acumulado = 0.0
        
        # 1. Creamos la cabecera de la compra
        cursor.execute('''
            INSERT INTO compras_cabecera (proveedor_id, numero_factura, fecha_compra, total_factura, condicion_pago)
            VALUES (?, ?, ?, 0, ?)
        ''', (factura.proveedor_id, numero, fecha_compra, factura.condicion_pago))
        compra_id = cursor.lastrowid
        
        # 2. Procesamos cada producto que llegó en el camión
        for item in factura.items:
            if item.cantidad_comprada <= 0:
                raise HTTPException(status_code=400, detail="Hay un ítem con cantidad inválida.")
            if item.costo_unitario < 0:
                raise HTTPException(status_code=400, detail="Hay un ítem con costo negativo.")
            subtotal_item = item.cantidad_comprada * item.costo_unitario
            total_acumulado += subtotal_item
            
            cursor.execute("SELECT nombre FROM productos WHERE id = ?", (item.producto_id,))
            prod = cursor.fetchone()
            if not prod:
                raise HTTPException(status_code=400, detail=f"El producto #{item.producto_id} no existe.")

            cursor.execute('''
                INSERT INTO compras_detalle 
                (compra_id, producto_id, descripcion_historica, cantidad_comprada, costo_unitario, fecha_vencimiento, numero_lote_proveedor)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (compra_id, item.producto_id, prod['nombre'], item.cantidad_comprada, item.costo_unitario, item.fecha_vencimiento, item.numero_lote_proveedor))
            
            cursor.execute('''
                INSERT INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo')
            ''', (item.producto_id, item.numero_lote_proveedor, fecha_compra, item.fecha_vencimiento, item.cantidad_comprada, item.cantidad_comprada, item.costo_unitario))

            compensar_deuda_stock(cursor, item.producto_id, fecha_compra)

            # Costo siempre (CMV). Góndola solo si el operador la tildó.
            cursor.execute(
                "UPDATE productos SET costo_sin_iva = ? WHERE id = ?",
                (item.costo_unitario, item.producto_id),
            )
            if item.nuevo_precio_venta is not None:
                cursor.execute(
                    "UPDATE productos SET precio_venta_final = ? WHERE id = ?",
                    (item.nuevo_precio_venta, item.producto_id),
                )

# 3. ACTUALIZAMOS EL TOTAL DE LA FACTURA (Sumando los cargos extra)
        total_final_real = total_acumulado + factura.cargos_extra
        cursor.execute("UPDATE compras_cabecera SET total_factura = ? WHERE id = ?", (total_final_real, compra_id))
        
        # 4. SUMAMOS A LA DEUDA (Si es Cuenta Corriente)
        if factura.condicion_pago == "Cuenta Corriente":
            _sumar_deuda_proveedor(cursor, factura.proveedor_id, total_final_real)

        retiro_caja = None
        if factura.pago_inmediato:
            retiro_caja = _aplicar_pago_inmediato(
                cursor, factura.proveedor_id, total_final_real, factura.condicion_pago,
                factura.pago_inmediato, _usuario_desde_payload(payload)
            )

        conexion.commit()
        if retiro_caja is not None:
            _avisar_retiro_proveedor(
                background_tasks, factura.pago_inmediato.monto, factura.proveedor_id,
                _usuario_desde_payload(payload), retiro_caja
            )
        conexion.close()
        return {"mensaje": "Stock, Precios y Deuda actualizados correctamente", "total": total_final_real}
        
    except HTTPException:
        if conexion:
            conexion.rollback()
            conexion.close()
        raise
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
    
    # --- HISTORIAL DE COMPRAS ---
@router.get("/historial/{proveedor_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ver_historial_compras(proveedor_id: int):
    conexion = obtener_conexion()
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
    
    # --- VER DETALLE DE UNA FACTURA ESPECÍFICA ---
@router.get("/factura_detalle/{compra_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ver_detalle_factura(compra_id: int):
    conexion = obtener_conexion()
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
    
@router.get("/historial_pagos/{proveedor_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ver_pagos(proveedor_id: int):
    conexion = obtener_conexion()
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
        
def migrar_proveedores():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("ALTER TABLE proveedores ADD COLUMN observaciones TEXT DEFAULT ''")
        conexion.commit()
    except:
        pass
    try:
        cursor.execute("ALTER TABLE movimientos_caja ADD COLUMN turno_id INTEGER")
        conexion.commit()
    except:
        pass # Si ya existe, no hace nada
    conexion.close()

migrar_proveedores()