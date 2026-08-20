import os
import datetime
import shutil
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

# --- 1. TUS CONFIGURACIONES ---
DB_PATH = "autoservicio_20dejunio.db" # La ruta exacta a tu base de datos
SERVICE_ACCOUNT_FILE = "ruta/a/tu/llave.json" # Dónde guardaste el archivo que bajaste de Google
FOLDER_ID = "TU_CARPETA_ID_ACA" # El código raro que copiaste de la URL de Drive

SCOPES = ['https://www.googleapis.com/auth/drive.file']

def resguardar_base_datos():
    hoy = datetime.datetime.now()
    # Si es el día 1 del mes, le ponemos la etiqueta -mensual para no borrarlo nunca
    es_primero_de_mes = hoy.day == 1
    sufijo = "-mensual" if es_primero_de_mes else "-diario"
    
    nombre_archivo = f"backup_autoservicio_{hoy.strftime('%Y%m%d')}{sufijo}.db"
    backup_local_tmp = f"/tmp/{nombre_archivo}"

    print(f"Iniciando backup: {nombre_archivo}")

    try:
        # A. Congelamos una copia temporal rápida
        shutil.copy2(DB_PATH, backup_local_tmp)

        # B. Nos conectamos a Google Drive con el Bot
        creds = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)
        servicio = build('drive', 'v3', credentials=creds)

        # C. Subimos el archivo a la carpeta
        file_metadata = {'name': nombre_archivo, 'parents': [FOLDER_ID]}
        media = MediaFileUpload(backup_local_tmp, mimetype='application/octet-stream')
        servicio.files().create(body=file_metadata, media_body=media, fields='id').execute()
        print("Subida exitosa a Google Drive.")

        # D. La barredora de los 7 días rotativos (Ignora los mensuales)
        resultados = servicio.files().list(
            q=f"'{FOLDER_ID}' in parents and name contains '-diario'", 
            orderBy="createdTime desc", 
            spaces='drive'
        ).execute()
        
        archivos_diarios = resultados.get('files', [])

        # Si hay más de 7 backups diarios, borramos los más viejos
        if len(archivos_diarios) > 7:
            para_borrar = archivos_diarios[7:]
            for arch in para_borrar:
                servicio.files().delete(fileId=arch['id']).execute()
                print(f"Backup viejo eliminado: {arch['name']}")

    except Exception as e:
        print(f"Error crítico en el resguardo: {e}")
    finally:
        # E. Limpiamos la basura temporal del servidor
        if os.path.exists(backup_local_tmp):
            os.remove(backup_local_tmp)

if __name__ == '__main__':
    resguardar_base_datos()