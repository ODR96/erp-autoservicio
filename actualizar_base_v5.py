import sqlite3

conexion = obtener_conexion()
cursor = conexion.cursor()
try:
    cursor.execute("ALTER TABLE cola_impresion_etiquetas ADD COLUMN texto_personalizado TEXT DEFAULT ''")
    conexion.commit()
    print("¡Éxito! Columna de texto personalizado agregada.")
except Exception as e:
    print("Aviso:", e)

conexion.close()