from fastapi import APIRouter, Depends
from datetime import datetime, timedelta, timezone
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))

@router.get("/datos", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_datos_dashboard():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    hoy_ar = datetime.now(ZONA_AR).strftime("%Y-%m-%d")
    
    # 1. Tarjetas (Hoy) — fecha de Argentina, no la del servidor (UTC en Contabo)
    cursor.execute("SELECT COUNT(id) as tickets, IFNULL(SUM(total_venta), 0) as ingresos FROM ventas_cabecera WHERE date(fecha_hora) = ? AND estado != 'ANULADA'", (hoy_ar,))
    hoy = dict(cursor.fetchone())
    
    # 2. Stock Crítico
    cursor.execute("SELECT p.nombre, p.stock_minimo_alerta, IFNULL(SUM(l.cantidad_disponible), 0) as stock_real FROM productos p LEFT JOIN lotes_stock l ON p.id = l.producto_id WHERE p.activo = 1 GROUP BY p.id HAVING stock_real <= p.stock_minimo_alerta LIMIT 5")
    stock_critico = [dict(row) for row in cursor.fetchall()]
    
    # 3. Mapa de Calor
    cursor.execute("SELECT strftime('%H', fecha_hora) as hora, COUNT(id) as cantidad_ventas FROM ventas_cabecera WHERE estado != 'ANULADA' AND date(fecha_hora) = ? GROUP BY hora ORDER BY hora", (hoy_ar,))
    horarios = [dict(row) for row in cursor.fetchall()]
    
    conexion.close()
    return {"hoy": hoy, "stock_critico": stock_critico, "horarios_calientes": horarios}