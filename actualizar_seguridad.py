import sqlite3

conexion = sqlite3.connect('autoservicio_20dejunio.db')
cursor = conexion.cursor()

try:
    # 1. Creamos la tabla de Usuarios/Empleados
    cursor.execute('''CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre_completo TEXT NOT NULL,
        rol TEXT NOT NULL, -- Puede ser 'CAJERO', 'ENCARGADO', 'ADMIN'
        codigo_barras_credencial TEXT UNIQUE, -- El código que lee el escáner
        pin_secreto TEXT,
        estado TEXT DEFAULT 'ACTIVO'
    )''')

    # 2. Te creamos a vos como ADMIN supremo (Código de barras: "ADMIN123")
    cursor.execute('''
        INSERT OR IGNORE INTO usuarios (id, nombre_completo, rol, codigo_barras_credencial, pin_secreto)
        VALUES (1, 'Orlando (Dueño)', 'ADMIN', 'ADMIN123', '1234')
    ''')

    # 3. Le agregamos la columna "autorizado_por" a las ventas
    cursor.execute("ALTER TABLE ventas_cabecera ADD COLUMN autorizado_por INTEGER")
    
    conexion.commit()
    print("¡Éxito! Sistema de seguridad y credenciales instalado.")
except Exception as e:
    print("Nota: Si dice 'duplicate column', ya estaba actualizado. Detalle:", e)

conexion.close()