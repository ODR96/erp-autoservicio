import sqlite3
import urllib.request
from supabase import create_client, Client

SUPABASE_URL = "https://fxbxkvagnpuoibtifwjw.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4YnhrdmFnbnB1b2lidGlmd2p3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTM3OTU5NCwiZXhwIjoyMDk2OTU1NTk0fQ.aO0s-A3FwMExlJezGNGu_EUNINa8vgE7gHUbBTmRLpY"
nube: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def replicar_fila_a_nube(nombre_tabla: str, id_fila: int):
    try:
        # 1. Leemos el dato que acabás de guardar desde la tablet
        conexion = sqlite3.connect('autoservicio_20dejunio.db')
        conexion.row_factory = sqlite3.Row
        cursor = conexion.cursor()
        cursor.execute(f"SELECT * FROM {nombre_tabla} WHERE id = ?", (id_fila,))
        fila = dict(cursor.fetchone())
        conexion.close()

        # 2. Lo inyectamos directo en el disco duro de Supabase (PostgreSQL)
        nube.table(nombre_tabla).upsert(fila).execute()
        print(f"☁️ [TABLET/OFICINA] '{nombre_tabla}' (ID: {id_fila}) guardado a salvo en Supabase.")
        # -------------------------------------------------------------
        # 3. NUEVO: EL GRITO DEL WALKIE-TALKIE A RENDER
        # -------------------------------------------------------------
        try:
            # Le damos 2 segundos. Si Render está dormido, cortamos para no congelar tu mostrador.
            urllib.request.urlopen("https://erp-autoservicio-backend.onrender.com/sync/aviso-cambio", timeout=2)
        except Exception:
            pass # Si da error de timeout, no pasa nada, el ping ya viajó y lo va a despertar.
        
    except Exception as e:
        print(f"⚠️ Error del robot replicador en {nombre_tabla}: {e}")
        
def replicar_dependencias_producto(producto_id: int):
    try:
        conexion = sqlite3.connect('autoservicio_20dejunio.db')
        conexion.row_factory = sqlite3.Row
        cursor = conexion.cursor()
        
        # Leemos las promos y combos del disco local
        cursor.execute("SELECT * FROM promociones_volumen WHERE producto_id = ?", (producto_id,))
        promos = [dict(row) for row in cursor.fetchall()]
        
        cursor.execute("SELECT * FROM productos_combos WHERE producto_padre_id = ?", (producto_id,))
        combos = [dict(row) for row in cursor.fetchall()]
        conexion.close()
        
        # En Supabase: Borramos lo viejo y subimos lo nuevo
        nube.table('promociones_volumen').delete().eq('producto_id', producto_id).execute()
        nube.table('productos_combos').delete().eq('producto_padre_id', producto_id).execute()
        
        if promos: nube.table('promociones_volumen').insert(promos).execute()
        if combos: nube.table('productos_combos').insert(combos).execute()
            
        print(f"☁️ Reglas Mayoristas y Combos del producto {producto_id} sincronizados.")
        
        # -------------------------------------------------------------
        # 3. NUEVO: EL GRITO DEL WALKIE-TALKIE A RENDER
        # -------------------------------------------------------------
        try:
            # Le damos 2 segundos. Si Render está dormido, cortamos para no congelar tu mostrador.
            urllib.request.urlopen("https://erp-autoservicio-backend.onrender.com/sync/aviso-cambio", timeout=2)
        except Exception:
            pass # Si da error de timeout, no pasa nada, el ping ya viajó y lo va a despertar.
    except Exception as e:
        print(f"⚠️ Error al replicar combos/promos: {e}")