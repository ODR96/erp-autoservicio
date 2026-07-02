import sqlite3
from supabase import create_client, Client

# =====================================================================
# 1. TUS CREDENCIALES DE LA NUBE
# =====================================================================
SUPABASE_URL = "https://fxbxkvagnpuoibtifwjw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4YnhrdmFnbnB1b2lidGlmd2p3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTM3OTU5NCwiZXhwIjoyMDk2OTU1NTk0fQ.aO0s-A3FwMExlJezGNGu_EUNINa8vgE7gHUbBTmRLpY"
nube: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# =====================================================================
# 2. EL ORDEN DE CARGA
# =====================================================================
TABLAS_ORDENADAS = [
    'configuracion_local', 'configuracion_negocio',
    'categorias_productos', 'categorias_pos', 'categorias_gasto',
    'proveedores', 'usuarios', 'clientes', 'cajas_fisicas',
    'productos', 'productos_combos', 'promociones_volumen',
    'lotes_stock', 'cola_impresion_etiquetas',
    'proveedores_ctacte', 'compras_cabecera', 'compras_detalle',
    'pagos_proveedores', 'cheques_emitidos',
    'ventas_cabecera', 'ventas_detalle', 
    'turnos_caja', 'movimientos_caja', 'gastos_operativos',
    'movimientos_stock', 'registro_mermas',
    'productos_solicitados_faltantes', 'movimientos_clientes'
]
def descargar_novedades_oficina():
    print("📥 Buscando actualizaciones de la oficina (Precios, Stock, Usuarios, Proveedores)...")
    local = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = local.cursor()
    try:
        # 1. Productos
        res_prod = nube.table('productos').select('*').execute()
        for p in res_prod.data:
            cursor.execute('''
                INSERT OR REPLACE INTO productos (
                    id, codigo_barras, nombre, categoria_id, proveedor_habitual_id, 
                    costo_sin_iva, porcentaje_iva, precio_venta_final, 
                    stock_minimo_alerta, dias_alerta_vencimiento, unidad_medida, activo, unidades_por_bulto
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (p['id'], p.get('codigo_barras',''), p['nombre'], p.get('categoria_id',1), p.get('proveedor_habitual_id',0), p.get('costo_sin_iva',0), p.get('porcentaje_iva',21), p.get('precio_venta_final',0), p.get('stock_minimo_alerta',5), p.get('dias_alerta_vencimiento',0), p.get('unidad_medida','Unidad'), p.get('activo',1), p.get('unidades_por_bulto', 1)))

# 2. Lotes (Stock Inteligente - Anti Colisiones)
        res_lotes = nube.table('lotes_stock').select('*').execute()
        for L in res_lotes.data:
            # A. Primero nos fijamos si el lote ya existe en el mostrador
            cursor.execute("SELECT id FROM lotes_stock WHERE id = ?", (L['id'],))
            existe = cursor.fetchone()
            
            if existe:
                # B. Si existe, actualizamos vencimiento y costo, pero PROTEGEMOS el stock local
                cursor.execute('''
                    UPDATE lotes_stock 
                    SET numero_lote_proveedor = ?, fecha_vencimiento = ?, costo_real_ingreso = ?, estado_lote = ?
                    WHERE id = ?
                ''', (L.get('numero_lote_proveedor','INICIAL'), L.get('fecha_vencimiento','2099-12-31'), 
                      L.get('costo_real_ingreso',0), L.get('estado_lote','Activo'), L['id']))
            else:
                # C. Si no existe, es un ingreso de mercadería nuevo hecho en la Nube. Lo descargamos completo.
                cursor.execute('''
                    INSERT INTO lotes_stock (
                        id, producto_id, numero_lote_proveedor, fecha_vencimiento,
                        cantidad_inicial, cantidad_disponible, costo_real_ingreso, fecha_ingreso, estado_lote
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    L['id'], L['producto_id'], L.get('numero_lote_proveedor','INICIAL'),
                    L.get('fecha_vencimiento','2099-12-31'), L.get('cantidad_inicial',0),
                    L.get('cantidad_disponible',0), L.get('costo_real_ingreso',0),
                    L.get('fecha_ingreso', '2024-01-01'), L.get('estado_lote','Activo')
                ))
            
        # 3. Categorías
        res_cat = nube.table('categorias_productos').select('*').execute()
        for c in res_cat.data:
            cursor.execute("INSERT OR REPLACE INTO categorias_productos (id, nombre) VALUES (?, ?)", (c['id'], c['nombre']))

        # 4. Proveedores
        res_prov = nube.table('proveedores').select('*').execute()
        for p in res_prov.data:
            cursor.execute('''
                INSERT OR REPLACE INTO proveedores (id, nombre_comercial, cuit, telefono_vendedor, observaciones, activo) 
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (p['id'], p['nombre_comercial'], p.get('cuit',''), p.get('telefono_vendedor',''), p.get('observaciones',''), p.get('activo',1)))

        # 5. Usuarios
        res_usr = nube.table('usuarios').select('*').execute()
        for u in res_usr.data:
            cursor.execute('''
                INSERT OR REPLACE INTO usuarios (id, nombre_completo, rol, codigo_barras_credencial, pin_secreto, estado) 
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (u['id'], u['nombre_completo'], u['rol'], u.get('codigo_barras_credencial',''), u.get('pin_secreto',''), u.get('estado','ACTIVO')))
            
        # 6. Categorías de la Caja POS
        res_cat_pos = nube.table('categorias_pos').select('*').execute()
        for c in res_cat_pos.data:
            cursor.execute('''
                INSERT OR REPLACE INTO categorias_pos (id, nombre, palabra_clave, icono, color_fondo) 
                VALUES (?, ?, ?, ?, ?)
            ''', (c['id'], c['nombre'], c.get('palabra_clave',''), c.get('icono','bi-box'), c.get('color_fondo','#ffffff')))
            
            

# 7. Promociones y Reglas Mayoristas (Sincronización en Espejo)
        res_promos = nube.table('promociones_volumen').select('producto_id, cantidad_minima, precio_oferta_unitario').execute()
        
        # EL ESCUDO: Solo borramos lo local si la nube realmente tiene datos para darnos
        if res_promos.data is not None and len(res_promos.data) > 0:
            cursor.execute("DELETE FROM promociones_volumen")
            for promo in res_promos.data:
                cursor.execute('''
                    INSERT INTO promociones_volumen (producto_id, cantidad_minima, precio_oferta_unitario) 
                    VALUES (?, ?, ?)
                ''', (promo['producto_id'], promo.get('cantidad_minima', 0), promo.get('precio_oferta_unitario', 0)))
        
        # 8. Descargar los Combos
        cursor.execute("DELETE FROM productos_combos")
        res_combos = nube.table('productos_combos').select('*').execute()
        for c in res_combos.data:
            cursor.execute('''
                INSERT INTO productos_combos (producto_padre_id, producto_hijo_id, cantidad_hijo) 
                VALUES (?, ?, ?)
            ''', (c['producto_padre_id'], c['producto_hijo_id'], c['cantidad_hijo']))
            
        local.commit()
        
        print("✅ ¡Todas las novedades aplicadas en el mostrador!")
    except Exception as e:
        print(f"⚠️ Error descargando novedades: {e}")
        local.rollback()
    finally:
        local.close()

def subir_todo_a_la_nube(es_latido_automatico=False):
    print("\n🚚 Arrancando el camión de mudanza...\n")
    
    local = sqlite3.connect('autoservicio_20dejunio.db')
    local.row_factory = sqlite3.Row
    cursor = local.cursor()

    for tabla in TABLAS_ORDENADAS:
        
        # EL ESCUDO ANTI-PISADAS: Si es el robot automático de 15 min, ignoramos el catálogo
        if es_latido_automatico and tabla in ['productos', 'promociones_volumen', 'productos_combos', 'categorias_productos', 'categorias_pos', 'proveedores']:
            continue

        print(f"📦 Revisando tabla: {tabla}...")
        
        try:
            cursor.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{tabla}'")
            if not cursor.fetchone():
                continue

            if tabla == 'promociones_volumen':
                cursor.execute("SELECT producto_id, cantidad_minima, precio_oferta_unitario FROM promociones_volumen")
            elif tabla == 'productos_combos':
                cursor.execute("SELECT producto_padre_id, producto_hijo_id, cantidad_hijo FROM productos_combos")
            else:
                cursor.execute(f"SELECT * FROM {tabla}")
                
            registros = [dict(row) for row in cursor.fetchall()]

            if not registros:
                continue

            for r in registros:
                for clave, valor in r.items():
                    if valor is None: r[clave] = None

            tamaño_lote = 500
            total_subidos = 0
            
            if tabla in ['promociones_volumen', 'productos_combos']:
                try:
                    columna_filtro = 'producto_id' if tabla == 'promociones_volumen' else 'producto_padre_id'
                    nube.table(tabla).delete().gt(columna_filtro, 0).execute() 
                except:
                    pass
                for i in range(0, len(registros), tamaño_lote):
                    paquete = registros[i:i + tamaño_lote]
                    nube.table(tabla).insert(paquete).execute() 
                    total_subidos += len(paquete)
            else:
                for i in range(0, len(registros), tamaño_lote):
                    paquete = registros[i:i + tamaño_lote]
                    nube.table(tabla).upsert(paquete).execute()
                    total_subidos += len(paquete)

            print(f"   ✅ ¡Éxito! Se subieron {total_subidos} registros a la nube.\n")
            
        except Exception as e:
            print(f"   ❌ ERROR FATAL al subir {tabla}: {e}\n")
            
    print("☁️ Subiendo copia de seguridad del archivo completo a Supabase Storage...")
    try:
        try: nube.storage.from_('backups').remove(['autoservicio_20dejunio.db'])
        except: pass
        with open('autoservicio_20dejunio.db', 'rb') as f:
            nube.storage.from_('backups').upload('autoservicio_20dejunio.db', f)
        print("✅ Backup guardado a salvo en la nube.")
    except Exception as e:
        pass

    local.close()
    return {"status": "success", "mensaje": "Sincronización a la nube completada."}

if __name__ == "__main__":
    subir_todo_a_la_nube()