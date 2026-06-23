import os
from fastapi import APIRouter, BackgroundTasks
from sincronizador import subir_todo_a_la_nube
from sincronizador import descargar_novedades_oficina

router = APIRouter()

# 1. Corregimos el nombre a "/forzar" para que el Javascript lo encuentre
@router.post("/forzar")
def forzar_sincronizacion(background_tasks: BackgroundTasks):
    es_nube = os.environ.get("RENDER") is not None
    
    if es_nube:
        # 2. BLINDAJE: Si se aprieta desde Vercel/Celular, no hacemos nada y avisamos.
        return {
            "mensaje": "Estás conectado a la Nube. La subida maestra de ventas y cajas la hace automáticamente la computadora del mostrador local."
        }
    else:
        # 3. Si se aprieta en la PC física, arranca el camión de mudanza
        background_tasks.add_task(subir_todo_a_la_nube)
        return {
            "mensaje": "¡Sincronización iniciada! Subiendo las ventas, stock y backup a la nube en segundo plano..."
        }
        

@router.post("/actualizar-rapido")
def actualizar_rapido_local(background_tasks: BackgroundTasks):
    # Esto solo descarga los datos de la nube, es 100% seguro que el cajero lo toque
    background_tasks.add_task(descargar_novedades_oficina)
    return {"mensaje": "Actualizando permisos y precios..."}