import sqlite3

conexion = obtener_conexion()
cursor = conexion.cursor()
try:
    # Esta tabla vincula el "Producto Combo" con sus "Ingredientes"
    cursor.execute('''CREATE TABLE IF NOT EXISTS productos_combos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_padre_id INTEGER,
        producto_hijo_id INTEGER,
        cantidad_hijo REAL,
        FOREIGN KEY(producto_padre_id) REFERENCES productos(id),
        FOREIGN KEY(producto_hijo_id) REFERENCES productos(id)
    )''')
    conexion.commit()
    print("¡Tabla de Combos lista!")
except Exception as e:
    print("Error:", e)
finally:
    conexion.close()