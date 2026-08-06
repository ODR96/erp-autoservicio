import sqlite3
import urllib.request
import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()


# TUS CREDENCIALES
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

nube: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def replicar_fila_a_nube(nombre_tabla: str, id_fila: int):
    try:
        conexion = sqlite3.connect('autoservicio_20dejunio.db')
        conexion.row_factory = sqlite3.Row
        cursor = conexion.cursor()
        cursor.execute(f"SELECT * FROM {nombre_tabla} WHERE id = ?", (id_fila,))
        fila = dict(cursor.fetchone())
        conexion.close()

        nube.table(nombre_tabla).upsert(fila).execute()
        print(f"☁️ [REPLICADOR] '{nombre_tabla}' (ID: {id_fila}) guardado en Supabase.")
        
        # --- EL SEGURO DE VIDA: Solo grita si es la PC del Local ---
        if os.environ.get("RENDER") is None:
            try:
                urllib.request.urlopen("https://erp-autoservicio-backend.onrender.com/sync/aviso-cambio", timeout=2)
            except Exception:
                pass
                
    except Exception as e:
        print(f"⚠️ Error del robot replicador en {nombre_tabla}: {e}")

def replicar_dependencias_producto(producto_id: int):
    try:
        conexion = sqlite3.connect('autoservicio_20dejunio.db')
        conexion.row_factory = sqlite3.Row
        cursor = conexion.cursor()
        
        # --- BLINDAJE: Seleccionamos específicamente las columnas sin el ID interno ---
        cursor.execute("SELECT producto_id, cantidad_minima, precio_oferta_unitario FROM promociones_volumen WHERE producto_id = ?", (producto_id,))
        promos = [dict(row) for row in cursor.fetchall()]
        
        cursor.execute("SELECT producto_padre_id, producto_hijo_id, cantidad_hijo FROM productos_combos WHERE producto_padre_id = ?", (producto_id,))
        combos = [dict(row) for row in cursor.fetchall()]
        conexion.close()
        
        # ESCUDO ANTI-CRASH: Lo forzamos a ignorar el error si Supabase se pone estricto
        try: nube.table('promociones_volumen').delete().eq('producto_id', producto_id).execute()
        except: pass
        
        try: nube.table('productos_combos').delete().eq('producto_padre_id', producto_id).execute()
        except: pass
        
        if promos: nube.table('promociones_volumen').insert(promos).execute()
        if combos: nube.table('productos_combos').insert(combos).execute()
            
        print(f"☁️ Reglas Mayoristas y Combos del producto {producto_id} sincronizados.")
        
        # --- EL SEGURO DE VIDA: Solo grita si es la PC del Local ---
        if os.environ.get("RENDER") is None:
            try:
                urllib.request.urlopen("https://erp-autoservicio-backend.onrender.com/sync/aviso-cambio", timeout=2)
            except Exception:
                pass
                
    except Exception as e:
        print(f"⚠️ Error al replicar combos/promos: {e}")