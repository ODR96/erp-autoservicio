from fastapi import APIRouter, BackgroundTasks
from sincronizador import subir_todo_a_la_nube

router = APIRouter()

@router.post("/forzar-nube")
def forzar_sincronizacion(background_tasks: BackgroundTasks):
    # La tarea se va al fondo para que la página web no se quede "pensando" y trabada
    background_tasks.add_task(subir_todo_a_la_nube)
    return {"mensaje": "Sincronización iniciada en segundo plano."}