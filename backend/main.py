from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles 
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware 
import subprocess
from contextlib import asynccontextmanager
import os
import sqlite3
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# Importamos todos tus módulos
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

from dotenv import load_dotenv
load_dotenv()

# 1. Le decimos a Python que averigüe la ruta exacta de la carpeta donde está este main.py
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 2. Armamos la ruta blindada sumando la carpeta y el archivo .db
RUTA_DB = os.path.join(BASE_DIR, 'autoservicio_20dejunio.db')

# --- 1. MANTENIMIENTO: AUTO-PARCHES DE BASE DE DATOS ---
def inicializar_base():
    try:
        # 3. Nos conectamos usando la ruta dinámica
        conexion = sqlite3.connect(RUTA_DB)
        conexion.execute("CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, nombre_completo TEXT, rol TEXT, codigo_barras_credencial TEXT, pin_secreto TEXT, estado TEXT DEFAULT 'ACTIVO')")
        
        try:
            conexion.execute("ALTER TABLE productos ADD COLUMN unidades_por_bulto INTEGER DEFAULT 1")
        except:
            pass 
        
        try:
            conexion.execute("ALTER TABLE cola_impresion_etiquetas ADD COLUMN plantilla TEXT DEFAULT 'Clasica'")
            conexion.execute("ALTER TABLE cola_impresion_etiquetas ADD COLUMN color_tema TEXT DEFAULT '#1a365d'")
        except:
            pass
            
        conexion.commit()
        conexion.close()
        print(f"✅ Base de datos conectada exitosamente en: {RUTA_DB}")
    except Exception as e:
        print("⚠️ Error en el auto-parche:", e)

@asynccontextmanager
async def lifespan(app: FastAPI):
    inicializar_base() 
    yield

# --- 2. CREAMOS LA APP ---
app = FastAPI(title="ERP Autoservicio 20 de Junio", lifespan=lifespan)

# Creamos el limitador que identifica a los usuarios por su dirección IP
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# --- 3. CONFIGURACIONES DE CARPETAS Y PERMISOS ---
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")

# Ruta para mostrar el ícono en la pestaña del navegador
@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    # Como Uvicorn se ejecuta desde la raíz, buscamos el archivo en la carpeta backend
    return FileResponse("backend/favicon.ico")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 4. LA RUTA DE ACTUALIZACIÓN GIT (Webhook Contabo) ---
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

@app.get("/")
def leer_raiz():
    return {"mensaje": "¡Motor ERP 20 de Junio funcionando al 100% en Contabo!"}