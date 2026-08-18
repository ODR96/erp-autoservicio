import sqlite3
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
hash_1234 = pwd_context.hash("1234")

conexion = obtener_conexion()
cursor = conexion.cursor()

try:
    cursor.execute("UPDATE usuarios SET pin_secreto = ? WHERE codigo_barras_credencial = 'ADMIN123'", (hash_1234,))
    conexion.commit()
    print("✅ Contraseña de ADMIN123 encriptada correctamente. ¡Sistema blindado!")
except Exception as e:
    print(f"❌ Error: {e}")
finally:
    conexion.close()