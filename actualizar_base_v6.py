import sqlite3

conexion = obtener_conexion()
cursor = conexion.cursor()
try:
    cursor.execute("ALTER TABLE productos ADD COLUMN unidad_medida TEXT DEFAULT 'Unidad'")
    conexion.commit()
    print("¡Éxito! Columna 'unidad_medida' agregada al catálogo.")
except Exception as e:
    print("Aviso: Si dice 'duplicate column', es porque ya se había agregado. Detalle:", e)

conexion.close()