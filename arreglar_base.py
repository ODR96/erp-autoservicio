import sqlite3

conexion = sqlite3.connect('autoservicio_20dejunio.db')
cursor = conexion.cursor()

# Demolemos las tablas viejas/incompletas
cursor.execute("DROP TABLE IF EXISTS ventas_detalle")
cursor.execute("DROP TABLE IF EXISTS ventas")

conexion.commit()
conexion.close()

print("¡Tablas de ventas borradas con éxito! Ya podés volver a correr crear_base.py")