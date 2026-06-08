import sqlite3

conexion = sqlite3.connect('autoservicio_20dejunio.db')
cursor = conexion.cursor()
try:
    # Creamos la tabla
    cursor.execute('''CREATE TABLE IF NOT EXISTS categorias_pos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        palabra_clave TEXT NOT NULL,
        icono TEXT,
        color_fondo TEXT
    )''')
    
    # Le metemos las 8 categorías que ya tenías por defecto
    categorias_base = [
        ('Bebidas', 'coca', 'bi-cup-straw', '#90caf9'),
        ('Almacén', 'pan', 'bi-shop', '#a5d6a7'),
        ('Lácteos', 'queso', 'bi-egg', '#fff59d'),
        ('Limpieza', 'lavandina', 'bi-droplet', '#f48fb1'),
        ('Panadería', 'panaderia', 'bi-baguette', '#ffcc80'),
        ('Verdulería', 'fruta', 'bi-apple', '#c5e1a5'),
        ('Fiambrería', 'fiambre', 'bi-pie-chart', '#ffe082'),
        ('Carnes', 'carne', 'bi-piggy-bank', '#ef9a9a')
    ]
    cursor.executemany("INSERT INTO categorias_pos (nombre, palabra_clave, icono, color_fondo) VALUES (?, ?, ?, ?)", categorias_base)
    conexion.commit()
    print("¡Tabla de Categorías POS creada e inicializada!")
except Exception as e:
    print("Hubo un error o la tabla ya existía:", e)
finally:
    conexion.close()