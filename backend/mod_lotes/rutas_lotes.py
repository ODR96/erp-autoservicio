from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime, timezone, timedelta
import sqlite3
import os
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol # <-- EL PATOVICA

router = APIRouter()

ZONA_AR = timezone(timedelta(hours=-3))


def asegurar_tabla_mermas():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS registro_mermas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
            producto_id INTEGER,
            lote_id INTEGER,
            cantidad REAL,
            motivo TEXT,
            costo_perdido REAL,
            usuario_id INTEGER,
            observaciones TEXT
        )
    ''')
    conexion.commit()
    conexion.close()


def asegurar_tabla_conteos():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS conteos_inventario (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha_hora DATETIME,
            producto_id INTEGER,
            stock_sistema REAL,
            cantidad_contada REAL,
            diferencia REAL,
            tipo TEXT,
            usuario_id INTEGER,
            observaciones TEXT,
            costo_perdido REAL DEFAULT 0
        )
    ''')
    conexion.commit()
    conexion.close()


def asegurar_tabla_zonas_conteo():
    conexion = obtener_conexion()
    conexion.execute('''
        CREATE TABLE IF NOT EXISTS conteo_zonas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            producto_id INTEGER NOT NULL,
            zona TEXT NOT NULL,
            cantidad REAL NOT NULL,
            usuario_id INTEGER,
            fecha_hora TEXT NOT NULL
        )
    ''')
    conexion.execute("CREATE INDEX IF NOT EXISTS idx_conteo_zonas_prod ON conteo_zonas (producto_id)")
    conexion.commit()
    conexion.close()


asegurar_tabla_mermas()
asegurar_tabla_conteos()
asegurar_tabla_zonas_conteo()

# --- MODELOS DE DATOS ---
class LoteNuevo(BaseModel):
    producto_id: int
    numero_lote_proveedor: str = ""  
    fecha_vencimiento: date          
    cantidad_inicial: float
    costo_real_ingreso: float

class BajaManual(BaseModel):
    lote_id: int
    cantidad_a_bajar: float
    motivo: str  # Ej: "Rotura", "Vencido", "Consumo interno"
    observaciones: str = ""
    usuario_id: int = 1


# --- 1. INGRESAR MERCADERÍA AL DEPÓSITO ---
@router.post("/ingresar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ingresar_lote(lote: LoteNuevo): # <-- Eliminado el background_tasks inútil
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        fecha_hoy = date.today()
        ahora = datetime.now(ZONA_AR) 
        num_lote = lote.numero_lote_proveedor
        
        if num_lote == "":
            num_lote = f"LOTE-INT-{ahora.strftime('%Y%m%d-%H%M%S')}-PROD{lote.producto_id}"

        cursor.execute('''
            INSERT INTO lotes_stock 
            (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, 
            cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo')
        ''', (lote.producto_id, num_lote, fecha_hoy, lote.fecha_vencimiento, 
              lote.cantidad_inicial, lote.cantidad_inicial, lote.costo_real_ingreso))
        
        cursor.execute('UPDATE productos SET costo_sin_iva = ? WHERE id = ?', (lote.costo_real_ingreso, lote.producto_id))
        
        # Eliminada la variable lote_id fantasma
        
        conexion.commit()
        conexion.close()
        return {"mensaje": "¡Mercadería ingresada y costo actualizado!"}
    except Exception as e:
        if conexion:
            conexion.rollback() 
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        return {"error": mensaje_error}


# --- 2. LISTAR STOCK EN GÓNDOLA ---
@router.get("/listar_activos", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_lotes_activos():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row 
    cursor = conexion.cursor()
    cursor.execute('''
        SELECT l.id as lote_id, p.nombre as producto, l.numero_lote_proveedor, 
               l.fecha_vencimiento, l.cantidad_disponible 
        FROM lotes_stock l
        JOIN productos p ON l.producto_id = p.id
        WHERE l.cantidad_disponible > 0 AND l.estado_lote = 'Activo'
        ORDER BY l.fecha_vencimiento ASC
    ''')
    lotes = cursor.fetchall()
    conexion.close()
    return {"lotes_en_gondola": [dict(lote) for lote in lotes]}


# --- 3. BAJA MANUAL DE STOCK ---
@router.put("/baja_manual")
def dar_baja_manual(datos: BajaManual, payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        if datos.cantidad_a_bajar <= 0:
            conexion.close()
            return {"error": "La cantidad a dar de baja tiene que ser mayor a cero."}

        cursor.execute(
            "SELECT cantidad_disponible, producto_id, IFNULL(costo_real_ingreso, 0) FROM lotes_stock WHERE id = ?",
            (datos.lote_id,),
        )
        resultado = cursor.fetchone()
        
        if not resultado:
            conexion.close()
            return {"error": "Ese lote no existe."}
            
        stock_actual = resultado[0]
        producto_id = resultado[1]
        costo_unitario = resultado[2] or 0.0
        
        if datos.cantidad_a_bajar > stock_actual:
            conexion.close()
            return {"error": f"No podés dar de baja {datos.cantidad_a_bajar}. Solo hay {stock_actual} en este lote."}

        if costo_unitario <= 0:
            cursor.execute("SELECT IFNULL(costo_sin_iva, 0) FROM productos WHERE id = ?", (producto_id,))
            fila_costo = cursor.fetchone()
            costo_unitario = (fila_costo[0] or 0.0) if fila_costo else 0.0

        # El ajuste por ventas previas al ingreso ya pagó CMV en la venta. No se vuelve a perder.
        es_ajuste_facturacion = (datos.motivo or "").startswith("Ajuste de Facturación")
        costo_perdido = 0.0 if es_ajuste_facturacion else round(datos.cantidad_a_bajar * costo_unitario, 2)

        try:
            usuario_id = int(payload.get("sub") or datos.usuario_id or 1)
        except (TypeError, ValueError):
            usuario_id = datos.usuario_id or 1
            
        nuevo_stock = stock_actual - datos.cantidad_a_bajar
        
        cursor.execute("UPDATE lotes_stock SET cantidad_disponible = ? WHERE id = ?", (nuevo_stock, datos.lote_id))
        if nuevo_stock <= 0:
            cursor.execute("UPDATE lotes_stock SET estado_lote = 'Agotado' WHERE id = ?", (datos.lote_id,))
        
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        motivo_auditoria = datos.motivo
        if datos.observaciones:
            motivo_auditoria = f"{datos.motivo} - Obs: {datos.observaciones}"
        
        cursor.execute('''
            INSERT INTO movimientos_stock 
            (producto_id, lote_id, cantidad, tipo_movimiento, motivo, usuario_id, fecha_hora)
            VALUES (?, ?, ?, 'Baja Manual / Merma', ?, ?, ?)
        ''', (producto_id, datos.lote_id, datos.cantidad_a_bajar, motivo_auditoria, usuario_id, fecha_actual))

        cursor.execute('''
            INSERT INTO registro_mermas
            (fecha_hora, producto_id, lote_id, cantidad, motivo, costo_perdido, usuario_id, observaciones)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (fecha_actual, producto_id, datos.lote_id, datos.cantidad_a_bajar, datos.motivo, costo_perdido, usuario_id, datos.observaciones or None))
        
        conexion.commit()
        conexion.close()
        
        return {
            "mensaje": "Stock ajustado y pérdida registrada.",
            "motivo_registrado": datos.motivo,
            "stock_restante_en_lote": nuevo_stock,
            "costo_perdido": costo_perdido,
            "impacto_ganancia": not es_ajuste_facturacion
        }
    except Exception as e:
        if conexion:
            conexion.rollback() 
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        return {"error": mensaje_error}
    
    
class DescuentoStock(BaseModel):
    producto_id: int
    cantidad_vendida: float


# --- FUNCIÓN COMPARTIDA: LÓGICA PURA DE DESCUENTO FIFO ---
# A diferencia del endpoint de abajo, esta función NO abre conexión propia ni hace
# commit: recibe un cursor ya abierto por quien la llama, para que el descuento de
# stock quede DENTRO de la misma transacción que el resto de la operación (venta,
# consumo de personal, etc.). Además deja auditoría completa en movimientos_stock,
# un registro por cada lote tocado.
def ejecutar_descuento_fifo(cursor, producto_id: int, cantidad_a_descontar: float,
                             tipo_movimiento: str, motivo: str,
                             usuario_id: int = None, fecha_hora: str = None) -> float:
    """
    Descuenta stock de los lotes activos de un producto, respetando FIFO por
    fecha de vencimiento. Devuelve la cantidad que NO se pudo descontar por falta
    de stock (0.0 si se descontó todo).
    """
    cursor.execute('''
        SELECT id, cantidad_disponible 
        FROM lotes_stock 
        WHERE producto_id = ? AND cantidad_disponible > 0 AND estado_lote = 'Activo'
        ORDER BY fecha_vencimiento ASC
    ''', (producto_id,))
    lotes = cursor.fetchall()
    cantidad_restante = cantidad_a_descontar

    for lote in lotes:
        lote_id = lote[0]
        disponible = lote[1]
        if cantidad_restante <= 0:
            break

        cantidad_tomada = min(disponible, cantidad_restante)
        cursor.execute("UPDATE lotes_stock SET cantidad_disponible = ? WHERE id = ?", (disponible - cantidad_tomada, lote_id))
        cursor.execute('''
            INSERT INTO movimientos_stock (producto_id, lote_id, cantidad, tipo_movimiento, motivo, usuario_id, fecha_hora)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (producto_id, lote_id, cantidad_tomada, tipo_movimiento, motivo, usuario_id, fecha_hora))
        cantidad_restante -= cantidad_tomada

    return cantidad_restante


# --- 4. DESCUENTO AUTOMÁTICO DE STOCK (El método FIFO para Ventas) ---
@router.put("/descontar_fifo", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def descontar_stock_fifo(datos: DescuentoStock):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    try:
        cursor.execute('''
            SELECT id, cantidad_disponible 
            FROM lotes_stock 
            WHERE producto_id = ? AND cantidad_disponible > 0 AND estado_lote = 'Activo'
            ORDER BY fecha_vencimiento ASC
        ''', (datos.producto_id,))
        
        lotes = cursor.fetchall()
        cantidad_restante_por_descontar = datos.cantidad_vendida
        
        for lote in lotes:
            lote_id = lote[0]
            disponible_en_este_lote = lote[1]
            
            if cantidad_restante_por_descontar <= 0:
                break 
                
            if disponible_en_este_lote >= cantidad_restante_por_descontar:
                nuevo_disponible = disponible_en_este_lote - cantidad_restante_por_descontar
                cursor.execute("UPDATE lotes_stock SET cantidad_disponible = ? WHERE id = ?", (nuevo_disponible, lote_id))
                cantidad_restante_por_descontar = 0
            else:
                cursor.execute("UPDATE lotes_stock SET cantidad_disponible = 0 WHERE id = ?", (lote_id,))
                cantidad_restante_por_descontar -= disponible_en_este_lote
                
        conexion.commit()
        conexion.close()
        
        if cantidad_restante_por_descontar > 0:
            return {"aviso": f"Se descontó todo, pero faltaron {cantidad_restante_por_descontar} unidades en el sistema."}
            
        return {"mensaje": "¡Stock descontado perfectamente usando el método FIFO!"}
        
    except Exception as e:
        if conexion:
            conexion.rollback() 
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        return {"error": mensaje_error}
    
# --- 5. CONSULTAR STOCK TOTAL DE UN PRODUCTO ---
@router.get("/stock_total/{producto_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def consultar_stock_total(producto_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    cursor.execute('''
        SELECT SUM(cantidad_disponible) 
        FROM lotes_stock 
        WHERE producto_id = ? AND estado_lote = 'Activo' AND cantidad_disponible > 0
    ''', (producto_id,))
    
    resultado = cursor.fetchone()[0]
    conexion.close()
    
    stock_total = resultado if resultado else 0
    return {"producto_id": producto_id, "stock_total": stock_total}


# --- 6. INVENTARIO: NEGATIVOS + CONTEO (no pisa el catálogo) ---
TIPOS_AJUSTE = ("NEGATIVO_CERO", "NEGATIVO_FISICO", "CONTEO")


class AjusteInventario(BaseModel):
    producto_id: int
    cantidad_contada: Optional[float] = None
    tipo: str
    observaciones: str = ""


def _usuario_id(payload: dict) -> int:
    try:
        uid = int((payload or {}).get("sub"))
    except (TypeError, ValueError):
        uid = 0
    if uid <= 0:
        raise HTTPException(status_code=401, detail="Sesión inválida.")
    return uid


def _ahora_ar() -> str:
    return datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")


def _hoy_ar() -> str:
    return datetime.now(ZONA_AR).strftime("%Y-%m-%d")


def _stock_neto(cursor, producto_id: int) -> float:
    cursor.execute(
        "SELECT COALESCE(SUM(cantidad_disponible), 0) FROM lotes_stock WHERE producto_id = ?",
        (producto_id,),
    )
    return float(cursor.fetchone()[0] or 0)


def _costo_maestro(cursor, producto_id: int) -> float:
    cursor.execute("SELECT IFNULL(costo_sin_iva, 0) FROM productos WHERE id = ?", (producto_id,))
    fila = cursor.fetchone()
    return float(fila[0] or 0) if fila else 0.0


def _costo_lote(cursor, lote_id: int, producto_id: int, fallback: float) -> float:
    cursor.execute("SELECT IFNULL(costo_real_ingreso, 0) FROM lotes_stock WHERE id = ?", (lote_id,))
    fila = cursor.fetchone()
    costo = float(fila[0] or 0) if fila else 0.0
    return costo if costo > 0 else float(fallback or 0)


def _perdonar_negativos(cursor, producto_id: int, usuario_id: int, fecha: str, motivo: str) -> float:
    """Borra lotes en negativo. Devuelve cuánta deuda se perdonó (número positivo)."""
    cursor.execute(
        """SELECT id, cantidad_disponible FROM lotes_stock
           WHERE producto_id = ? AND cantidad_disponible < 0""",
        (producto_id,),
    )
    perdonado = 0.0
    for lote_id, qty in cursor.fetchall():
        deuda = abs(float(qty or 0))
        if deuda <= 0:
            continue
        cursor.execute("DELETE FROM lotes_stock WHERE id = ?", (lote_id,))
        cursor.execute(
            """INSERT INTO movimientos_stock
               (producto_id, lote_id, cantidad, tipo_movimiento, motivo, usuario_id, fecha_hora)
               VALUES (?, ?, ?, 'AJUSTE_INVENTARIO', ?, ?, ?)""",
            (producto_id, lote_id, deuda, motivo, usuario_id, fecha),
        )
        perdonado += deuda
    return perdonado


def _comer_positivos(cursor, producto_id: int, cantidad: float, usuario_id: int, fecha: str,
                     motivo: str, costo_fallback: float) -> float:
    """Merma FIFO de lotes positivos. Devuelve costo_perdido."""
    restante = float(cantidad)
    costo_perdido = 0.0
    cursor.execute(
        """SELECT id, cantidad_disponible FROM lotes_stock
           WHERE producto_id = ? AND cantidad_disponible > 0 AND estado_lote = 'Activo'
           ORDER BY fecha_vencimiento ASC""",
        (producto_id,),
    )
    for lote_id, disponible in cursor.fetchall():
        if restante <= 0:
            break
        take = min(float(disponible), restante)
        nuevo = float(disponible) - take
        cursor.execute("UPDATE lotes_stock SET cantidad_disponible = ? WHERE id = ?", (nuevo, lote_id))
        if nuevo <= 0:
            cursor.execute("UPDATE lotes_stock SET estado_lote = 'Agotado' WHERE id = ?", (lote_id,))
        costo_u = _costo_lote(cursor, lote_id, producto_id, costo_fallback)
        costo_linea = round(take * costo_u, 2)
        costo_perdido += costo_linea
        cursor.execute(
            """INSERT INTO movimientos_stock
               (producto_id, lote_id, cantidad, tipo_movimiento, motivo, usuario_id, fecha_hora)
               VALUES (?, ?, ?, 'AJUSTE_INVENTARIO', ?, ?, ?)""",
            (producto_id, lote_id, take, motivo, usuario_id, fecha),
        )
        cursor.execute(
            """INSERT INTO registro_mermas
               (fecha_hora, producto_id, lote_id, cantidad, motivo, costo_perdido, usuario_id, observaciones)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (fecha, producto_id, lote_id, take, motivo, costo_linea, usuario_id, None),
        )
        restante -= take
    return round(costo_perdido, 2)


def _alta_ajuste(cursor, producto_id: int, cantidad: float, costo: float, usuario_id: int, fecha: str, motivo: str):
    cursor.execute(
        """INSERT INTO lotes_stock
           (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento,
            cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
           VALUES (?, 'AJUSTE_CONTEO', ?, '2099-12-31', ?, ?, ?, 'Activo')""",
        (producto_id, _hoy_ar(), cantidad, cantidad, costo),
    )
    lote_id = cursor.lastrowid
    cursor.execute(
        """INSERT INTO movimientos_stock
           (producto_id, lote_id, cantidad, tipo_movimiento, motivo, usuario_id, fecha_hora)
           VALUES (?, ?, ?, 'AJUSTE_INVENTARIO', ?, ?, ?)""",
        (producto_id, lote_id, cantidad, motivo, usuario_id, fecha),
    )
    return lote_id


def _registrar_conteo(cursor, producto_id, stock_antes, contado, tipo, usuario_id, fecha, obs, costo_perdido):
    cursor.execute(
        """INSERT INTO conteos_inventario
           (fecha_hora, producto_id, stock_sistema, cantidad_contada, diferencia, tipo, usuario_id, observaciones, costo_perdido)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (fecha, producto_id, stock_antes, contado, round(contado - stock_antes, 4), tipo, usuario_id, obs or None, costo_perdido),
    )


@router.get("/inventario/negativos", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def listar_negativos_inventario():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute(
            """SELECT p.id, p.nombre, p.codigo_barras, p.unidad_medida,
                      SUM(l.cantidad_disponible) as stock_total,
                      SUM(CASE WHEN l.cantidad_disponible < 0 THEN l.cantidad_disponible ELSE 0 END) as deuda
               FROM productos p
               JOIN lotes_stock l ON l.producto_id = p.id
               WHERE p.activo = 1
               GROUP BY p.id
               HAVING stock_total < 0
               ORDER BY stock_total ASC, p.nombre ASC"""
        )
        return {"productos": [dict(r) for r in cursor.fetchall()]}
    finally:
        conexion.close()


@router.get("/inventario/buscar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def buscar_producto_inventario(q: str = Query("", min_length=0), payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        busqueda = (q or "").strip()
        if not busqueda:
            return {"productos": []}

        select_sql = """
            SELECT p.id, p.nombre, p.codigo_barras, p.unidad_medida,
                   COALESCE((SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = p.id), 0) as stock_total
            FROM productos p
            WHERE p.activo = 1
        """
        if busqueda.isdigit():
            cursor.execute(select_sql + " AND (p.id = ? OR p.codigo_barras = ?) LIMIT 20", (int(busqueda), busqueda))
            exactos = [dict(r) for r in cursor.fetchall()]
            if exactos:
                return {"productos": _sin_stock_si_no_es_admin(payload, exactos)}

        condiciones = []
        parametros = []
        for palabra in busqueda.split():
            condiciones.append("(p.nombre LIKE ? OR p.codigo_barras LIKE ?)")
            parametros.extend([f"%{palabra}%", f"%{palabra}%"])
        cursor.execute(
            select_sql + " AND " + " AND ".join(condiciones) + " LIMIT 20",
            tuple(parametros),
        )
        return {"productos": _sin_stock_si_no_es_admin(payload, [dict(r) for r in cursor.fetchall()])}
    finally:
        conexion.close()


@router.get("/inventario/historial", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def historial_conteos(limit: int = Query(40, ge=1, le=200)):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute(
            """SELECT c.id, c.fecha_hora, c.producto_id, p.nombre, p.codigo_barras,
                      c.stock_sistema, c.cantidad_contada, c.diferencia, c.tipo,
                      c.observaciones, c.costo_perdido, u.nombre_completo as usuario
               FROM conteos_inventario c
               JOIN productos p ON p.id = c.producto_id
               LEFT JOIN usuarios u ON u.id = c.usuario_id
               ORDER BY c.id DESC
               LIMIT ?""",
            (limit,),
        )
        return {"movimientos": [dict(r) for r in cursor.fetchall()]}
    finally:
        conexion.close()


def _dias_aviso_conteo(cursor) -> int:
    try:
        fila = cursor.execute("SELECT dias_aviso_conteo FROM configuracion_local WHERE id = 1").fetchone()
    except sqlite3.OperationalError:
        return 0
    if not fila or fila[0] is None:
        return 0
    try:
        dias = int(fila[0])
    except (TypeError, ValueError):
        return 0
    if dias < 0:
        return 0
    return min(dias, 3650)


def _dias_desde(fecha_txt: str):
    if not fecha_txt:
        return None
    try:
        cuando = datetime.strptime(str(fecha_txt)[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return max(int((datetime.now(ZONA_AR).replace(tzinfo=None) - cuando).total_seconds() // 86400), 0)


@router.get("/inventario/ciclo", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def ciclo_conteo(categoria_id: Optional[int] = None, limite: int = Query(40, ge=1, le=100), payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    """Primero lo nunca contado, después lo más viejo. No modifica stock."""
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        aviso = _dias_aviso_conteo(cursor)
        filtro = ""
        params = []
        if categoria_id:
            filtro = " AND p.categoria_id = ? "
            params.append(int(categoria_id))
        cursor.execute(
            f"""SELECT p.id, p.nombre, p.codigo_barras, p.unidad_medida, p.categoria_id,
                      IFNULL(cat.nombre, '') AS categoria,
                      COALESCE((SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = p.id), 0) AS stock_total,
                      (SELECT MAX(fecha_hora) FROM conteos_inventario c
                       WHERE c.producto_id = p.id AND c.tipo = 'CONTEO') AS ultimo_conteo
               FROM productos p
               LEFT JOIN categorias_productos cat ON cat.id = p.categoria_id
               WHERE p.activo = 1 {filtro}
               ORDER BY ultimo_conteo IS NULL DESC, ultimo_conteo ASC, p.nombre ASC
               LIMIT ?""",
            tuple(params + [limite]),
        )
        filas = []
        for row in cursor.fetchall():
            item = dict(row)
            dias = _dias_desde(item.get("ultimo_conteo"))
            item["dias"] = dias
            item["nunca"] = item.get("ultimo_conteo") is None
            item["vencido"] = bool(aviso) and (item["nunca"] or (dias is not None and dias >= aviso))
            filas.append(item)
        return {"dias_aviso": aviso, "productos": _sin_stock_si_no_es_admin(payload, filas)}
    finally:
        conexion.close()


def _es_admin(payload: dict) -> bool:
    return ((payload or {}).get("rol") or "").upper() == "ADMIN"


def _sin_stock_si_no_es_admin(payload: dict, filas: list) -> list:
    if _es_admin(payload):
        return filas
    for item in filas:
        item.pop("stock_total", None)
    return filas


def _fmt_cant(n) -> str:
    texto = f"{float(n):.3f}".rstrip("0").rstrip(".")
    return texto or "0"


def _obs_zonas(zonas) -> str:
    return " · ".join(f"{z['zona']} {_fmt_cant(z['cantidad'])}" for z in zonas)[:200]


def _es_admin(payload: dict) -> bool:
    return ((payload or {}).get("rol") or "").upper() == "ADMIN"


def _zonas_pendientes(cursor, producto_id: int):
    cursor.execute(
        "SELECT id, zona, cantidad, fecha_hora FROM conteo_zonas WHERE producto_id = ? ORDER BY id ASC",
        (producto_id,),
    )
    hoy = _hoy_ar()
    filas = []
    for row in cursor.fetchall():
        item = dict(row)
        item["vieja"] = str(item.get("fecha_hora") or "")[:10] != hoy
        filas.append(item)
    return filas


def _usuario_obligatorio(payload: dict) -> int:
    try:
        uid = int((payload or {}).get("sub"))
    except (TypeError, ValueError):
        uid = 0
    if uid <= 0:
        raise HTTPException(status_code=401, detail="Sesión inválida.")
    return uid


def _nombre_zona(texto: str) -> str:
    limpio = " ".join((texto or "").split())
    if not limpio or len(limpio) > 40:
        raise HTTPException(status_code=400, detail="Escribí el nombre de la zona, hasta 40 letras.")
    return limpio


class ZonaConteo(BaseModel):
    producto_id: int
    zona: str
    cantidad: float


@router.get("/inventario/zonas/{producto_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def listar_zonas_conteo(producto_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    try:
        zonas = _zonas_pendientes(conexion.cursor(), producto_id)
        total = round(sum(float(z["cantidad"] or 0) for z in zonas), 4)
        return {"zonas": zonas, "total": total}
    finally:
        conexion.close()


@router.post("/inventario/zona", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def guardar_zona_conteo(body: ZonaConteo, payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    zona = _nombre_zona(body.zona)
    if body.cantidad < 0:
        raise HTTPException(status_code=400, detail="La cantidad no puede ser negativa.")
    cantidad = round(float(body.cantidad), 4)
    usuario_id = _usuario_obligatorio(payload)
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        existe = cursor.execute("SELECT id FROM productos WHERE id = ? AND activo = 1", (body.producto_id,)).fetchone()
        if not existe:
            raise HTTPException(status_code=404, detail="Ese producto no existe o está inactivo.")
        cuantas = cursor.execute("SELECT COUNT(*) FROM conteo_zonas WHERE producto_id = ?", (body.producto_id,)).fetchone()[0]
        misma = cursor.execute(
            "SELECT id FROM conteo_zonas WHERE producto_id = ? AND lower(zona) = lower(?)",
            (body.producto_id, zona),
        ).fetchone()
        if not misma and int(cuantas or 0) >= 12:
            raise HTTPException(status_code=400, detail="Ese producto ya tiene 12 zonas. Confirmá o borrá una.")
        if misma:
            cursor.execute(
                "UPDATE conteo_zonas SET cantidad = ?, usuario_id = ?, fecha_hora = ?, zona = ? WHERE id = ?",
                (cantidad, usuario_id, _ahora_ar(), zona, misma["id"]),
            )
        else:
            cursor.execute(
                "INSERT INTO conteo_zonas (producto_id, zona, cantidad, usuario_id, fecha_hora) VALUES (?, ?, ?, ?, ?)",
                (body.producto_id, zona, cantidad, usuario_id, _ahora_ar()),
            )
        conexion.commit()
        zonas = _zonas_pendientes(cursor, body.producto_id)
        return {"zonas": zonas, "total": round(sum(float(z["cantidad"] or 0) for z in zonas), 4)}
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@router.delete("/inventario/zona/{zona_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def borrar_zona_conteo(zona_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        fila = cursor.execute("SELECT producto_id FROM conteo_zonas WHERE id = ?", (zona_id,)).fetchone()
        if not fila:
            raise HTTPException(status_code=404, detail="Esa zona no está pendiente.")
        cursor.execute("DELETE FROM conteo_zonas WHERE id = ?", (zona_id,))
        conexion.commit()
        zonas = _zonas_pendientes(cursor, fila["producto_id"])
        return {"zonas": zonas, "total": round(sum(float(z["cantidad"] or 0) for z in zonas), 4)}
    except HTTPException:
        conexion.rollback()
        raise
    finally:
        conexion.close()


@router.post("/inventario/ajustar")
def ajustar_inventario(datos: AjusteInventario, payload: dict = Depends(VerificarRol(["ADMIN", "ENCARGADO"]))):
    tipo = (datos.tipo or "").strip().upper()
    if tipo not in TIPOS_AJUSTE:
        return {"error": "Tipo de ajuste inválido."}

    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id, nombre FROM productos WHERE id = ? AND activo = 1", (datos.producto_id,))
        prod = cursor.fetchone()
        if not prod:
            return {"error": "Ese producto no existe o está inactivo."}

        stock_antes = _stock_neto(cursor, datos.producto_id)
        usuario_id = _usuario_id(payload)
        fecha = _ahora_ar()
        costo_fb = _costo_maestro(cursor, datos.producto_id)
        costo_perdido = 0.0

        if tipo == "NEGATIVO_CERO":
            if stock_antes >= 0:
                return {"error": "Ese producto no está en negativo."}
            _perdonar_negativos(cursor, datos.producto_id, usuario_id, fecha, "Regularización: borrar deuda VENTA_SIN_STOCK")
            stock_despues = _stock_neto(cursor, datos.producto_id)
            _registrar_conteo(
                cursor, datos.producto_id, stock_antes, stock_despues, tipo,
                usuario_id, fecha, datos.observaciones, 0.0,
            )
            conexion.commit()
            return {
                "mensaje": "Deuda de stock borrada.",
                "producto_id": datos.producto_id,
                "nombre": prod["nombre"],
                "stock_anterior": stock_antes,
                "stock_nuevo": stock_despues,
                "diferencia": round(stock_despues - stock_antes, 4),
                "costo_perdido": 0.0,
                "aviso_factura": True,
            }

        if datos.cantidad_contada is None and tipo != "CONTEO":
            return {"error": "Indicá cuánto hay en físico."}
        zonas = []
        if tipo == "CONTEO":
            zonas = _zonas_pendientes(cursor, datos.producto_id)
            viejas = [z["zona"] for z in zonas if z.get("vieja")]
            if viejas:
                return {"error": "Estas zonas son de otro día: " + ", ".join(viejas) + ". Volvé a contarlas."}
        if zonas:
            target = round(sum(float(z["cantidad"] or 0) for z in zonas), 4)
        else:
            if datos.cantidad_contada is None:
                return {"error": "Indicá cuánto hay en físico."}
            target = float(datos.cantidad_contada)
        if target < 0:
            return {"error": "El físico no puede ser negativo."}

        if abs(stock_antes - target) < 0.0001:
            obs_igual = _obs_zonas(zonas) if zonas else (datos.observaciones or "Sin diferencia")
            if zonas:
                cursor.execute("DELETE FROM conteo_zonas WHERE producto_id = ?", (datos.producto_id,))
            _registrar_conteo(
                cursor, datos.producto_id, stock_antes, target, tipo,
                usuario_id, fecha, obs_igual, 0.0,
            )
            conexion.commit()
            return {
                "mensaje": "El sistema ya coincidía con el físico.",
                "producto_id": datos.producto_id,
                "nombre": prod["nombre"],
                "stock_anterior": stock_antes,
                "stock_nuevo": stock_antes,
                "diferencia": 0.0,
                "costo_perdido": 0.0,
                "aviso_factura": False,
            }

        motivo = "Conteo cíclico" if tipo == "CONTEO" else "Regularización de negativo (físico)"
        _perdonar_negativos(cursor, datos.producto_id, usuario_id, fecha, motivo)
        neto_tras_perdon = _stock_neto(cursor, datos.producto_id)

        if neto_tras_perdon < target:
            _alta_ajuste(
                cursor, datos.producto_id, target - neto_tras_perdon, costo_fb,
                usuario_id, fecha, motivo,
            )
        elif neto_tras_perdon > target:
            costo_perdido = _comer_positivos(
                cursor, datos.producto_id, neto_tras_perdon - target,
                usuario_id, fecha, motivo, costo_fb,
            )

        stock_despues = _stock_neto(cursor, datos.producto_id)
        obs = _obs_zonas(zonas) if zonas else datos.observaciones
        if zonas:
            cursor.execute("DELETE FROM conteo_zonas WHERE producto_id = ?", (datos.producto_id,))
        _registrar_conteo(
            cursor, datos.producto_id, stock_antes, target, tipo,
            usuario_id, fecha, obs, costo_perdido,
        )
        conexion.commit()
        return {
            "mensaje": "Stock emparejado al físico.",
            "producto_id": datos.producto_id,
            "nombre": prod["nombre"],
            "stock_anterior": stock_antes,
            "stock_nuevo": stock_despues,
            "diferencia": round(stock_despues - stock_antes, 4),
            "costo_perdido": costo_perdido,
            "aviso_factura": stock_antes < 0,
        }
    except HTTPException:
        if conexion:
            conexion.rollback()
        raise
    except Exception as e:
        if conexion:
            conexion.rollback()
        return {"error": str(e)}
    finally:
        if conexion:
            conexion.close()