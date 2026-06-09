from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel
import sqlite3
from datetime import datetime, timezone, timedelta, date

router = APIRouter()

ZONA_AR = timezone(timedelta(hours=-3))

# --- MODELOS DE DATOS ---
class ProductoNuevo(BaseModel):
    codigo_barras: str
    nombre: str
    categoria_id: int
    proveedor_habitual_id: int
    costo_sin_iva: float
    porcentaje_iva: float = 21.0
    precio_venta_final: float
    stock_minimo_alerta: float
    dias_alerta_vencimiento: int 
    unidad_medida: str = "Unidad"
    componentes_combo: list = []
    reglas_mayoristas: list = []
    cantidad_inicial: float = 0.0
    # --- AGREGAR ESTAS 3 LÍNEAS NUEVAS ---
    numero_lote_proveedor: str = "INICIAL"
    fecha_vencimiento: str = "2099-12-31"
    costo_real_ingreso: float = 0.0
    
class ProductoActualizar(BaseModel):
    codigo_barras: str
    nombre: str
    categoria_id: int
    proveedor_habitual_id: int
    costo_sin_iva: float
    porcentaje_iva: float = 21.0
    precio_venta_final: float
    stock_minimo_alerta: float
    dias_alerta_vencimiento: int
    unidad_medida: str = "Unidad" # <-- AGREGAMOS ESTO
    componentes_combo: list = []
    reglas_mayoristas: list = []
    
class CategoriaPOS(BaseModel):
    nombre: str
    palabra_clave: str
    icono: str = "bi-box"
    color_fondo: str = "#ffffff"

@router.post("/crear")
def crear_producto(producto: ProductoNuevo):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        if producto.codigo_barras:
            cursor.execute("SELECT id, nombre FROM productos WHERE codigo_barras = ? AND activo = 1", (producto.codigo_barras,))
            if cursor.fetchone():
                conexion.close()
                return {"error": "El código ya existe."}

        cursor.execute('''
            INSERT INTO productos (codigo_barras, nombre, categoria_id, proveedor_habitual_id, costo_sin_iva, porcentaje_iva, precio_venta_final, stock_minimo_alerta, dias_alerta_vencimiento, unidad_medida, activo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ''', (producto.codigo_barras, producto.nombre, producto.categoria_id, producto.proveedor_habitual_id, producto.costo_sin_iva, producto.porcentaje_iva, producto.precio_venta_final, producto.stock_minimo_alerta, producto.dias_alerta_vencimiento, producto.unidad_medida))
        
        nuevo_id = cursor.lastrowid 
        
        if producto.cantidad_inicial > 0:
            cursor.execute('''
                INSERT INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'Activo')
            ''', (nuevo_id, producto.numero_lote_proveedor, date.today().isoformat(), producto.fecha_vencimiento, producto.cantidad_inicial, producto.cantidad_inicial, producto.costo_real_ingreso))

        # Guardamos Combos y Promos
        for comp in producto.componentes_combo:
            cursor.execute("INSERT INTO productos_combos (producto_padre_id, producto_hijo_id, cantidad_hijo) VALUES (?, ?, ?)", (nuevo_id, comp['id'], comp['cantidad']))
        for r in producto.reglas_mayoristas:
            cursor.execute("INSERT INTO promociones_volumen (producto_id, cantidad_minima, precio_oferta_unitario) VALUES (?, ?, ?)", (nuevo_id, r['cantidad'], r['precio']))
            
        # ENCOLAR CENEFA AUTOMÁTICA
        cursor.execute("INSERT INTO cola_impresion_etiquetas (producto_id, tipo_cartel, cantidad_copias, impreso) VALUES (?, 'Cenefa', 1, 0)", (nuevo_id,))

        conexion.commit()
        conexion.close()
        return {"mensaje": "¡Producto y Lote Inicial guardados!", "id": nuevo_id}
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}

# --- 2. LEER / CATÁLOGO COMPLETO (R) ---
# --- 2. LEER / CATÁLOGO COMPLETO (R) ---
@router.get("/listar")
def listar_todos_los_productos(estado: int = 1, alerta_stock: bool = False, alerta_vencimiento: bool = False):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row 
    cursor = conexion.cursor()
    
    # EL CAMBIO: Le agregamos una subconsulta para saber si es un combo
    cursor.execute('''
        SELECT 
            p.id, p.codigo_barras, p.nombre, p.categoria_id, p.unidad_medida, p.proveedor_habitual_id,
            p.costo_sin_iva, p.porcentaje_iva, p.precio_venta_final, p.dias_alerta_vencimiento, p.stock_minimo_alerta,
            (SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = p.id AND estado_lote = 'Activo') as stock_total,
(           SELECT COUNT(id) FROM lotes_stock WHERE producto_id = p.id AND estado_lote = 'Activo' AND cantidad_disponible != 0) as cantidad_lotes,            (SELECT precio_oferta_unitario FROM promociones_volumen WHERE producto_id = p.id LIMIT 1) as precio_promo,
            (SELECT cantidad_minima FROM promociones_volumen WHERE producto_id = p.id LIMIT 1) as cant_promo,
            (SELECT MIN(fecha_vencimiento) FROM lotes_stock WHERE producto_id = p.id AND estado_lote = 'Activo' AND cantidad_disponible > 0) as prox_vencimiento,
            (SELECT COUNT(*) FROM productos_combos WHERE producto_padre_id = p.id) as es_combo
        FROM productos p 
        WHERE p.activo = ?
        ORDER BY p.id DESC
    ''', (estado,))
    
    productos_raw = cursor.fetchall()
    conexion.close()
    
    productos = [dict(prod) for prod in productos_raw]
    
    # Filtro 1: Stock Crítico (Ignorando Combos)
    if alerta_stock:
        productos_criticos = []
        for p in productos:
            if p["es_combo"] > 0: continue # Si es combo, saltamos al siguiente
            
            stock_actual = p["stock_total"] if p["stock_total"] else 0
            stock_minimo = p["stock_minimo_alerta"] if p["stock_minimo_alerta"] else 0
            if stock_actual <= stock_minimo:
                productos_criticos.append(p)
        return {"productos": productos_criticos}
        
    # Filtro 2: Alerta de Vencimiento (Blindado contra errores)
    if alerta_vencimiento:
        from datetime import date
        hoy = date.today()
        productos_por_vencer = []
        for p in productos:
            if p["es_combo"] > 0: continue # Los combos no se vencen, se vencen sus ingredientes
            
            dias_alerta = p["dias_alerta_vencimiento"] if p["dias_alerta_vencimiento"] else 0
            fecha_str = p["prox_vencimiento"]
            
            if fecha_str and dias_alerta > 0:
                try:
                    fecha_venc = date.fromisoformat(fecha_str[:10]) # [:10] por si viene con hora pegada
                    dif_dias = (fecha_venc - hoy).days
                    if dif_dias <= dias_alerta:
                        productos_por_vencer.append(p)
                except Exception:
                    pass # Si la fecha estaba mal escrita en la base, no rompemos el programa
                    
        return {"productos": productos_por_vencer}
        
    return {"productos": productos}

# --- 3. ACTUALIZAR PRODUCTO CORREGIDO ---
@router.put("/actualizar/{producto_id}")
def actualizar_producto(producto_id: int, datos: ProductoActualizar):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        if datos.codigo_barras:
            cursor.execute("SELECT id, nombre FROM productos WHERE codigo_barras = ? AND id != ? AND activo = 1", (datos.codigo_barras, producto_id))
            if cursor.fetchone():
                conexion.close()
                return {"error": "El código ya existe."}

        # VERIFICAR SI CAMBIÓ EL PRECIO PARA ENCOLAR CENEFA
        cursor.execute("SELECT precio_venta_final FROM productos WHERE id = ?", (producto_id,))
        precio_viejo = cursor.fetchone()['precio_venta_final']
        if precio_viejo != datos.precio_venta_final:
            cursor.execute("INSERT INTO cola_impresion_etiquetas (producto_id, tipo_cartel, cantidad_copias, impreso) VALUES (?, 'Cenefa', 1, 0)", (producto_id,))

        cursor.execute('''
            UPDATE productos 
            SET codigo_barras = ?, nombre = ?, categoria_id = ?, proveedor_habitual_id = ?, 
                costo_sin_iva = ?, porcentaje_iva = ?, precio_venta_final = ?, stock_minimo_alerta = ?, dias_alerta_vencimiento = ?, unidad_medida = ?
            WHERE id = ?
        ''', (datos.codigo_barras, datos.nombre, datos.categoria_id, datos.proveedor_habitual_id, 
              datos.costo_sin_iva, datos.porcentaje_iva, datos.precio_venta_final, datos.stock_minimo_alerta, datos.dias_alerta_vencimiento, datos.unidad_medida, producto_id))
        
        # LIMPIAR Y RE-GUARDAR COMBOS Y PROMOS (Evita duplicados)
        cursor.execute("DELETE FROM productos_combos WHERE producto_padre_id = ?", (producto_id,))
        for comp in datos.componentes_combo:
            cursor.execute("INSERT INTO productos_combos (producto_padre_id, producto_hijo_id, cantidad_hijo) VALUES (?, ?, ?)", (producto_id, comp['id'], comp['cantidad']))
            
        cursor.execute("DELETE FROM promociones_volumen WHERE producto_id = ?", (producto_id,))
        for r in datos.reglas_mayoristas:
            cursor.execute("INSERT INTO promociones_volumen (producto_id, cantidad_minima, precio_oferta_unitario) VALUES (?, ?, ?)", (producto_id, r['cantidad'], r['precio']))
            
        conexion.commit()
        conexion.close()
        return {"mensaje": "Actualizado correctamente."}
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}
    
# --- 7. VER UN SOLO PRODUCTO (Con Aspirador Automático de Lotes) ---
@router.get("/ver/{producto_id}")
def ver_producto_por_id(producto_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        # 1. Datos básicos
        cursor.execute("SELECT * FROM productos WHERE id = ?", (producto_id,))
        producto = cursor.fetchone()
        if not producto:
            conexion.close()
            return {"error": "Producto no encontrado"}
        
        resultado = dict(producto)
        
        # 2. Reglas mayoristas
        cursor.execute("SELECT cantidad_minima as cantidad, precio_oferta_unitario as precio FROM promociones_volumen WHERE producto_id = ?", (producto_id,))
        resultado["reglas_mayoristas"] = [dict(r) for r in cursor.fetchall()]

        # =================================================================
        # 🧹 EL ASPIRADOR DE DEUDAS AUTOMÁTICO (Consolidador de Lotes)
        # =================================================================
        # Sumamos todos los lotes negativos que andan flotando
        cursor.execute("SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = ? AND cantidad_disponible < 0", (producto_id,))
        suma_negativos = cursor.fetchone()[0]

        if suma_negativos and suma_negativos < 0:
            deuda_total = abs(suma_negativos)

            # Buscamos lotes positivos para "pagar" la deuda (del más viejo al más nuevo)
            cursor.execute("SELECT id, cantidad_disponible FROM lotes_stock WHERE producto_id = ? AND cantidad_disponible > 0 ORDER BY fecha_ingreso ASC", (producto_id,))
            lotes_positivos = cursor.fetchall()

            for lp in lotes_positivos:
                if deuda_total <= 0: break
                disp = lp['cantidad_disponible']

                if disp >= deuda_total:
                    # Este lote positivo tiene suficiente para cubrir toda la deuda junta
                    cursor.execute("UPDATE lotes_stock SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?", (deuda_total, lp['id']))
                    deuda_total = 0
                else:
                    # Este lote se vacía pagando parte de la deuda, y seguimos con el próximo
                    cursor.execute("UPDATE lotes_stock SET cantidad_disponible = 0 WHERE id = ?", (lp['id'],))
                    deuda_total -= disp

            # Borramos TODOS los lotes negativos viejos y esparcidos
            cursor.execute("DELETE FROM lotes_stock WHERE producto_id = ? AND cantidad_disponible < 0", (producto_id,))

            # Limpiamos los lotes positivos que hayan quedado en 0 exacto por pagar la deuda
            cursor.execute("DELETE FROM lotes_stock WHERE producto_id = ? AND cantidad_disponible = 0", (producto_id,))

            # Si no alcanzó la mercadería positiva y sigue habiendo deuda, creamos 1 solo lote unificado
            # Si no alcanzó la mercadería positiva y sigue habiendo deuda, creamos 1 solo lote unificado
            if deuda_total > 0:
                # Calculamos la fecha exacta desde Python
                fecha_hoy_ar = datetime.now(ZONA_AR).strftime("%Y-%m-%d")
                cursor.execute('''
                    INSERT INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
                    VALUES (?, 'VENTA_SIN_STOCK', ?, '2099-12-31', 0, ?, 0, 'Activo')
                ''', (producto_id, fecha_hoy_ar, -deuda_total))

            conexion.commit() # Guardamos la limpieza en la base de datos
        # =================================================================

        # 3. Lotes activos (Ahora sí, limpios y ordenados)
        cursor.execute("SELECT id as lote_id, numero_lote_proveedor as lote, fecha_ingreso as ingreso, fecha_vencimiento as vence, cantidad_disponible as stock, costo_real_ingreso as costo FROM lotes_stock WHERE producto_id = ? AND cantidad_disponible != 0 ORDER BY fecha_ingreso ASC", (producto_id,))
        resultado["lotes"] = [dict(l) for l in cursor.fetchall()]

        # 4. Componentes del combo 
        cursor.execute('''
            SELECT p.id, p.nombre, pc.cantidad_hijo as cantidad 
            FROM productos_combos pc
            JOIN productos p ON pc.producto_hijo_id = p.id
            WHERE pc.producto_padre_id = ?
        ''', (producto_id,))
        resultado["componentes_combo"] = [dict(c) for c in cursor.fetchall()]

        conexion.close() 
        return resultado
        
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}

# --- 4. BORRAR (D - Borrado Lógico) ---
@router.delete("/eliminar/{producto_id}")
def desactivar_producto(producto_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # En vez de borrar, lo "apagamos" poniendo activo en 0
        cursor.execute("UPDATE productos SET activo = 0 WHERE id = ?", (producto_id,))
        conexion.commit()
        conexion.close()
        return {"mensaje": "Producto dado de baja del catálogo."}
    except Exception as e:
        conexion.close()
        return {"error": "No se pudo eliminar", "detalle": str(e)}
    
@router.put("/restaurar/{producto_id}")
def restaurar_producto(producto_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # Lo volvemos a prender poniendo activo en 1
        cursor.execute("UPDATE productos SET activo = 1 WHERE id = ?", (producto_id,))
        conexion.commit()
        conexion.close()
        return {"mensaje": f"¡Producto {producto_id} restaurado y visible nuevamente!"}
    except Exception as e:
        conexion.close()
        return {"error": "No se pudo restaurar", "detalle": str(e)}
    
# --- 6. BUSCADOR AVANZADO (Inteligente, Sin Zombies y CON PROMOS) ---
@router.get("/buscar")
def buscar_producto(q: Optional[str] = None, termino: Optional[str] = None, query: Optional[str] = None):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        busqueda = q or termino or query or ""
        if not busqueda: return {"productos": []}

        # Función ninja para pegarle las promociones y el STOCK FÍSICO REAL a los productos
        def adjuntar_reglas_y_stock(lista_cruda):
            productos_listos = []
            for p in lista_cruda:
                p_dict = dict(p)
                # 1. Traemos las promociones
                cursor.execute("SELECT cantidad_minima, precio_oferta_unitario FROM promociones_volumen WHERE producto_id = ?", (p_dict['id'],))
                p_dict['reglas_mayoristas'] = [dict(r) for r in cursor.fetchall()]
                
                # 2. LA MAGIA: Sumamos el stock real directo de los lotes activos
                cursor.execute("SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = ? AND estado_lote = 'Activo' AND cantidad_disponible > 0", (p_dict['id'],))
                stock_real = cursor.fetchone()[0]
                # Se lo mandamos a Javascript bajo el nombre que está esperando
                p_dict['stock_actual'] = stock_real if stock_real else 0
                
                productos_listos.append(p_dict)
            return productos_listos

        # 1. BÚSQUEDA EXACTA (Prioridad máxima) 
        if busqueda.isdigit():
            cursor.execute("SELECT * FROM productos WHERE (id = ? OR codigo_barras = ?) AND activo = 1", (busqueda, busqueda))
            exactos = cursor.fetchall()
            if exactos: return {"productos": adjuntar_reglas_y_stock(exactos)}

        # 2. BÚSQUEDA INTELIGENTE DESORDENADA
        palabras = busqueda.split()
        condiciones = []
        parametros = []
        
        for p in palabras:
            condiciones.append("(nombre LIKE ? OR codigo_barras LIKE ?)")
            parametros.extend([f"%{p}%", f"%{p}%"])
        
        sql = f"SELECT * FROM productos WHERE {' AND '.join(condiciones)} AND activo = 1 LIMIT 50"
        cursor.execute(sql, tuple(parametros))
        
        return {"productos": adjuntar_reglas_y_stock(cursor.fetchall())}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conexion.close()

# --- BUSCADOR EXACTO PARA LA PISTOLA (CON PROMOS Y STOCK) ---
@router.get("/codigo/{codigo_barras}")
def obtener_por_codigo(codigo_barras: str):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM productos WHERE (codigo_barras = ? OR id = ?) AND activo = 1", (codigo_barras, codigo_barras))
        prod = cursor.fetchone()
        if prod: 
            p_dict = dict(prod)
            
            # Promociones
            cursor.execute("SELECT cantidad_minima, precio_oferta_unitario FROM promociones_volumen WHERE producto_id = ?", (p_dict['id'],))
            p_dict['reglas_mayoristas'] = [dict(r) for r in cursor.fetchall()]
            
            # Stock Físico Real
            cursor.execute("SELECT SUM(cantidad_disponible) FROM lotes_stock WHERE producto_id = ? AND estado_lote = 'Activo' AND cantidad_disponible > 0", (p_dict['id'],))
            stock_real = cursor.fetchone()[0]
            p_dict['stock_actual'] = stock_real if stock_real else 0
            
            return p_dict
            
        return {"error": "Producto no encontrado o inactivo"}
    finally:
        conexion.close()

# --- MODELO PARA ACTUALIZACIÓN MASIVA ---
# --- MODELO PARA ACTUALIZACIÓN MASIVA (MEJORADO CON EXCLUSIONES) ---
class ActualizacionMasiva(BaseModel):
    porcentaje: float
    tipo_filtro: str  
    filtro_id: int
    afectar_costo: bool
    palabra_clave: str = ""
    es_monto_fijo: bool = False
    excluir_ids: list[int] = [] # <-- LA LISTA NEGRA

# --- RUTINA DE AUMENTO MASIVO ---
@router.put("/actualizacion_masiva")
def actualizar_precios_masivamente(datos: ActualizacionMasiva):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        if datos.es_monto_fijo:
            query = "UPDATE productos SET precio_venta_final = ROUND(?, 2)"
            parametros = [datos.porcentaje]
            if datos.afectar_costo:
                query = "UPDATE productos SET costo_sin_iva = ROUND(?, 2), precio_venta_final = ROUND(?, 2)"
                parametros = [datos.porcentaje, datos.porcentaje]
        else:
            factor = 1 + (datos.porcentaje / 100.0)
            query = "UPDATE productos SET precio_venta_final = ROUND(precio_venta_final * ?, 2)"
            parametros = [factor]
            if datos.afectar_costo:
                query = "UPDATE productos SET costo_sin_iva = ROUND(costo_sin_iva * ?, 2), precio_venta_final = ROUND(precio_venta_final * ?, 2)"
                parametros = [factor, factor]
            
        query += " WHERE activo = 1"
        
        if datos.tipo_filtro == 'categoria':
            query += " AND categoria_id = ?"
            parametros.append(datos.filtro_id)
        elif datos.tipo_filtro == 'proveedor':
            query += " AND proveedor_habitual_id = ?"
            parametros.append(datos.filtro_id)

        if datos.palabra_clave:
            query += " AND nombre LIKE ?"
            parametros.append(f"%{datos.palabra_clave}%")
            
        # ¡NUEVO! Filtramos los que tachaste en la pantalla
        if datos.excluir_ids:
            placeholders = ','.join('?' for _ in datos.excluir_ids)
            query += f" AND id NOT IN ({placeholders})"
            parametros.extend(datos.excluir_ids)
            
        cursor.execute(query, tuple(parametros))
        filas_afectadas = cursor.rowcount  
        
        conexion.commit()
        conexion.close()
        return {"mensaje": f"¡Éxito! Se actualizaron {filas_afectadas} productos."}
        
    except Exception as e:
        conexion.close()
        return {"error": "Error en la actualización masiva", "detalle": str(e)}

# --- 8. PROMOCIONES POR VOLUMEN (Ej: Llevando 3, pagás menos) ---
class PromocionNueva(BaseModel):
    producto_id: int
    cantidad_minima: float
    precio_oferta_unitario: float

@router.post("/promocion")
def crear_promocion(promo: PromocionNueva):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            INSERT INTO promociones_volumen (producto_id, cantidad_minima, precio_oferta_unitario)
            VALUES (?, ?, ?)
        ''', (promo.producto_id, promo.cantidad_minima, promo.precio_oferta_unitario))
        conexion.commit()
        conexion.close()
        return {"mensaje": f"¡Promoción activada! Llevando {promo.cantidad_minima} o más, el precio queda en ${promo.precio_oferta_unitario}"}
    except Exception as e:
        conexion.close()
        return {"error": "Hubo un problema al crear la promoción", "detalle": str(e)}
    
    # --- MODELO PARA CATEGORÍAS ---
class CategoriaNueva(BaseModel):
    nombre: str

# --- RUTAS DE CATEGORÍAS (RUBROS) ---
# --- RUTAS DE CATEGORÍAS (RUBROS) ---
@router.get("/categorias")
def listar_categorias_activas():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # PARCHE: Usamos tu tabla real 'categorias_productos'
        cursor.execute("SELECT id, nombre FROM categorias_productos ORDER BY nombre ASC")
        categorias = [dict(c) for c in cursor.fetchall()]
        conexion.close()
        return {"categorias": categorias}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}

@router.post("/categorias/crear")
def crear_categoria(cat: CategoriaNueva):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        cursor.execute("INSERT INTO categorias_productos (nombre) VALUES (?)", (cat.nombre,))
        nuevo_id = cursor.lastrowid
        conexion.commit()
        conexion.close()
        return {"mensaje": "Categoría creada", "id": nuevo_id, "nombre": cat.nombre}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}

@router.delete("/categorias/eliminar/{cat_id}")
def eliminar_categoria(cat_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # Lo eliminamos de la tabla
        cursor.execute("DELETE FROM categorias_productos WHERE id = ?", (cat_id,))
        conexion.commit()
        conexion.close()
        return {"mensaje": "Categoría eliminada"}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}

# --- RUTAS PARA LA CARTELERÍA (USANDO TU TABLA REAL) ---
class EtiquetaNueva(BaseModel):
    producto_id: int
    tipo_cartel: str
    cantidad_copias: int
    texto_personalizado: str = "" # <-- NUEVO: El texto opcional

@router.post("/etiquetas/encolar")
def encolar_etiqueta(datos: EtiquetaNueva):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    cursor.execute('''
        INSERT INTO cola_impresion_etiquetas (producto_id, tipo_cartel, cantidad_copias, impreso, texto_personalizado) 
        VALUES (?, ?, ?, 0, ?)
    ''', (datos.producto_id, datos.tipo_cartel, datos.cantidad_copias, datos.texto_personalizado))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Etiqueta encolada"}

@router.get("/etiquetas/listar")
def listar_cola_impresion():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    # Ahora traemos el código de barras y el texto personalizado también
    cursor.execute('''
        SELECT c.id as cola_id, p.id as producto_id, p.nombre, p.precio_venta_final, p.codigo_barras, 
               c.tipo_cartel as formato, c.cantidad_copias as cantidad, c.texto_personalizado
        FROM cola_impresion_etiquetas c
        JOIN productos p ON c.producto_id = p.id
        WHERE c.impreso = 0
    ''')
    cola = cursor.fetchall()
    conexion.close()
    return {"cola": [dict(c) for c in cola]}

@router.delete("/etiquetas/vaciar")
def vaciar_cola():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    cursor.execute("DELETE FROM cola_impresion_etiquetas")
    conexion.commit()
    conexion.close()
    return {"mensaje": "Cola vaciada"}

# <-- NUEVO: RUTA PARA BORRAR UNA SOLA ETIQUETA DE LA BASE DE DATOS -->
@router.delete("/etiquetas/eliminar/{cola_id}")
def eliminar_etiqueta_individual(cola_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    cursor.execute("DELETE FROM cola_impresion_etiquetas WHERE id = ?", (cola_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Etiqueta eliminada"}
    
# --- GENERADOR DE CÓDIGO INTERNO AUTOMÁTICO ---
@router.get("/generar_codigo_interno")
def generar_codigo_interno():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # Busca el código numérico más alto (que tenga hasta 6 dígitos para que sea corto)
        cursor.execute("SELECT MAX(CAST(codigo_barras AS INTEGER)) FROM productos WHERE length(codigo_barras) <= 6 AND codigo_barras GLOB '*[0-9]*'")
        max_cod = cursor.fetchone()[0]
        
        # Si no hay códigos internos previos, arranca en 1000
        siguiente_codigo = str((max_cod if max_cod else 1000) + 1)
        
        conexion.close()
        return {"codigo": siguiente_codigo}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}
    
# --- 7. GESTIÓN DE CATEGORÍAS RÁPIDAS DEL POS ---
@router.get("/categorias_pos")
def listar_categorias_pos():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM categorias_pos")
        cats = [dict(c) for c in cursor.fetchall()]
        conexion.close()
        return {"categorias": cats}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}

@router.put("/categorias_pos/{cat_id}")
def editar_categoria_pos(cat_id: int, cat: CategoriaPOS):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            UPDATE categorias_pos 
            SET nombre = ?, palabra_clave = ?, icono = ?, color_fondo = ?
            WHERE id = ?
        ''', (cat.nombre, cat.palabra_clave, cat.icono, cat.color_fondo, cat_id))
        conexion.commit()
        conexion.close()
        return {"mensaje": "Categoría actualizada correctamente"}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}
    
# --- 9. LISTAR COMBOS (Para la Pestaña Híbrida) ---
@router.get("/listar_combos")
def listar_combos_armados():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # Traemos solo los productos que son "Padres" en la tabla de combos
        cursor.execute('''
            SELECT p.id, p.nombre, p.precio_venta_final
            FROM productos p
            WHERE p.id IN (SELECT DISTINCT producto_padre_id FROM productos_combos) AND p.activo = 1
        ''')
        combos = [dict(c) for c in cursor.fetchall()]
        
        # Le pegamos los hijos a cada combo
        for combo in combos:
            cursor.execute('''
                SELECT p.nombre, pc.cantidad_hijo as cant
                FROM productos_combos pc
                JOIN productos p ON pc.producto_hijo_id = p.id
                WHERE pc.producto_padre_id = ?
            ''', (combo['id'],))
            combo['componentes'] = [f"{c['cant']}x {c['nombre']}" for c in cursor.fetchall()]
            
        conexion.close()
        return {"combos": combos}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}
    
# --- GESTIÓN DIRECTA DE LOTES (CORRECCIÓN DE ERRORES) ---
@router.put("/lotes/actualizar/{lote_id}")
def actualizar_lote_individual(lote_id: int, datos: dict):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            UPDATE lotes_stock 
            SET numero_lote_proveedor = ?, fecha_vencimiento = ?, cantidad_disponible = ?, costo_real_ingreso = ?
            WHERE id = ?
        ''', (datos['lote'], datos['vence'], datos['stock'], datos['costo'], lote_id))
        conexion.commit()
        conexion.close()
        return {"mensaje": "Lote corregido correctamente."}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}

@router.delete("/lotes/eliminar/{lote_id}")
def eliminar_lote_fisico(lote_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # Esto borra el lote de la base de datos definitivamente
        cursor.execute("DELETE FROM lotes_stock WHERE id = ?", (lote_id,))
        conexion.commit()
        conexion.close()
        return {"mensaje": "Lote eliminado de la existencia."}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}
    
@router.get("/movimientos/{producto_id}")
def obtener_historial_producto(producto_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # AGREGAMOS m.observaciones A LA BÚSQUEDA
        cursor.execute('''
            SELECT m.fecha_hora, m.tipo_movimiento, m.cantidad, m.motivo, u.nombre_completo as responsable
            FROM movimientos_stock m
            LEFT JOIN usuarios u ON m.usuario_id = u.id
            WHERE m.producto_id = ? 
            ORDER BY m.fecha_hora DESC LIMIT 10
        ''', (producto_id,))
        movimientos = [dict(m) for m in cursor.fetchall()]
        conexion.close()
        return {"movimientos": movimientos}
    except Exception as e:
        if conexion: conexion.close()
        return {"error": str(e)}