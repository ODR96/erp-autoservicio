import sqlite3

try:
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    # Agregamos la columna que me olvidé de crearte al principio del proyecto
    cursor.execute("ALTER TABLE movimientos_stock ADD COLUMN motivo TEXT")
    conexion.commit()
    print("¡Éxito! Columna 'motivo' agregada a la base de datos.")
except Exception as e:
    print(f"Aviso: {e} (Si dice 'duplicate column', es porque ya existía).")
finally:
    conexion.close()