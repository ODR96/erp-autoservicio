from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles 
from fastapi.middleware.cors import CORSMiddleware 
import subprocess
import asyncio
from contextlib import asynccontextmanager
import os

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
from sincronizador import subir_todo_a_la_nube

# --- 1. DEFINIMOS EL LATIDO Y EL CICLO DE VIDA ---
async def latido_sincronizacion():
    while True:
        await asyncio.sleep(900)  
        print("⏳ [Latido Automático] Sincronizando con la nube (Doble Vía)...")
        try:
            await asyncio.to_thread(subir_todo_a_la_nube)
            print("✅ [Latido Automático] Sincronización exitosa.")
        except Exception as e:
            print(f"❌ [Latido Automático] Error en la sincronización: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    tarea_latido = asyncio.create_task(latido_sincronizacion())
    yield
    tarea_latido.cancel()

# --- 2. CREAMOS LA APP (Una sola vez) ---
app = FastAPI(title="ERP Autoservicio 20 de Junio", lifespan=lifespan)

# --- 3. CONFIGURACIONES DE CARPETAS Y PERMISOS ---
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://erp-autoservicio.vercel.app/"], 
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