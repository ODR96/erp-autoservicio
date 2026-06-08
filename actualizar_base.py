import sqlite3

conexion = sqlite3.connect('autoservicio_20dejunio.db')
cursor = conexion.cursor()

try:
    # Le agregamos la columna de "stock_comprometido" a la tabla de productos
    cursor.execute("ALTER TABLE productos ADD COLUMN stock_comprometido REAL DEFAULT 0")
    conexion.commit()
    print("¡Éxito! La columna 'stock_comprometido' se agregó perfectamente al catálogo.")
except Exception as e:
    print("Aviso: Si dice 'duplicate column', es porque ya se había agregado antes. Detalle:", e)

conexion.close()