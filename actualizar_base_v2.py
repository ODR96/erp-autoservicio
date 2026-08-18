import sqlite3

conexion = obtener_conexion()
cursor = conexion.cursor()

# 1. Creamos la tabla de Categorías (que nos habíamos olvidado)
cursor.execute('''CREATE TABLE IF NOT EXISTS categorias_productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    descripcion TEXT
)''')

# 2. Creamos la tabla para el Registro Estricto de Mermas
cursor.execute('''CREATE TABLE IF NOT EXISTS registro_mermas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
    producto_id INTEGER,
    lote_id INTEGER,
    cantidad REAL,
    motivo TEXT, -- Ej: Rotura, Vencimiento, Consumo Interno, Robo
    costo_perdido REAL, -- Cuánta plata perdimos realmente
    usuario_id INTEGER,
    observaciones TEXT
)''')

# 3. La tabla de Promociones por Volumen (Mayorista) YA LA TENÍAMOS (promociones_volumen)
# Te la recuerdo acá para que veas que ya estaba pensada:
# cursor.execute('''CREATE TABLE IF NOT EXISTS promociones_volumen (
#     id INTEGER PRIMARY KEY AUTOINCREMENT,
#     producto_id INTEGER,
#     cantidad_minima REAL,
#     precio_oferta_unitario REAL
# )''')

conexion.commit()
conexion.close()
print("¡Base de datos actualizada con Categorías y Mermas!")