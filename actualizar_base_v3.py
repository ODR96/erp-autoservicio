import sqlite3

conexion = sqlite3.connect('autoservicio_20dejunio.db')
cursor = conexion.cursor()

try:
    # Agregamos la columna para guardar los días de alerta personalizados (por defecto 10 días)
    cursor.execute("ALTER TABLE productos ADD COLUMN dias_alerta_vencimiento INTEGER DEFAULT 10")
    conexion.commit()
    print("¡Columna de alerta de vencimiento agregada con éxito!")
except Exception as e:
    print("Aviso:", e)

conexion.close()