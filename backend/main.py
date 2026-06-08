from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles # NUEVO: Para poder ver las imágenes
from fastapi.middleware.cors import CORSMiddleware # <--- NUEVO
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


app = FastAPI(title="ERP Autoservicio 20 de Junio")
import os
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")
# Le decimos a Python que permita el acceso público a la carpeta "frontend"
app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Permite que tu HTML se conecte
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    return {"mensaje": "¡El motor principal está encendido y modularizado!"}