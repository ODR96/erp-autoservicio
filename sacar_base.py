import sqlite3

def extraer_esquema():
    # Conectamos a tu base de datos real
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    
    # Le pedimos a SQLite que nos dé el código de creación de TODAS las tablas
    cursor.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
    tablas = cursor.fetchall()
    
    print("=== COPIÁ TODO LO QUE SALE ACÁ ABAJO Y PASASELO A GEMINI ===\n")
    for nombre, sql in tablas:
        if sql:
            print(f"-- Tabla: {nombre}")
            print(sql + ";\n")
            
    conexion.close()

if __name__ == "__main__":
    extraer_esquema()