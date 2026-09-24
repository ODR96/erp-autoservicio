import os
import re
import secrets
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field
from typing import List, Optional
import sqlite3
from jose import jwt, JWTError
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
import bcrypt
from slowapi import Limiter
from slowapi.util import get_remote_address
from backend.database import obtener_conexion

limiter = Limiter(key_func=get_remote_address)
router = APIRouter()
ZONA_AR = timezone(timedelta(hours=-3))
MINUTOS_AUTORIZACION = 3

load_dotenv()

# --- CONFIGURACIÓN DE SEGURIDAD BANCARIA ---
SECRET_KEY = os.environ.get("JWT_SECRET_KEY") 
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 840 

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/usuarios/login")


def asegurar_columnas_usuarios():
    conexion = obtener_conexion()
    try:
        conexion.execute("ALTER TABLE usuarios ADD COLUMN telefono_whatsapp TEXT DEFAULT ''")
        conexion.commit()
    except Exception:
        pass
    finally:
        conexion.close()


asegurar_columnas_usuarios()

# --- LA AGENCIA DE SEGURIDAD DINÁMICA ---
class VerificarRol:
    def __init__(self, roles_permitidos: list[str]):
        self.roles_permitidos = roles_permitidos

    def __call__(self, token: str = Depends(oauth2_scheme)):
        if not SECRET_KEY:
            raise HTTPException(status_code=500, detail="Falta la clave secreta en el servidor.")
        
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            rol = payload.get("rol")
            
            if rol not in self.roles_permitidos:
                raise HTTPException(
                    status_code=403, 
                    detail=f"Acceso denegado. Se requiere nivel de: {', '.join(self.roles_permitidos)}"
                )
            return payload
        except JWTError:
            raise HTTPException(status_code=401, detail="Sesión inválida o expirada.")

# --- MODELOS ---
class UsuarioNuevo(BaseModel):
    nombre_completo: str
    rol: str 
    codigo_barras_credencial: str
    pin_secreto: str
    telefono_whatsapp: Optional[str] = ""
    
class UsuarioActualizar(BaseModel):
    nombre_completo: str
    rol: str
    codigo_barras_credencial: str
    pin_secreto: str = ""
    telefono_whatsapp: Optional[str] = "" 

class LoginRequest(BaseModel):
    codigo_credencial: str
    pin_secreto: str

class AutorizacionRequest(BaseModel):
    pin_secreto: str
    roles_permitidos: List[str] = []


class AutorizacionRemotaNueva(BaseModel):
    motivo: str = Field(..., min_length=3, max_length=300)
    turno_id: int = 0


class AutorizacionRemotaResolver(BaseModel):
    pin_secreto: str
    decision: str

# --- FUNCIONES CRIPTOGRÁFICAS ---
def obtener_hash_pin(pin):
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(str(pin).encode('utf-8'), salt)
    return hashed.decode('utf-8')

def verificar_pin(pin_plano, pin_hasheado):
    try:
        return bcrypt.checkpw(str(pin_plano).encode('utf-8'), str(pin_hasheado).encode('utf-8'))
    except Exception as e:
        print(f"⚠️ Error criptográfico al verificar PIN: {e}")
        return False

def _ahora_ar():
    return datetime.now(ZONA_AR)


def _stamp(cuando=None):
    return (cuando or _ahora_ar()).strftime("%Y-%m-%d %H:%M:%S")


def asegurar_autorizaciones_remotas():
    conexion = obtener_conexion()
    try:
        conexion.execute('''
            CREATE TABLE IF NOT EXISTS autorizaciones_remotas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL UNIQUE,
                motivo TEXT NOT NULL,
                turno_id INTEGER DEFAULT 0,
                estado TEXT NOT NULL,
                creada_en TEXT NOT NULL,
                vence_en TEXT NOT NULL,
                resuelta_por TEXT
            )
        ''')
        conexion.commit()
    finally:
        conexion.close()


asegurar_autorizaciones_remotas()


def _motivo_plano(texto):
    limpio = re.sub(r"<[^>]+>", " ", texto or "")
    return " ".join(limpio.split())[:300]


def _quien_autoriza(cursor, pin):
    """Solo Admin o Encargado. El rol que mande el cliente no cuenta."""
    cursor.execute(
        "SELECT id, nombre_completo, rol, pin_secreto FROM usuarios WHERE rol IN ('ADMIN', 'ENCARGADO') AND estado = 'ACTIVO'"
    )
    for fila in cursor.fetchall():
        if verificar_pin(pin, fila["pin_secreto"]):
            return fila
    return None


def _marcar_vencida(cursor, fila):
    if not fila or fila["estado"] != "PENDIENTE":
        return fila
    if str(fila["vence_en"]) > _stamp():
        return fila
    cursor.execute(
        "UPDATE autorizaciones_remotas SET estado = 'VENCIDA' WHERE id = ? AND estado = 'PENDIENTE'",
        (fila["id"],),
    )
    return None


def crear_token_acceso(data: dict):
    a_codificar = data.copy()
    expira = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    a_codificar.update({"exp": expira})
    token_jwt = jwt.encode(a_codificar, SECRET_KEY, algorithm=ALGORITHM)
    return token_jwt

# --- RUTAS DE USUARIOS ---

@router.post("/crear", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def crear_usuario(u: UsuarioNuevo): # <-- Adiós BackgroundTasks
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        pin_seguro = obtener_hash_pin(u.pin_secreto)
        cursor.execute('''
            INSERT INTO usuarios (nombre_completo, rol, codigo_barras_credencial, pin_secreto, telefono_whatsapp)
            VALUES (?, ?, ?, ?, ?)
        ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, pin_seguro, (u.telefono_whatsapp or "").strip()))
        
        conexion.commit()
        conexion.close()
        return {"mensaje": f"Usuario {u.nombre_completo} creado con seguridad de alto nivel."}
    except Exception as e:
        if conexion:
            conexion.rollback()
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL EN USUARIOS: {mensaje_error}")
            raise HTTPException(status_code=400, detail="Ocurrió un error interno al procesar la solicitud.")
            
        raise HTTPException(status_code=400, detail=mensaje_error)


@router.post("/login")
@limiter.limit("5/minute")
def iniciar_sesion(request: Request, credenciales: LoginRequest):
    print(f"🔍 [LOGIN] Intento de acceso - Usuario: {credenciales.codigo_credencial}")
    
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    cursor.execute('''
        SELECT id, nombre_completo, rol, pin_secreto, estado 
        FROM usuarios 
        WHERE codigo_barras_credencial = ?
    ''', (credenciales.codigo_credencial,))
    
    fila = cursor.fetchone()
    conexion.close()
    
    if not fila:
        raise HTTPException(status_code=401, detail="No se encontró el usuario en la base de datos.")
        
    usuario = dict(fila)
    
    if usuario.get('estado') != 'ACTIVO':
        raise HTTPException(status_code=401, detail=f"Usuario encontrado pero su estado es: {usuario.get('estado')}")
        
    if not verificar_pin(credenciales.pin_secreto, usuario['pin_secreto']):
        print(f"❌ [LOGIN RECHAZADO] El PIN no coincide para {usuario.get('nombre_completo')}")
        raise HTTPException(status_code=401, detail="Credencial o PIN incorrecto.")
        
    print(f"✅ [LOGIN EXITOSO] Bienvenido {usuario.get('nombre_completo')}")
    
    datos_token = {"sub": str(usuario['id']), "rol": usuario['rol']}
    token = crear_token_acceso(datos_token)
        
    return {
        "mensaje": "Login exitoso",
        "token_acceso": token,
        "usuario": {
            "id": usuario['id'],
            "nombre": usuario['nombre_completo'],
            "rol": usuario['rol']
        }
    }

# --- CORRECCIÓN CLAVE: Límite de intentos y exigencia de sesión para el POS ---
@router.post("/autorizar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
@limiter.limit("10/minute") # Si el cajero le erra 10 veces al PIN en un minuto, bloquea la petición
def autorizar_accion(request: Request, req: AutorizacionRequest):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    quien = _quien_autoriza(cursor, req.pin_secreto)
    conexion.close()
    if not quien:
        raise HTTPException(status_code=401, detail="PIN incorrecto o sin privilegios de Encargado.")
    return {"autorizado": True, "usuario": quien["nombre_completo"], "rol": quien["rol"]}


def _url_publica():
    base = (os.getenv("ERP_PUBLIC_URL") or "http://185.249.225.63:8000").rstrip("/")
    return base


@router.post("/autorizacion-remota", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
@limiter.limit("8/minute")
def pedir_autorizacion_remota(request: Request, body: AutorizacionRemotaNueva):
    motivo = _motivo_plano(body.motivo)
    if len(motivo) < 3:
        return {"error": "Falta el motivo de la autorización."}
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        ahora = _ahora_ar()
        cursor.execute(
            "UPDATE autorizaciones_remotas SET estado = 'VENCIDA' WHERE turno_id = ? AND estado = 'PENDIENTE'",
            (body.turno_id,),
        )
        token = secrets.token_urlsafe(24)
        vence = ahora + timedelta(minutes=MINUTOS_AUTORIZACION)
        cursor.execute(
            '''
            INSERT INTO autorizaciones_remotas (token, motivo, turno_id, estado, creada_en, vence_en)
            VALUES (?, ?, ?, 'PENDIENTE', ?, ?)
            ''',
            (token, motivo, body.turno_id, _stamp(ahora), _stamp(vence)),
        )
        conexion.commit()
        link = f"{_url_publica()}/frontend/autorizar.html?t={token}"
        from backend.whatsapp_puente import avisar_autorizacion_remota
        envio = avisar_autorizacion_remota(motivo, link)
        if not envio.get("ok"):
            cursor.execute("UPDATE autorizaciones_remotas SET estado = 'VENCIDA' WHERE token = ?", (token,))
            conexion.commit()
            return {"error": envio.get("detalle") or "No se pudo avisar por WhatsApp."}
        return {"token": token, "vence_en": _stamp(vence)}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/autorizacion-remota/{token}")
def estado_autorizacion_remota(token: str):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM autorizaciones_remotas WHERE token = ?", (token,))
        fila = cursor.fetchone()
        if not fila:
            return {"error": "Ese pedido no existe."}
        if _marcar_vencida(cursor, fila) is None and fila["estado"] == "PENDIENTE":
            conexion.commit()
            return {"estado": "VENCIDA", "motivo": fila["motivo"]}
        return {
            "estado": fila["estado"],
            "motivo": fila["motivo"],
            "usuario": fila["resuelta_por"] or "",
        }
    finally:
        conexion.close()


@router.post("/autorizacion-remota/{token}/resolver")
@limiter.limit("10/minute")
def resolver_autorizacion_remota(request: Request, token: str, body: AutorizacionRemotaResolver):
    decision = (body.decision or "").strip().upper()
    if decision not in ("APROBADA", "RECHAZADA"):
        return {"error": "La decisión tiene que ser aprobar o rechazar."}
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        quien = _quien_autoriza(cursor, body.pin_secreto)
        if not quien:
            return {"error": "PIN incorrecto o sin privilegios de Encargado."}
        cursor.execute("SELECT * FROM autorizaciones_remotas WHERE token = ?", (token,))
        fila = cursor.fetchone()
        if not fila:
            return {"error": "Ese pedido no existe."}
        if _marcar_vencida(cursor, fila) is None and fila["estado"] == "PENDIENTE":
            conexion.commit()
            return {"error": "Ese pedido ya venció."}
        if fila["estado"] != "PENDIENTE":
            return {"error": "Ese pedido ya se resolvió."}
        cursor.execute(
            "UPDATE autorizaciones_remotas SET estado = ?, resuelta_por = ? WHERE id = ? AND estado = 'PENDIENTE'",
            (decision, quien["nombre_completo"], fila["id"]),
        )
        conexion.commit()
        return {"estado": decision, "usuario": quien["nombre_completo"]}
    except Exception as e:
        conexion.rollback()
        return {"error": str(e)}
    finally:
        conexion.close()


@router.get("/listar", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def listar_usuarios():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id, nombre_completo, rol, codigo_barras_credencial, estado, IFNULL(telefono_whatsapp, '') AS telefono_whatsapp FROM usuarios")
        usuarios = [dict(u) for u in cursor.fetchall()]
        conexion.close()
        return {"usuarios": usuarios}
    except Exception as e:
        if conexion:
            conexion.rollback()
            conexion.close()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}


@router.put("/actualizar/{usuario_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def actualizar_usuario(usuario_id: int, u: UsuarioActualizar): # <-- Adiós BackgroundTasks
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        if u.pin_secreto != "":
            pin_seguro = obtener_hash_pin(u.pin_secreto)
            cursor.execute('''
                UPDATE usuarios SET nombre_completo = ?, rol = ?, codigo_barras_credencial = ?, pin_secreto = ?, telefono_whatsapp = ? WHERE id = ?
            ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, pin_seguro, (u.telefono_whatsapp or "").strip(), usuario_id))
        else:
            cursor.execute('''
                UPDATE usuarios SET nombre_completo = ?, rol = ?, codigo_barras_credencial = ?, telefono_whatsapp = ? WHERE id = ?
            ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, (u.telefono_whatsapp or "").strip(), usuario_id))
            
        conexion.commit()
        conexion.close()
        return {"mensaje": "Empleado actualizado correctamente"}
    except Exception as e:
        if conexion:
            conexion.rollback()
            conexion.close()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}


@router.delete("/baja/{usuario_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def dar_de_baja_usuario(usuario_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        cursor.execute("UPDATE usuarios SET estado = 'INACTIVO' WHERE id = ?", (usuario_id,))
        conexion.commit()
        conexion.close()
        return {"mensaje": "Empleado dado de baja. Ya no podrá ingresar al sistema."}
    except Exception as e:
        if conexion:
            conexion.rollback()
            conexion.close()
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
        return {"error": mensaje_error}


@router.put("/alta/{usuario_id}", dependencies=[Depends(VerificarRol(["ADMIN"]))])
def reactivar_usuario(usuario_id: int):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute("UPDATE usuarios SET estado = 'ACTIVO' WHERE id = ?", (usuario_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Usuario reactivado"}