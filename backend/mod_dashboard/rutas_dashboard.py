from fastapi import APIRouter, Depends
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

router = APIRouter()

@router.get("/datos", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def obtener_datos_dashboard():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # 1. Tarjetas (Hoy)
    cursor.execute("SELECT COUNT(id) as tickets, IFNULL(SUM(total_venta), 0) as ingresos FROM ventas_cabecera WHERE date(fecha_hora) = date('now', 'localtime') AND estado != 'ANULADA'")
    hoy = dict(cursor.fetchone())
    
    # 2. Stock Crítico
    cursor.execute("SELECT p.nombre, p.stock_minimo_alerta, IFNULL(SUM(l.cantidad_disponible), 0) as stock_real FROM productos p LEFT JOIN lotes_stock l ON p.id = l.producto_id WHERE p.activo = 1 GROUP BY p.id HAVING stock_real <= p.stock_minimo_alerta LIMIT 5")
    stock_critico = [dict(row) for row in cursor.fetchall()]
    
    # 3. Mapa de Calor
    cursor.execute("SELECT strftime('%H', fecha_hora) as hora, COUNT(id) as cantidad_ventas FROM ventas_cabecera WHERE estado != 'ANULADA' AND date(fecha_hora) = date('now', 'localtime') GROUP BY hora ORDER BY hora")
    horarios = [dict(row) for row in cursor.fetchall()]
    
    conexion.close()
    return {"hoy": hoy, "stock_critico": stock_critico, "horarios_calientes": horarios}