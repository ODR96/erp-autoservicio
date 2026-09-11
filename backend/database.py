import os
import sqlite3

# 1. Calculamos dónde estamos (carpeta backend)
DIRECTORIO_BACKEND = os.path.dirname(os.path.abspath(__file__))

# 2. Subimos un nivel para llegar a la raíz del proyecto
RAIZ_PROYECTO = os.path.dirname(DIRECTORIO_BACKEND)

# 3. Enganchamos el archivo .db
RUTA_DB = os.path.join(RAIZ_PROYECTO, 'autoservicio_20dejunio.db')

def obtener_conexion():
    """Esta función devuelve la conexión lista para usar en cualquier archivo.

    check_same_thread=False: FastAPI ejecuta los endpoints sincrónicos (def, sin async)
    dentro de un threadpool. Con dependencias que usan "yield" (como get_db() en
    mod_gastos), el framework puede abrir la conexión en un hilo del pool y cerrarla
    en OTRO hilo distinto del mismo pool — sqlite3 por defecto no lo permite y tira
    "SQLite objects created in a thread can only be used in that same thread".
    Es seguro desactivar esa validación acá porque NUNCA compartimos una misma
    conexión entre requests concurrentes: cada llamada a obtener_conexion() crea
    una conexión nueva y exclusiva para esa request.
    """
    return sqlite3.connect(RUTA_DB, check_same_thread=False)