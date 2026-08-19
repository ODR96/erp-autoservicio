import os
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from typing import List
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

load_dotenv()

# --- CONFIGURACIÓN DE SEGURIDAD BANCARIA ---
SECRET_KEY = os.environ.get("JWT_SECRET_KEY") 
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 840 

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/usuarios/login")

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
    
class UsuarioActualizar(BaseModel):
    nombre_completo: str
    rol: str
    codigo_barras_credencial: str
    pin_secreto: str = "" 

class LoginRequest(BaseModel):
    codigo_credencial: str
    pin_secreto: str

class AutorizacionRequest(BaseModel):
    pin_secreto: str
    roles_permitidos: List[str]

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
            INSERT INTO usuarios (nombre_completo, rol, codigo_barras_credencial, pin_secreto)
            VALUES (?, ?, ?, ?)
        ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, pin_seguro))
        
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
    
    placeholders = ','.join('?' for _ in req.roles_permitidos)
    query = f"SELECT nombre_completo, rol, pin_secreto FROM usuarios WHERE rol IN ({placeholders}) AND estado = 'ACTIVO'"
    
    cursor.execute(query, req.roles_permitidos)
    usuarios_autorizados = cursor.fetchall()
    conexion.close()
    
    for u in usuarios_autorizados:
        if verificar_pin(req.pin_secreto, u['pin_secreto']):
            return {"autorizado": True, "usuario": u['nombre_completo'], "rol": u['rol']}
            
    raise HTTPException(status_code=401, detail="PIN incorrecto o sin privilegios de Encargado.")


@router.get("/listar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def listar_usuarios():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT id, nombre_completo, rol, codigo_barras_credencial, estado FROM usuarios")
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
                UPDATE usuarios SET nombre_completo = ?, rol = ?, codigo_barras_credencial = ?, pin_secreto = ? WHERE id = ?
            ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, pin_seguro, usuario_id))
        else:
            cursor.execute('''
                UPDATE usuarios SET nombre_completo = ?, rol = ?, codigo_barras_credencial = ? WHERE id = ?
            ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, usuario_id))
            
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