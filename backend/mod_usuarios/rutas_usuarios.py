from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import List
import sqlite3
from passlib.context import CryptContext
from jose import jwt, JWTError
from datetime import datetime, timedelta

router = APIRouter()

# --- CONFIGURACIÓN DE SEGURIDAD BANCARIA ---
SECRET_KEY = "clave_secreta_super_robusta_autoservicio_20_de_junio" 
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 840 # 14 horas de vigencia del token

# Configuramos el motor de encriptación
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

class UsuarioNuevo(BaseModel):
    nombre_completo: str
    rol: str # "CAJERO", "ENCARGADO", "ADMIN"
    codigo_barras_credencial: str
    pin_secreto: str
    
class UsuarioActualizar(BaseModel):
    nombre_completo: str
    rol: str
    codigo_barras_credencial: str
    pin_secreto: str = "" # Lo hacemos opcional

class LoginRequest(BaseModel):
    codigo_credencial: str
    pin_secreto: str

def verificar_pin(pin_plano, pin_hasheado):
    try:
        # 1. Intenta compararlo usando el motor de encriptación
        return pwd_context.verify(pin_plano, pin_hasheado)
    except ValueError:
        # 2. Si falla porque el texto no está encriptado (cargado a mano en BD), lo compara directo
        return pin_plano == str(pin_hasheado)

def obtener_hash_pin(pin):
    return pwd_context.hash(pin)

def crear_token_acceso(data: dict):
    a_codificar = data.copy()
    expira = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    a_codificar.update({"exp": expira})
    token_jwt = jwt.encode(a_codificar, SECRET_KEY, algorithm=ALGORITHM)
    return token_jwt

# --- 1. CREAR USUARIO (Con PIN Encriptado) ---
@router.post("/crear")
def crear_usuario(u: UsuarioNuevo):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # Encriptamos la contraseña antes de tocar la base de datos
        pin_seguro = obtener_hash_pin(u.pin_secreto)
        
        cursor.execute('''
            INSERT INTO usuarios (nombre_completo, rol, codigo_barras_credencial, pin_secreto)
            VALUES (?, ?, ?, ?)
        ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, pin_seguro))
        conexion.commit()
        conexion.close()
        return {"mensaje": f"Usuario {u.nombre_completo} creado con seguridad de alto nivel."}
    except Exception as e:
        conexion.close()
        raise HTTPException(status_code=400, detail=f"Error al crear usuario: {e}")

# --- 2. LOGIN (Generación del Token JWT) ---
@router.post("/login")
def iniciar_sesion(credenciales: LoginRequest):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    cursor.execute('''
        SELECT id, nombre_completo, rol, pin_secreto 
        FROM usuarios 
        WHERE codigo_barras_credencial = ? AND estado = 'ACTIVO'
    ''', (credenciales.codigo_credencial,))
    
    usuario = cursor.fetchone()
    conexion.close()
    
    # Comparamos el PIN plano que escribió el cajero con el Hash indescifrable
    if not usuario or not verificar_pin(credenciales.pin_secreto, usuario['pin_secreto']):
        raise HTTPException(status_code=401, detail="Credencial o PIN incorrecto.")
        
    # Si todo está bien, armamos la pulsera VIP digital
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
    
    # --- NUEVO: VENTANILLA RÁPIDA DE AUTORIZACIÓN PARA EL POS ---
class AutorizacionRequest(BaseModel):
    pin_secreto: str
    roles_permitidos: List[str]

@router.post("/autorizar")
def autorizar_accion(req: AutorizacionRequest):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    # Buscamos a todos los usuarios que tengan permiso (ej: ENCARGADO o ADMIN)
    placeholders = ','.join('?' for _ in req.roles_permitidos)
    query = f"SELECT nombre_completo, rol, pin_secreto FROM usuarios WHERE rol IN ({placeholders}) AND estado = 'ACTIVO'"
    
    cursor.execute(query, req.roles_permitidos)
    usuarios_autorizados = cursor.fetchall()
    conexion.close()
    
    # Comparamos el PIN que escribieron en la caja con el de todos los jefes
    for u in usuarios_autorizados:
        if verificar_pin(req.pin_secreto, u['pin_secreto']):
            return {"autorizado": True, "usuario": u['nombre_completo'], "rol": u['rol']}
            
    # Si no coincide con ninguno, lo rebotamos
    raise HTTPException(status_code=401, detail="PIN incorrecto o sin privilegios de Encargado.")

# --- 3. EL PATOVICA DIGITAL (Ahora lee tokens) ---
def verificar_permiso(token: str, roles_permitidos: List[str]):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        rol_usuario = payload.get("rol")
        if rol_usuario not in roles_permitidos:
            return False
        return True
    except JWTError:
        return False
    
    # --- 4. LISTAR EMPLEADOS (Para el panel de Admin) ---
@router.get("/listar")
def listar_usuarios():
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # No devolvemos el PIN por seguridad
        cursor.execute("SELECT id, nombre_completo, rol, codigo_barras_credencial, estado FROM usuarios")
        usuarios = [dict(u) for u in cursor.fetchall()]
        conexion.close()
        return {"usuarios": usuarios}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}
    
    # --- 5. ACTUALIZAR EMPLEADO ---
@router.put("/actualizar/{usuario_id}")
def actualizar_usuario(usuario_id: int, u: UsuarioActualizar):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        if u.pin_secreto != "":
            # Si escribió un PIN nuevo, lo encriptamos y lo pisamos
            pin_seguro = obtener_hash_pin(u.pin_secreto)
            cursor.execute('''
                UPDATE usuarios SET nombre_completo = ?, rol = ?, codigo_barras_credencial = ?, pin_secreto = ? WHERE id = ?
            ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, pin_seguro, usuario_id))
        else:
            # Si lo dejó en blanco, actualizamos todo MENOS el PIN
            cursor.execute('''
                UPDATE usuarios SET nombre_completo = ?, rol = ?, codigo_barras_credencial = ? WHERE id = ?
            ''', (u.nombre_completo, u.rol, u.codigo_barras_credencial, usuario_id))
            
        conexion.commit()
        conexion.close()
        return {"mensaje": "Empleado actualizado correctamente"}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}

# --- 6. DAR DE BAJA (Despedir / Bloquear) ---
@router.delete("/baja/{usuario_id}")
def dar_de_baja_usuario(usuario_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    try:
        # No lo borramos de la base (para no romper el historial de ventas), solo lo inactivamos
        cursor.execute("UPDATE usuarios SET estado = 'INACTIVO' WHERE id = ?", (usuario_id,))
        conexion.commit()
        conexion.close()
        return {"mensaje": "Empleado dado de baja. Ya no podrá ingresar al sistema."}
    except Exception as e:
        conexion.close()
        return {"error": str(e)}
    
@router.put("/alta/{usuario_id}")
def reactivar_usuario(usuario_id: int):
    conexion = sqlite3.connect('autoservicio_20dejunio.db')
    cursor = conexion.cursor()
    cursor.execute("UPDATE usuarios SET estado = 'ACTIVO' WHERE id = ?", (usuario_id,))
    conexion.commit()
    conexion.close()
    return {"mensaje": "Usuario reactivado"}