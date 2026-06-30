from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles 
from fastapi.middleware.cors import CORSMiddleware 
import subprocess
import asyncio
from contextlib import asynccontextmanager
import os
import sqlite3

from backend.mod_productos.rutas_productos import router as router_productos
from backend.mod_lotes.rutas_lotes import router as router_lotes
from backend.mod_ventas.rutas_ventas import router as router_ventas
from backend.mod_venta_deposito.rutas_deposito import router as router_deposito
from backend.mod_caja.rutas_caja import router as router_caja
from backend.mod_gastos.rutas_gastos import router as router_gastos
from backend.mod_clientes.rutas_clientes import router as router_clientes
from backend.mod_proveedores.rutas_proveedores import router as router_proveedores
from backend.mod_reportes.rutas_reportes import router as router_reportes
from backend.mod_usuarios.rutas_usuarios import router as router_usuarios
from backend.mod_config.rutas_config import router as router_config
from backend.mod_sincronizacion.rutas_sync import router as rutas_sync
from sincronizador import subir_todo_a_la_nube, descargar_novedades_oficina 
from fastapi import BackgroundTasks


# --- 0. SALVAVIDAS Y AUTO-PARCHES PARA RENDER Y LOCAL ---
def inicializar_base_vacia():
    es_nube = os.environ.get("RENDER") is not None
    
    # 1. Si es Render, primero baja el archivo viejo (que todavía no tiene la columna)
    if es_nube:
        print("📥 [Render] Despertando: Recuperando memoria desde Supabase Storage...")
        try:
            from supabase import create_client
            nube = create_client("https://fxbxkvagnpuoibtifwjw.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4YnhrdmFnbnB1b2lidGlmd2p3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTM3OTU5NCwiZXhwIjoyMDk2OTU1NTk0fQ.aO0s-A3FwMExlJezGNGu_EUNINa8vgE7gHUbBTmRLpY")            
            res = nube.storage.from_('backups').download('autoservicio_20dejunio.db')
            with open('autoservicio_20dejunio.db', 'wb') as f:
                f.write(res)
            print("✅ [Render] Backup base clonado exitosamente.")
        except Exception as e:
            print("⚠️ Aviso: No se encontró backup físico aún.")

    # 2. EL AUTO-PARCHE (Se ejecuta SIEMPRE, tanto en la Nube como en el Mostrador local)
    try:
        conexion = sqlite3.connect('autoservicio_20dejunio.db')
        # El salvavidas original de usuarios
        conexion.execute("CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, nombre_completo TEXT, rol TEXT, codigo_barras_credencial TEXT, pin_secreto TEXT, estado TEXT DEFAULT 'ACTIVO')")
        
        # LA MAGIA: Intenta agregar la columna. Si la columna ya existe, SQLite tira error y sigue callado sin romper nada.
        try:
            conexion.execute("ALTER TABLE productos ADD COLUMN unidades_por_bulto INTEGER DEFAULT 1")
            print("🔧 [Auto-Parche] Evolución aplicada: Columna 'unidades_por_bulto' agregada a SQLite.")
        except:
            pass # Si falla es porque la columna ya existe, está todo perfecto.
            
        conexion.commit()
        conexion.close()
    except Exception as e:
        print("⚠️ Error en el auto-parche:", e)

    # 3. Si es Render, ahora que la base ya está parchada, puede bajar los precios sin que explote
    if es_nube:
        try:
            print("📥 [Render] Aplicando novedades de último minuto...")
            descargar_novedades_oficina()
            print("✅ [Render] Memoria 100% curada y actualizada al segundo.")
        except Exception as e:
            print(f"⚠️ Error al aplicar novedades: {e}")

# --- 1. DEFINIMOS EL LATIDO INTELIGENTE ---
async def latido_sincronizacion():
    # Render automáticamente tiene una variable de entorno llamada RENDER
    es_nube = os.environ.get("RENDER") is not None
    
    while True:
        await asyncio.sleep(900)  
        if es_nube:
            print("☁️ [Nube] Soy Render. No subo datos para no pisar la información real.")
            # Más adelante acá haremos que Render descargue la info
        else:
            print("🏪 [Local] Soy el Mostrador. Subiendo datos frescos a Supabase...")
            try:
                await asyncio.to_thread(subir_todo_a_la_nube)
                print("✅ [Latido Automático] Sincronización exitosa.")
            except Exception as e:
                print(f"❌ [Latido Automático] Error en la sincronización: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    inicializar_base_vacia() # Corremos el salvavidas antes de arrancar
    tarea_latido = asyncio.create_task(latido_sincronizacion())
    yield
    tarea_latido.cancel()

# --- 2. CREAMOS LA APP ---
app = FastAPI(title="ERP Autoservicio 20 de Junio", lifespan=lifespan)

# --- 3. CONFIGURACIONES DE CARPETAS Y PERMISOS ---
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "${obtenerBaseUrl()}",
        "https://erp-autoservicio.vercel.app" # <--- TU LINK EXACTO, SIN BARRA AL FINAL
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 4. LA RUTA DE ACTUALIZACIÓN GIT ---
@app.post("/actualizar-sistema")
def actualizar_codigo_git():
    try:
        resultado = subprocess.run(["git", "pull"], capture_output=True, text=True, check=True)
        return {
            "mensaje": "¡Sistema actualizado con éxito desde la nube!", 
            "detalle": resultado.stdout
        }
    except subprocess.CalledProcessError as e:
        return {
            "error": "Hubo un problema al intentar descargar la actualización.", 
            "detalle": e.stderr
        }

# --- 5. ENCHUFAMOS TODOS LOS MÓDULOS ---
app.include_router(router_productos, prefix="/productos", tags=["Productos"])
app.include_router(router_lotes, prefix="/lotes", tags=["Lotes y Stock (FIFO)"])
app.include_router(router_ventas, prefix="/ventas", tags=["Caja y Ventas"])
app.include_router(router_deposito, prefix="/deposito", tags=["Ventas por Depósito"])
app.include_router(router_caja, prefix="/caja", tags=["Control de Caja y Turnos"])
app.include_router(router_gastos, prefix="/gastos", tags=["Gastos y Salidas"])
app.include_router(router_clientes, prefix="/clientes", tags=["Clientes y Cuentas Corrientes"])
app.include_router(router_proveedores, prefix="/proveedores", tags=["Proveedores y Compras"])
app.include_router(router_reportes, prefix="/reportes", tags=["Dashboard y Estadísticas"])
app.include_router(router_usuarios, prefix="/usuarios", tags=["Personal y Permisos"])
app.include_router(router_config, prefix="/config", tags=["Ajustes del Local y Logo"])
app.include_router(rutas_sync, prefix="/sync")

@app.get("/")
def leer_raiz():
    return {"mensaje": "¡El motor principal está encendido y modularizado!"}

@app.get("/radiografia")
def ver_estado_nube():
    try:
        import sqlite3
        conexion = sqlite3.connect('autoservicio_20dejunio.db')
        cursor = conexion.cursor()
        cursor.execute("SELECT count(*) FROM productos")
        prods = cursor.fetchone()[0]
        cursor.execute("SELECT count(*) FROM usuarios")
        usrs = cursor.fetchone()[0]
        conexion.close()
        return {
            "estado": "Render está funcionando perfecto", 
            "cantidad_productos_en_la_nube": prods, 
            "cantidad_usuarios_en_la_nube": usrs
        }
    except Exception as e:
        return {"estado": "ERROR", "detalle": str(e)}
    
# ESTE ES EL RECEPTOR DEL WALKIE-TALKIE
@app.get("/sync/aviso-cambio")
def aviso_de_cambio(background_tasks: BackgroundTasks):
    # Render recibe el grito y actualiza su memoria interna en segundo plano
    background_tasks.add_task(descargar_novedades_oficina)
    return {"mensaje": "Enterado. Actualizando la Nube..."}