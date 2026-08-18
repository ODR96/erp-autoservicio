import sqlite3
conexion = obtener_conexion()
cursor = conexion.cursor()

cursor.execute('''CREATE TABLE IF NOT EXISTS productos_solicitados_faltantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
    descripcion_producto TEXT,
    cantidad_pedida REAL,
    notas TEXT
)''')

conexion.commit()
conexion.close()
print("¡Tabla de productos solicitados lista!")