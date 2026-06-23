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
    print("📥 Buscando actualizaciones de precios de la tablet/oficina...")
    local = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = local.cursor()
    try:
        # 1. Traemos el catálogo fresco de Supabase
        res = nube.table('productos').select('*').execute()
        productos_nube = res.data

        # 2. Los metemos a la fuerza en el SQLite del mostrador (Solo columnas reales)
        for p in productos_nube:
            cursor.execute('''
                INSERT OR REPLACE INTO productos (
                    id, codigo_barras, nombre, categoria_id, proveedor_habitual_id, 
                    costo_sin_iva, porcentaje_iva, precio_venta_final, 
                    stock_minimo_alerta, dias_alerta_vencimiento, unidad_medida, activo
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                p['id'], p.get('codigo_barras',''), p['nombre'], p.get('categoria_id',1), 
                p.get('proveedor_habitual_id',0), p.get('costo_sin_iva',0), 
                p.get('porcentaje_iva',21), p.get('precio_venta_final',0), 
                p.get('stock_minimo_alerta',5), p.get('dias_alerta_vencimiento',0), 
                p.get('unidad_medida','Unidad'), p.get('activo',1)
            ))
            
        local.commit()
        print("✅ Catálogo actualizado en el mostrador.")
    except Exception as e:
        print(f"⚠️ Error descargando novedades: {e}")
        local.rollback()
    finally:
        local.close()

def subir_todo_a_la_nube():
    print("\n🚚 Arrancando el camión de mudanza gigante...\n")
    
    # 1. Primero descargamos lo que hiciste desde tu casa
    descargar_novedades_oficina()
    
    # 2. Conectamos a la base local para subir ventas y cajas
    local = sqlite3.connect('autoservicio_20dejunio.db')
    local.row_factory = sqlite3.Row
    cursor = local.cursor()

    for tabla in TABLAS_ORDENADAS:
        print(f"📦 Revisando tabla: {tabla}...")
        
        try:
            cursor.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{tabla}'")
            if not cursor.fetchone():
                print(f"   ⚠️ La tabla no existe en local. Saltando...\n")
                continue

            cursor.execute(f"SELECT * FROM {tabla}")
            registros = [dict(row) for row in cursor.fetchall()]

            if not registros:
                print("   - Está vacía. Saltando al siguiente.\n")
                continue

            # Limpieza de nulos
            for r in registros:
                for clave, valor in r.items():
                    if valor is None:
                        r[clave] = None

            # Subida en paquetes de 500
            tamaño_lote = 500
            total_subidos = 0
            
            for i in range(0, len(registros), tamaño_lote):
                paquete = registros[i:i + tamaño_lote]
                nube.table(tabla).upsert(paquete).execute()
                total_subidos += len(paquete)

            print(f"   ✅ ¡Éxito! Se subieron {total_subidos} registros a la nube.\n")
            
        except Exception as e:
            print(f"   ❌ ERROR FATAL al subir {tabla}: {e}\n")
            
    # --- SUBIDA DEL ARCHIVO FÍSICO AL STORAGE ---
    print("☁️ Subiendo copia de seguridad del archivo completo a Supabase Storage...")
    try:
        try: nube.storage.from_('backups').remove(['autoservicio_20dejunio.db'])
        except: pass
        
        with open('autoservicio_20dejunio.db', 'rb') as f:
            nube.storage.from_('backups').upload('autoservicio_20dejunio.db', f)
        print("✅ Backup guardado a salvo en la nube.")
    except Exception as e:
        print("⚠️ No se pudo subir el archivo físico:", e)

    local.close()
    return {"status": "success", "mensaje": "Sincronización a la nube completada."}

if __name__ == "__main__":
    subir_todo_a_la_nube()