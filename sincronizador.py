import sqlite3
from supabase import create_client, Client

# =====================================================================
# 1. TUS CREDENCIALES DE LA NUBE
# =====================================================================
SUPABASE_URL = "https://fxbxkvagnpuoibtifwjw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4YnhrdmFnbnB1b2lidGlmd2p3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTM3OTU5NCwiZXhwIjoyMDk2OTU1NTk0fQ.aO0s-A3FwMExlJezGNGu_EUNINa8vgE7gHUbBTmRLpY" # La que dice service_role
nube: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# =====================================================================
# 2. EL ORDEN DE CARGA (Para no romper las reglas de dependencia)
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

def descargar_cambios_de_la_nube():
    print("⏬ Buscando actualizaciones de precios y productos en la nube...")
    
    local = sqlite3.connect('autoservicio_20dejunio.db')
    local.row_factory = sqlite3.Row
    cursor = local.cursor()
    
    try:
        # 1. Traemos todo el catálogo de productos desde Supabase
        respuesta = nube.table('productos').select('*').execute()
        productos_nube = respuesta.data
        
        for p in productos_nube:
            # 2. Verificamos si el producto ya existe en el local
            cursor.execute("SELECT id FROM productos WHERE id = ?", (p['id'],))
            existe = cursor.fetchone()
            
            if existe:
                # Si existe, le pisamos los precios y datos con lo que dictamina la nube
                cursor.execute('''
                    UPDATE productos 
                    SET nombre = ?, codigo_barras = ?, costo_sin_iva = ?, 
                        precio_venta_final = ?, activo = ?
                    WHERE id = ?
                ''', (p['nombre'], p['codigo_barras'], p['costo_sin_iva'], 
                      p['precio_venta_final'], p['activo'], p['id']))
            else:
                # Si lo creaste nuevo desde tu casa, el local lo inserta virgen
                cursor.execute('''
                    INSERT INTO productos (id, codigo_barras, nombre, costo_sin_iva, precio_venta_final, activo)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (p['id'], p['codigo_barras'], p['nombre'], p['costo_sin_iva'], p['precio_venta_final'], p['activo']))
                
        local.commit()
        print("✅ Precios y catálogo local sincronizados con el dueño.")
        
    except Exception as e:
        print("❌ Error al descargar datos de la nube:", e)
        local.rollback()
    finally:
        local.close()

def subir_todo_a_la_nube():
    print("🚚 Arrancando el camión de mudanza gigante...\n")
    
    descargar_cambios_de_la_nube()
    
    # Conectamos a la base local
    local = sqlite3.connect('autoservicio_20dejunio.db')
    local.row_factory = sqlite3.Row
    cursor = local.cursor()

    for tabla in TABLAS_ORDENADAS:
        print(f"📦 Revisando tabla: {tabla}...")
        
        try:
            # 1. Chequeamos si la tabla existe en tu computadora
            cursor.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{tabla}'")
            if not cursor.fetchone():
                print(f"   ⚠️ La tabla no existe en local. Saltando...\n")
                continue

            # 2. Traemos toda la información
            cursor.execute(f"SELECT * FROM {tabla}")
            registros = [dict(row) for row in cursor.fetchall()]

            if not registros:
                print("   - Está vacía. Saltando al siguiente.\n")
                continue

            # 3. Limpieza de datos (A Supabase no le gustan los valores nulos en columnas matemáticas)
            for r in registros:
                for clave, valor in r.items():
                    # Si hay un campo vacío que debería tener texto, le ponemos cadena vacía
                    if valor is None:
                        r[clave] = None

            # 4. Subimos los datos en paquetes de 500 para que no se corte por internet lento
            tamaño_lote = 500
            total_subidos = 0
            
            for i in range(0, len(registros), tamaño_lote):
                paquete = registros[i:i + tamaño_lote]
                
                # upsert = Si el ID no existe lo crea, si ya existe lo actualiza
                nube.table(tabla).upsert(paquete).execute()
                total_subidos += len(paquete)

            print(f"   ✅ ¡Éxito! Se subieron {total_subidos} registros a la nube.\n")
            
        except Exception as e:
            print(f"   ❌ ERROR FATAL al subir {tabla}: {e}\n")

    local.close()
    return {"status": "success", "mensaje": "Sincronización a la nube completada."}

if __name__ == "__main__":
    subir_todo_a_la_nube()