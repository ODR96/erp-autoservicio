import shutil
import os
from datetime import datetime

# Configuramos nombres
archivo_db = "autoservicio_20dejunio.db"
carpeta_backups = "backups"
fecha_hoy = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
nombre_backup = f"backup_20dejunio_{fecha_hoy}.db"

# Creamos la carpeta de backups si no existe
os.makedirs(carpeta_backups, exist_ok=True)

try:
    # Copiamos la base de datos
    ruta_destino = os.path.join(carpeta_backups, nombre_backup)
    shutil.copy2(archivo_db, ruta_destino)
    print(f"✅ ¡Éxito! Copia de seguridad guardada como: {nombre_backup}")
    
    # OPCIONAL: Si instalás Google Drive en tu PC y elegís que sincronice 
    # la carpeta "backups", esta copia se sube sola a la nube al instante.
    
except Exception as e:
    print(f"❌ Error al hacer el backup: {e}")