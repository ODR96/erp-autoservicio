import os
import sqlite3

# 1. Calculamos dónde estamos (carpeta backend)
DIRECTORIO_BACKEND = os.path.dirname(os.path.abspath(__file__))

# 2. Subimos un nivel para llegar a la raíz del proyecto
RAIZ_PROYECTO = os.path.dirname(DIRECTORIO_BACKEND)

# 3. Enganchamos el archivo .db
RUTA_DB = os.path.join(RAIZ_PROYECTO, 'autoservicio_20dejunio.db')

def obtener_conexion():
    """Esta función devuelve la conexión lista para usar en cualquier archivo."""
    return sqlite3.connect(RUTA_DB)