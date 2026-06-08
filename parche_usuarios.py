import sqlite3

conexion = sqlite3.connect('autoservicio_20dejunio.db')
cursor = conexion.cursor()
try:
    cursor.execute('''CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre_completo TEXT NOT NULL,
        rol TEXT,
        codigo_barras_credencial TEXT,
        pin_secreto TEXT,
        estado TEXT DEFAULT 'ACTIVO'
    )''')
    print("Tabla 'usuarios' creada con éxito.")
except Exception as e:
    print("Hubo un error:", e)
    
conexion.commit()
conexion.close()