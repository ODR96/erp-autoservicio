import sqlite3

conexion = sqlite3.connect('autoservicio_20dejunio.db')
cursor = conexion.cursor()
try:
    cursor.execute("ALTER TABLE ventas_cabecera ADD COLUMN autorizado_por INTEGER")
    print("Columna 'autorizado_por' agregada con éxito.")
except Exception as e:
    print("La columna ya existía o hubo un error:", e)
    
conexion.commit()
conexion.close()