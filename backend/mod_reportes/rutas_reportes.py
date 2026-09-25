from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from pydantic import BaseModel
from datetime import datetime, timedelta, timezone
from typing import List, Literal
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()

ZONA_AR = timezone(timedelta(hours=-3))


def _ahora_ar():
    return datetime.now(ZONA_AR)


def _hoy_ar_iso():
    return _ahora_ar().strftime("%Y-%m-%d")


def _mes_ar(mes: str = None):
    return mes or _ahora_ar().strftime("%Y-%m")


def _calcular_sueldos_comprometidos(cursor, mes: str) -> float:
    """Sueldos que este mes YA se van a deber y todavía NO se liquidaron.

    - MENSUAL: la tarifa vigente menos lo ya liquidado (PAGADO) en ese mes.
    - JORNAL / POR_HORA: solo días u horas ya cargados y sin liquidar en ese mes.
      No inventamos el resto del mes (el empleado puede no venir).

    Nunca se suma lo que ya está en gastos_operativos por una liquidación:
    eso ya vive en 'gastos del local'. Acá solo el hueco.
    """
    desde_mes = f"{mes}-01"
    try:
        cursor.execute('''
            SELECT usuario_id, modalidad_pago, valor, vigente_desde
            FROM historial_tarifas_empleado
            WHERE vigente_hasta IS NULL AND vigente_desde <= ?
        ''', (f"{mes}-31",))
        tarifas = cursor.fetchall()
    except sqlite3.OperationalError:
        return 0.0

    if not tarifas:
        return 0.0

    comprometido = 0.0
    for t in tarifas:
        usuario_id = t['usuario_id'] if isinstance(t, sqlite3.Row) else t[0]
        modalidad = t['modalidad_pago'] if isinstance(t, sqlite3.Row) else t[1]
        valor = t['valor'] if isinstance(t, sqlite3.Row) else t[2]

        if modalidad == 'MENSUAL':
            cursor.execute('''
                SELECT IFNULL(SUM(monto_bruto), 0) FROM liquidaciones_sueldos
                WHERE usuario_id = ? AND estado = 'PAGADO'
                AND strftime('%Y-%m', fecha_liquidacion) = ?
            ''', (usuario_id, mes))
            ya_liquidado = cursor.fetchone()[0] or 0.0
            hueco = round((valor or 0) - ya_liquidado, 2)
            if hueco > 0:
                comprometido += hueco
        else:
            cursor.execute('''
                SELECT IFNULL(SUM(presente), 0), IFNULL(SUM(horas_trabajadas), 0)
                FROM partes_de_trabajo
                WHERE usuario_id = ? AND liquidacion_id IS NULL
                AND fecha >= ? AND fecha <= ?
            ''', (usuario_id, desde_mes, f"{mes}-31"))
            dias, horas = cursor.fetchone()
            unidades = (horas or 0) if modalidad == 'POR_HORA' else (dias or 0)
            if unidades > 0:
                comprometido += round(unidades * (valor or 0), 2)

    return round(comprometido, 2)

# =================================================================
# MIGRACIÓN AUTOMÁTICA (mismo patrón que mod_gastos/mod_rrhh): a diferencia de antes,
# esta tabla ya NO depende de que alguien haya corrido crear_base.py/actualizar_bas.py
# a mano, ni de que se haya registrado al menos un faltante (la columna usuario_anoto
# se creaba recién ahí). Si faltaba la tabla o la columna, GET /faltantes_pendientes
# tiraba 500 apenas alguien abría la pantalla de Proveedores.
# =================================================================
def asegurar_tablas_reportes():
    conexion = obtener_conexion()
    cursor = conexion.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS productos_solicitados_faltantes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
            descripcion_producto TEXT,
            cantidad_pedida REAL,
            notas TEXT
        )
    ''')

    cursor.execute("PRAGMA table_info(productos_solicitados_faltantes)")
    columnas = [c[1] for c in cursor.fetchall()]
    nuevas = {
        'usuario_anoto': "TEXT DEFAULT 'Desconocido'",
        'estado': "TEXT DEFAULT 'PENDIENTE'",
        'fecha_pedido': 'TEXT',
        'fecha_recibido': 'TEXT',
        'origen': "TEXT DEFAULT 'POS'",
    }
    for col, ddl in nuevas.items():
        if col not in columnas:
            cursor.execute(f"ALTER TABLE productos_solicitados_faltantes ADD COLUMN {col} {ddl}")

    # Stock mínimo / lista de compras no es faltante de mostrador.
    cursor.execute('''
        UPDATE productos_solicitados_faltantes
        SET origen = 'COMPRAS'
        WHERE IFNULL(origen, 'POS') = 'POS'
          AND usuario_anoto = 'Sistema (stock mínimo)'
    ''')

    conexion.commit()
    conexion.close()

asegurar_tablas_reportes()

# 1. ACTUALIZAMOS EL MODELO PARA SABER QUIÉN PIDE
class ProductoFaltante(BaseModel):
    descripcion: str
    cantidad: float = 1.0
    notas: str = ""
    usuario_nombre: str = "Desconocido"
    origen: Literal['POS', 'COMPRAS'] = 'POS'

class CambioEstadoFaltantes(BaseModel):
    ids: List[int]
    estado: Literal['PENDIENTE', 'PEDIDO', 'RECIBIDO']

class CambioCantidadFaltante(BaseModel):
    id: int
    cantidad: float

class ItemPedidoWhatsApp(BaseModel):
    producto: str
    cantidad: str = "1"
    observacion: str = ""

class PedidoFaltantesWhatsApp(BaseModel):
    items: List[ItemPedidoWhatsApp]
    quien: str = ""

# --- 1. ALERTAS DEL DASHBOARD (Para ver a la mañana) ---
@router.get("/alertas", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_alertas_dashboard():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # EL ARREGLO: Agregamos p.proveedor_habitual_id a la consulta SELECT
        cursor.execute('''
            SELECT p.id as producto_id, p.nombre, p.stock_minimo_alerta, p.proveedor_habitual_id,
                   IFNULL(p.costo_sin_iva, 0) as costo_sin_iva,
                   IFNULL((SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = p.id AND estado_lote = 'Activo'), 0) as stock_actual
            FROM productos p
            WHERE stock_actual <= p.stock_minimo_alerta 
            AND p.activo = 1
            AND p.id NOT IN (SELECT producto_padre_id FROM productos_combos)
        ''')
        alertas_stock = [dict(row) for row in cursor.fetchall()]

        # EL ARREGLO: Agregamos p.id as producto_id
        cursor.execute('''
            SELECT p.id as producto_id, p.nombre, l.numero_lote_proveedor, l.fecha_vencimiento, l.cantidad_disponible 
            FROM lotes_stock l
            JOIN productos p ON l.producto_id = p.id
            WHERE l.cantidad_disponible > 0 
            AND l.estado_lote = 'Activo' 
            AND l.fecha_vencimiento <= date(?, '+' || IFNULL(p.dias_alerta_vencimiento, 30) || ' days')
            AND p.id NOT IN (SELECT producto_padre_id FROM productos_combos)
            ORDER BY l.fecha_vencimiento ASC
        ''', (_hoy_ar_iso(),))
        alertas_vencimiento = [dict(row) for row in cursor.fetchall()]
        return {"alertas_stock_critico": alertas_stock, "alertas_vencimientos": alertas_vencimiento}
    finally:
        conexion.close()


# --- 2. LA VERDAD DE LA MILANESA: GANANCIA NETA REAL ---
@router.get("/ganancia_neta", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def calcular_ganancia_neta(mes: str = None):
    mes = _mes_ar(mes)

    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()

    try:
        # 1. INGRESOS BRUTOS (Toda la plata de ventas cobradas o fiadas confirmadas)
        cursor.execute('''
            SELECT SUM(total_venta) FROM ventas_cabecera 
            WHERE strftime('%Y-%m', fecha_hora) = ? 
            AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
        ''', (mes,))
        ingresos = cursor.fetchone()[0] or 0.0

        comisiones = 0.0
        try:
            cursor.execute('''
                SELECT IFNULL(SUM(comision_medio), 0) FROM ventas_cabecera
                WHERE strftime('%Y-%m', fecha_hora) = ?
                AND estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
            ''', (mes,))
            comisiones = cursor.fetchone()[0] or 0.0
        except sqlite3.OperationalError:
            comisiones = 0.0

        # 2. CMV: costo del lote al momento de vender. Ventas viejas (NULL) usan el maestro.
        cursor.execute('''
            SELECT SUM(v.cantidad * COALESCE(v.costo_unitario_historico, p.costo_sin_iva, 0))
            FROM ventas_detalle v
            JOIN ventas_cabecera c ON v.venta_id = c.id
            LEFT JOIN productos p ON v.producto_id = p.id
            WHERE strftime('%Y-%m', c.fecha_hora) = ?
            AND c.estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
        ''', (mes,))
        costos_mercaderia = cursor.fetchone()[0] or 0.0

        # 3. GASTOS OPERATIVOS FIJOS (Los que cargaste en el módulo de Gastos)
        # BLINDAJE: excluimos categorías RETIRO_SOCIO / MOVIMIENTO_INTERNO, que son
        # movimientos de tesorería y NO deben afectar la rentabilidad del negocio.
        cursor.execute('''
            SELECT SUM(g.monto) 
            FROM gastos_operativos g
            JOIN categorias_gasto c ON g.categoria_id = c.id
            WHERE strftime('%Y-%m', g.fecha) = ?
            AND IFNULL(c.tipo_categoria, 'OPERATIVO') = 'OPERATIVO'
            AND IFNULL(g.estado, 'ACTIVO') = 'ACTIVO'
        ''', (mes,))
        gastos = cursor.fetchone()[0] or 0.0

        sueldos_comprometidos = _calcular_sueldos_comprometidos(cursor, mes)
        piso_operativo_mes = round(gastos + sueldos_comprometidos, 2)

        # 3b. MERMAS: pérdida de mercadería (no es CMV de lo vendido ni gasto de caja/cheques)
        mermas = 0.0
        try:
            cursor.execute('''
                SELECT IFNULL(SUM(costo_perdido), 0) FROM registro_mermas
                WHERE strftime('%Y-%m', fecha_hora) = ?
            ''', (mes,))
            mermas = cursor.fetchone()[0] or 0.0
        except sqlite3.OperationalError:
            mermas = 0.0

        # 4. MATEMÁTICA PURA DE NEGOCIOS (hechos: no mezcla proyección)
        ganancia_neta = ingresos - costos_mercaderia - comisiones - gastos - mermas
        
        # Sacamos el porcentaje de rentabilidad
        margen_porcentaje = (ganancia_neta / ingresos * 100) if ingresos > 0 else 0

        conexion.close()

        return {
            "mes_analizado": mes,
            "resumen_financiero": {
                "1_ingresos_por_ventas": round(ingresos, 2),
                "2_costo_de_la_mercaderia": round(costos_mercaderia, 2),
                "3_gastos_del_local": round(gastos, 2),
                "4_GANANCIA_NETA_PURA": round(ganancia_neta, 2),
                "5_rentabilidad_del_mes": f"{round(margen_porcentaje, 2)}%",
                "6_sueldos_comprometidos": sueldos_comprometidos,
                "7_piso_operativo_mes": piso_operativo_mes,
                "8_mermas_del_mes": round(mermas, 2),
                "9_comisiones_medios": round(comisiones, 2)
            }
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
    
@router.post("/registrar_faltante", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_pedido_no_encontrado(p: ProductoFaltante):
    if not (p.descripcion or "").strip():
        raise HTTPException(status_code=400, detail="Falta el nombre del producto.")
    if p.cantidad <= 0:
        raise HTTPException(status_code=400, detail="La cantidad tiene que ser mayor a cero.")
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            INSERT INTO productos_solicitados_faltantes
                (descripcion_producto, cantidad_pedida, notas, usuario_anoto, estado, fecha_hora, origen)
            VALUES (?, ?, ?, ?, 'PENDIENTE', ?, ?)
        ''', (p.descripcion, p.cantidad, p.notas, p.usuario_nombre, _ahora_ar().strftime("%Y-%m-%d %H:%M:%S"), p.origen))
        nuevo_id = cursor.lastrowid
        conexion.commit()
        return {"mensaje": "Anotado.", "id": nuevo_id}
    finally:
        conexion.close()

@router.post("/faltantes/whatsapp", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def enviar_pedido_faltantes_whatsapp(pedido: PedidoFaltantesWhatsApp, background_tasks: BackgroundTasks):
    items = [i for i in pedido.items if (i.producto or "").strip()]
    if not items:
        raise HTTPException(status_code=400, detail="No hay ítems para enviar.")

    from backend.whatsapp_puente import avisar_pedido_faltantes, destino_grupo_compras
    if not destino_grupo_compras():
        raise HTTPException(status_code=400, detail="Falta el grupo de compras en Configuración.")

    serial = [
        {"producto": i.producto.strip(), "cantidad": i.cantidad or "1", "observacion": i.observacion or ""}
        for i in items
    ]
    background_tasks.add_task(avisar_pedido_faltantes, serial, (pedido.quien or "").strip())
    return {"mensaje": "Pedido disparado al grupo de WhatsApp.", "items": len(serial)}

@router.get("/faltantes_pendientes", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_faltantes_pendientes():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT f.id,
                   f.descripcion_producto,
                   f.cantidad_pedida,
                   f.notas,
                   f.usuario_anoto,
                   f.fecha_hora,
                   IFNULL(f.estado, 'PENDIENTE') AS estado,
                   f.fecha_pedido,
                   f.fecha_recibido,
                   CASE
                       WHEN COUNT(p.id) = 1 THEN IFNULL(MAX(p.costo_sin_iva), 0)
                       ELSE NULL
                   END AS costo_sin_iva
            FROM productos_solicitados_faltantes f
            LEFT JOIN productos p
              ON lower(trim(p.nombre)) = lower(trim(f.descripcion_producto))
            GROUP BY f.id
            ORDER BY CASE IFNULL(f.estado, 'PENDIENTE')
                        WHEN 'PENDIENTE' THEN 0
                        WHEN 'PEDIDO' THEN 1
                        ELSE 2
                     END,
                     f.id DESC
        ''')
        faltantes = [dict(row) for row in cursor.fetchall()]
        return {"faltantes": faltantes}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()

@router.patch("/faltantes/estado", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def cambiar_estado_faltantes(cambio: CambioEstadoFaltantes):
    ids = list(dict.fromkeys([i for i in cambio.ids if i]))
    if not ids:
        raise HTTPException(status_code=400, detail="Seleccioná al menos un producto.")

    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        ahora = _ahora_ar().strftime("%Y-%m-%d %H:%M:%S")
        placeholders = ",".join("?" * len(ids))
        if cambio.estado == "PEDIDO":
            cursor.execute(
                f'''UPDATE productos_solicitados_faltantes
                    SET estado = 'PEDIDO', fecha_pedido = ?
                    WHERE id IN ({placeholders})''',
                [ahora, *ids]
            )
        elif cambio.estado == "RECIBIDO":
            cursor.execute(
                f'''UPDATE productos_solicitados_faltantes
                    SET estado = 'RECIBIDO', fecha_recibido = ?
                    WHERE id IN ({placeholders})''',
                [ahora, *ids]
            )
        else:
            cursor.execute(
                f'''UPDATE productos_solicitados_faltantes
                    SET estado = 'PENDIENTE', fecha_pedido = NULL, fecha_recibido = NULL
                    WHERE id IN ({placeholders})''',
                ids
            )
        conexion.commit()
        return {"mensaje": "Estado actualizado.", "actualizados": cursor.rowcount, "estado": cambio.estado}
    finally:
        conexion.close()

@router.patch("/faltantes/cantidad", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def cambiar_cantidad_faltante(cambio: CambioCantidadFaltante):
    if cambio.cantidad <= 0:
        raise HTTPException(status_code=400, detail="La cantidad tiene que ser mayor a cero.")

    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute(
            "UPDATE productos_solicitados_faltantes SET cantidad_pedida = ? WHERE id = ?",
            (cambio.cantidad, cambio.id)
        )
        conexion.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="El faltante ya no existe.")
        return {"mensaje": "Cantidad actualizada.", "id": cambio.id, "cantidad": cambio.cantidad}
    finally:
        conexion.close()

@router.delete("/resolver_faltante/{faltante_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def borrar_faltante_resuelto(faltante_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("DELETE FROM productos_solicitados_faltantes WHERE id = ?", (faltante_id,))
        conexion.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="El faltante ya no existe.")
        return {"mensaje": "Quitado de la lista"}
    finally:
        conexion.close()

# --- 2. RANKING DE PRODUCTOS (Top Ventas) ---
@router.get("/ranking_ventas", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def obtener_ranking_productos(periodo: str = "dia", mes: str = None, limit: int = 10):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()

    hoy = _hoy_ar_iso()
    tope = max(1, min(int(limit or 10), 100))
    if mes:
        filtro = "strftime('%Y-%m', vc.fecha_hora) = ?"
        params = (_mes_ar(mes),)
    elif periodo == "dia":
        filtro = "date(vc.fecha_hora) = ?"
        params = (hoy,)
    elif periodo == "semana":
        filtro = "date(vc.fecha_hora) >= date(?, '-7 days')"
        params = (hoy,)
    else:
        filtro = "strftime('%Y-%m', vc.fecha_hora) = ?"
        params = (_mes_ar(),)

    query = f'''
        SELECT p.nombre, SUM(vd.cantidad) as total_vendido, SUM(vd.subtotal) as recaudacion
        FROM ventas_detalle vd
        JOIN ventas_cabecera vc ON vd.venta_id = vc.id
        JOIN productos p ON vd.producto_id = p.id
        WHERE {filtro}
        AND vc.estado != 'ANULADA'
        GROUP BY p.id
        ORDER BY total_vendido DESC
        LIMIT {tope}
    '''
    cursor.execute(query, params)
    ranking = cursor.fetchall()
    conexion.close()
    return [dict(r) for r in ranking]

# --- 3. BAJA ROTACIÓN (Los "Clavos" que no se mueven) ---
@router.get("/baja_rotacion", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def productos_sin_salida():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # EL ARREGLO: Calcula dias_clavado y filtra los ingresados hoy
        hoy = _hoy_ar_iso()
        query = '''
            SELECT p.id as producto_id, p.nombre, 
                   SUM(l.cantidad_disponible) as stock_estancado,
                   CAST(julianday(?) - julianday(MIN(l.fecha_ingreso)) AS INTEGER) as dias_clavado
            FROM productos p
            JOIN lotes_stock l ON p.id = l.producto_id
            WHERE l.cantidad_disponible > 0 AND l.estado_lote = 'Activo'
            AND l.fecha_ingreso <= date(?, '-30 days')
            AND p.id NOT IN (
                SELECT vd.producto_id
                FROM ventas_detalle vd
                JOIN ventas_cabecera vc ON vd.venta_id = vc.id
                WHERE date(vc.fecha_hora) >= date(?, '-30 days')
                AND vc.estado != 'ANULADA'
            )
            GROUP BY p.id
        '''
        cursor.execute(query, (hoy, hoy, hoy))
        estancados = [dict(e) for e in cursor.fetchall()]
        return estancados
    finally:
        conexion.close()

@router.get("/ventas_por_pago", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def ventas_por_metodo(mes: str = None):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        query = '''
            WITH VentasPuras AS (
                -- 1. Ventas puras (Toman el nombre tal cual viene de la caja principal)
                SELECT metodo_pago, COUNT(id) as cantidad_transacciones, SUM(total_venta) as total_dinero
                FROM ventas_cabecera
                WHERE strftime('%Y-%m', fecha_hora) = ?
                AND metodo_pago != 'MIXTO'
                AND estado != 'ANULADA'
                GROUP BY metodo_pago
            ),
            VentasMixtas AS (
                -- 2. Ventas Mixtas (TRADUCIMOS los nombres internos para que coincidan con los puros)
                SELECT 
                    CASE 
                        WHEN UPPER(vm.metodo_pago) = 'TARJETA' THEN 'Tarjeta / POS'
                        WHEN UPPER(vm.metodo_pago) = 'TRANSFERENCIA' THEN 'Billetera Virtual / QR'
                        WHEN UPPER(vm.metodo_pago) = 'EFECTIVO' THEN 'EFECTIVO'
                        ELSE vm.metodo_pago 
                    END as metodo_pago_traducido, 
                    COUNT(DISTINCT vc.id) as cantidad_transacciones, 
                    SUM(vm.monto) as total_dinero
                FROM ventas_pagos_mixtos vm
                JOIN ventas_cabecera vc ON vm.venta_id = vc.id
                WHERE strftime('%Y-%m', vc.fecha_hora) = ?
                AND vc.estado != 'ANULADA'
                GROUP BY metodo_pago_traducido
            )
            -- 3. Unimos y sumamos todo bajo los nombres ya unificados
            SELECT 
                metodo_pago_traducido as metodo_pago, 
                SUM(cantidad_transacciones) as cantidad_transacciones, 
                SUM(total_dinero) as total_dinero
            FROM (
                SELECT metodo_pago as metodo_pago_traducido, cantidad_transacciones, total_dinero FROM VentasPuras
                UNION ALL
                SELECT metodo_pago_traducido, cantidad_transacciones, total_dinero FROM VentasMixtas
            )
            GROUP BY metodo_pago_traducido
            ORDER BY total_dinero DESC
        '''
        mes = _mes_ar(mes)
        cursor.execute(query, (mes, mes))
        metodos = [dict(row) for row in cursor.fetchall()]
        return metodos
    except Exception as e:
        print(f"🚨 Error en ventas_por_pago: {e}")
        return {"error": str(e)}
    finally:
        conexion.close()

class LanzarOferta(BaseModel):
    producto_id: int
    porcentaje_descuento: float # Ej: 20 para un 20% OFF
    motivo: str # "Vencimiento Cercano" o "Baja Rotación"

@router.post("/lanzar_oferta", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def crear_oferta_urgente(oferta: LanzarOferta):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    try:
        # A. Buscamos el precio actual
        cursor.execute("SELECT precio_venta_final, nombre FROM productos WHERE id = ?", (oferta.producto_id,))
        prod = cursor.fetchone()
        
        nuevo_precio = round(prod[0] * (1 - (oferta.porcentaje_descuento / 100)), 2)
        nuevo_nombre = f"OFERTA {prod[1]}"
        
        # B. Actualizamos el producto para que la caja lo cobre barato YA
        cursor.execute('''
            UPDATE productos 
            SET precio_venta_final = ?, 
                nombre = ? 
            WHERE id = ?
        ''', (nuevo_precio, nuevo_nombre, oferta.producto_id))
        
        # C. Lo mandamos a la COLA DE IMPRESIÓN (para el cartel de góndola)
        cursor.execute('''
            INSERT INTO cola_impresion_etiquetas (producto_id, tipo_cartel, cantidad_copias)
            VALUES (?, 'OFERTA_A4', 2)
        ''', (oferta.producto_id,))
        
        conexion.commit()
        conexion.close()
        return {"mensaje": f"¡Oferta lanzada! El {prod[1]} ahora cuesta ${nuevo_precio}. Imprimí los carteles ahora."}
        
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
        
        
@router.get("/detalle_ventas_hora", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def detalle_ventas_por_hora(hora: str):
    # MAGIA: .zfill(2) transforma un "8" en "08", o deja el "11" como "11"
    hora_corta = hora.split(":")[0].zfill(2)
    
    # Buscamos el día exacto en Argentina
    fecha_hoy = datetime.now(ZONA_AR).strftime("%Y-%m-%d")
    
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # Buscamos los tickets cruzando exactamente fecha y hora formadas
        query = '''
            SELECT id, numero_ticket, metodo_pago, total_venta, cajero_nombre
            FROM ventas_cabecera
            WHERE date(fecha_hora) = ?
            AND strftime('%H', fecha_hora) = ?
            AND estado != 'ANULADA'
            ORDER BY fecha_hora DESC
        '''
        cursor.execute(query, (fecha_hoy, hora_corta))
        tickets = [dict(row) for row in cursor.fetchall()]
        
        return {"hora": hora, "tickets": tickets}
    except Exception as e:
        print(f"🚨 Error en detalle_hora: {e}")
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/cierres", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_cierres_mes(mes: str = None, incluir_oficina: bool = False):
    mes = _mes_ar(mes)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT COUNT(*)
            FROM turnos_caja t
            LEFT JOIN cajas_fisicas cf ON t.caja_id = cf.id
            WHERE strftime('%Y-%m', t.fecha_hora_apertura) = ?
              AND IFNULL(cf.solo_admin, 0) = 1
        ''', (mes,))
        ocultos_oficina = cursor.fetchone()[0] or 0

        cursor.execute('''
            WITH ventas_turno AS (
                SELECT turno_id,
                       COUNT(id) AS tickets,
                       IFNULL(SUM(total_venta), 0) AS ventas,
                       IFNULL(SUM(IFNULL(comision_medio, 0)), 0) AS comision
                FROM ventas_cabecera
                WHERE estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
                GROUP BY turno_id
            ),
            cmv_turno AS (
                SELECT c.turno_id,
                       IFNULL(SUM(d.cantidad * COALESCE(d.costo_unitario_historico, p.costo_sin_iva, 0)), 0) AS cmv
                FROM ventas_detalle d
                JOIN ventas_cabecera c ON d.venta_id = c.id
                LEFT JOIN productos p ON d.producto_id = p.id
                WHERE c.estado IN ('COMPLETADA', 'PAGADO_PENDIENTE_ENTREGA', 'ENTREGADA')
                GROUP BY c.turno_id
            )
            SELECT t.id, t.caja_id, t.fecha_hora_apertura, t.fecha_hora_cierre,
                   t.monto_inicial, t.monto_final_sistema, t.monto_final_declarado,
                   t.diferencia, t.estado_turno,
                   IFNULL(u.nombre_completo, '—') as cajero,
                   IFNULL(cf.nombre, '') as caja_nombre,
                   IFNULL(cf.solo_admin, 0) as solo_admin,
                   IFNULL(vt.tickets, 0) as tickets,
                   IFNULL(vt.ventas, 0) as ventas,
                   IFNULL(vt.comision, 0) as comision,
                   IFNULL(ct.cmv, 0) as cmv,
                   ROUND(IFNULL(vt.ventas, 0) - IFNULL(ct.cmv, 0) - IFNULL(vt.comision, 0), 2) as ganancia_bruta
            FROM turnos_caja t
            LEFT JOIN usuarios u ON t.usuario_id = u.id
            LEFT JOIN cajas_fisicas cf ON t.caja_id = cf.id
            LEFT JOIN ventas_turno vt ON vt.turno_id = t.id
            LEFT JOIN cmv_turno ct ON ct.turno_id = t.id
            WHERE strftime('%Y-%m', t.fecha_hora_apertura) = ?
              AND (? = 1 OR IFNULL(cf.solo_admin, 0) = 0)
            ORDER BY t.fecha_hora_apertura DESC
        ''', (mes, 1 if incluir_oficina else 0))
        return {
            "cierres": [dict(r) for r in cursor.fetchall()],
            "mes": mes,
            "ocultos_oficina": 0 if incluir_oficina else ocultos_oficina,
        }
    finally:
        conexion.close()


@router.get("/ventas_por_dia", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def ventas_por_dia(mes: str = None):
    mes = _mes_ar(mes)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT date(fecha_hora) as dia,
                   COUNT(id) as tickets,
                   IFNULL(SUM(total_venta), 0) as total,
                   IFNULL(SUM(CASE WHEN UPPER(metodo_pago) LIKE '%EFECTIVO%' THEN total_venta ELSE 0 END), 0) as efectivo,
                   IFNULL(SUM(CASE WHEN UPPER(metodo_pago) IN ('CUENTA CORRIENTE', 'FIADO') THEN total_venta ELSE 0 END), 0) as fiado
            FROM ventas_cabecera
            WHERE strftime('%Y-%m', fecha_hora) = ?
              AND estado != 'ANULADA'
            GROUP BY date(fecha_hora)
            ORDER BY dia
        ''', (mes,))
        return {"dias": [dict(r) for r in cursor.fetchall()], "mes": mes}
    finally:
        conexion.close()
