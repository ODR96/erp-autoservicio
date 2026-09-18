from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, date, timezone, timedelta
import calendar
import re
import sqlite3
from backend.database import obtener_conexion
from backend.mod_usuarios.rutas_usuarios import VerificarRol

ZONA_AR = timezone(timedelta(hours=-3))

router = APIRouter()

# --- 1. MODELOS DE DATOS ---
class ClienteNuevo(BaseModel):
    nombre_completo: str
    cuit: Optional[str] = ""
    condicion_iva: str = "Consumidor Final" # <-- NUEVO BLINDAJE AFIP
    telefono_whatsapp: Optional[str] = ""
    direccion: Optional[str] = ""
    limite_credito: float = 50000.0
    dia_vencimiento: Optional[int] = None


def _normalizar_dia_vencimiento(valor):
    if valor is None or valor == "":
        return None
    try:
        dia = int(valor)
    except (TypeError, ValueError):
        raise ValueError("El día de cobro debe ser un número del 1 al 31.")
    if dia == 0:
        return None
    if dia < 1 or dia > 31:
        raise ValueError("El día de cobro debe estar entre 1 y 31.")
    return dia


def _hoy_ar():
    return datetime.now(ZONA_AR).date()


def _parse_fecha_mov(valor):
    s = str(valor or "").replace("T", " ")[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return _hoy_ar()


def _ultimo_cierre(dia, hoy):
    dia = int(dia)

    def cierre_mes(y, m):
        return date(y, m, min(dia, calendar.monthrange(y, m)[1]))

    c_este = cierre_mes(hoy.year, hoy.month)
    if hoy >= c_este:
        return c_este
    if hoy.month == 1:
        return cierre_mes(hoy.year - 1, 12)
    return cierre_mes(hoy.year, hoy.month - 1)


def _ticket_detalle(detalle):
    m = re.search(r"#(\d+)", detalle or "")
    return m.group(1) if m else None


def _aplicar_a_cargos(cargos, monto, ticket=None):
    resto = float(monto or 0)
    if resto <= 0:
        return
    if ticket:
        for c in cargos:
            if resto <= 0:
                break
            if c["ticket"] == ticket and c["restante"] > 0:
                toma = min(c["restante"], resto)
                c["restante"] -= toma
                resto -= toma
    for c in cargos:
        if resto <= 0:
            break
        if c["restante"] <= 0:
            continue
        toma = min(c["restante"], resto)
        c["restante"] -= toma
        resto -= toma


def _metodo_desde_detalle(detalle):
    m = re.search(r"\(([^)]+)\)\s*$", detalle or "")
    return (m.group(1) if m else "PAGO").strip() or "PAGO"


def _nombre_cliente(cliente):
    try:
        return cliente["nombre_completo"] if "nombre_completo" in cliente.keys() else ""
    except Exception:
        return str(cliente.get("nombre_completo") or "") if hasattr(cliente, "get") else ""


def _estado_cuenta_de(cursor, cliente, hasta_id=None, al=None):
    saldo_cache = round(float(cliente["saldo_actual_deudor"] or 0), 2)
    try:
        dia = int(cliente["dia_vencimiento"]) if cliente["dia_vencimiento"] not in (None, "", 0) else None
        if dia < 1 or dia > 31:
            dia = None
    except (TypeError, ValueError, KeyError):
        dia = None

    hoy = al or _hoy_ar()
    sql = """
        SELECT id, fecha_hora, tipo_movimiento, monto, IFNULL(detalle, '') as detalle
        FROM movimientos_clientes
        WHERE cliente_id = ?
    """
    params = [cliente["id"]]
    if hasta_id is not None:
        sql += " AND id <= ?"
        params.append(int(hasta_id))
    sql += " ORDER BY fecha_hora ASC, id ASC"
    cursor.execute(sql, params)

    cargos = []
    saldo_recon = 0.0
    for m in cursor.fetchall():
        tipo = (m["tipo_movimiento"] or "").upper()
        monto = float(m["monto"] or 0)
        if tipo in ("CARGO", "RECARGO"):
            saldo_recon += monto
            cargos.append({
                "fecha": _parse_fecha_mov(m["fecha_hora"]),
                "restante": monto,
                "ticket": _ticket_detalle(m["detalle"]),
            })
        elif tipo in ("PAGO", "PAGO_ANULACION"):
            saldo_recon -= monto
            tick = _ticket_detalle(m["detalle"]) if tipo == "PAGO_ANULACION" else None
            _aplicar_a_cargos(cargos, monto, tick)

    saldo = round(saldo_recon, 2) if hasta_id is not None else saldo_cache
    a_favor = round(-saldo, 2) if saldo < 0 else 0.0
    base = {
        "cliente_id": cliente["id"],
        "nombre": _nombre_cliente(cliente),
        "dia_vencimiento": dia,
        "sin_pactar": dia is None,
        "ultimo_cierre": None,
        "saldo": saldo,
        "vencido": 0.0,
        "abierto": 0.0,
        "a_favor": a_favor,
    }
    if saldo <= 0:
        return base

    vencido = 0.0
    abierto = 0.0
    if dia:
        ultimo = _ultimo_cierre(dia, hoy)
        base["ultimo_cierre"] = ultimo.isoformat()
        for c in cargos:
            if c["restante"] <= 0:
                continue
            if c["fecha"] < ultimo:
                vencido += c["restante"]
            else:
                abierto += c["restante"]
    else:
        abierto = sum(c["restante"] for c in cargos if c["restante"] > 0)

    recon = round(vencido + abierto, 2)
    if recon > 0.009 and abs(recon - saldo) > 0.05:
        factor = saldo / recon
        vencido *= factor
        abierto *= factor
    elif recon <= 0.009:
        abierto = saldo
        vencido = 0.0

    base["vencido"] = round(max(vencido, 0), 2)
    base["abierto"] = round(max(abierto, 0), 2)
    return base

class PagoDeuda(BaseModel):
    monto_pago: float
    metodo_pago: str 
    observaciones: Optional[str] = ""
    usuario_id: int = 1
    afecta_caja: bool = False  # <-- EL SWITCH INTELIGENTE
    turno_id: Optional[int] = None

# --- FUNCIÓN DE ARRANQUE (Mantenimiento Automático) ---
def inicializar_tabla_movimientos():
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    cursor.execute('''CREATE TABLE IF NOT EXISTS movimientos_clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER,
        fecha_hora DATETIME,
        tipo_movimiento TEXT, 
        monto REAL,
        detalle TEXT,
        usuario_id INTEGER
    )''')
    
    # PARCHE DE MIGRACIÓN: Le inyectamos la columna IVA a tu tabla vieja sin romper nada
    try:
        cursor.execute("ALTER TABLE clientes ADD COLUMN condicion_iva TEXT DEFAULT 'Consumidor Final'")
    except sqlite3.OperationalError:
        pass # Si tira error es porque ya existe, seguimos de largo
    try:
        cursor.execute("ALTER TABLE clientes ADD COLUMN dia_vencimiento INTEGER")
    except sqlite3.OperationalError:
        pass

    conexion.commit()
    conexion.close()

inicializar_tabla_movimientos()

# --- 2. GESTIÓN DE CLIENTES (Crear, Editar y Listar) ---
@router.post("/registrar", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_cliente(cli: ClienteNuevo):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        dia_cobro = _normalizar_dia_vencimiento(cli.dia_vencimiento)
        cursor.execute('''
            INSERT INTO clientes (nombre_completo, cuit, condicion_iva, telefono_whatsapp, direccion, limite_credito, saldo_actual_deudor, dia_vencimiento)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        ''', (cli.nombre_completo, cli.cuit, cli.condicion_iva, cli.telefono_whatsapp, cli.direccion, cli.limite_credito, dia_cobro))
        conexion.commit()
        return {"mensaje": f"Cliente {cli.nombre_completo} dado de alta con éxito."}
    except Exception as e:
        if conexion:
            conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        # 2. Si es un error de negocio tuyo, lo mostramos normal
        return {"error": mensaje_error}
    finally:
        conexion.close()

@router.put("/actualizar/{cliente_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def actualizar_cliente(cliente_id: int, cli: ClienteNuevo):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        dia_cobro = _normalizar_dia_vencimiento(cli.dia_vencimiento)
        cursor.execute('''
            UPDATE clientes 
            SET nombre_completo = ?, cuit = ?, condicion_iva = ?, telefono_whatsapp = ?, direccion = ?, limite_credito = ?, dia_vencimiento = ?
            WHERE id = ?
        ''', (cli.nombre_completo, cli.cuit, cli.condicion_iva, cli.telefono_whatsapp, cli.direccion, cli.limite_credito, dia_cobro, cliente_id))
        conexion.commit()
        return {"mensaje": f"Ficha de {cli.nombre_completo} actualizada."}
    except Exception as e:
        if conexion:
            conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        # 2. Si es un error de negocio tuyo, lo mostramos normal
        return {"error": mensaje_error}
    finally:
        conexion.close()

@router.get("/listado", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_clientes():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    cursor.execute("SELECT * FROM clientes ORDER BY nombre_completo ASC")
    clientes = [dict(c) for c in cursor.fetchall()]
    conexion.close()
    return {"clientes": clientes}


@router.get("/estado_cuenta/{cliente_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def estado_cuenta_cliente(cliente_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute("SELECT * FROM clientes WHERE id = ?", (cliente_id,))
        cliente = cursor.fetchone()
        if not cliente:
            raise HTTPException(status_code=404, detail="Cliente no encontrado.")
        return _estado_cuenta_de(cursor, cliente)
    finally:
        conexion.close()


@router.get("/recibo_pago/{movimiento_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def recibo_pago_historico(movimiento_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute(
            """
            SELECT id, cliente_id, fecha_hora, tipo_movimiento, monto, IFNULL(detalle, '') as detalle
            FROM movimientos_clientes WHERE id = ?
            """,
            (movimiento_id,),
        )
        mov = cursor.fetchone()
        if not mov:
            raise HTTPException(status_code=404, detail="Movimiento no encontrado.")
        if (mov["tipo_movimiento"] or "").upper() != "PAGO":
            raise HTTPException(status_code=400, detail="Solo se reimprime un cobro (PAGO).")
        cursor.execute("SELECT * FROM clientes WHERE id = ?", (mov["cliente_id"],))
        cliente = cursor.fetchone()
        if not cliente:
            raise HTTPException(status_code=404, detail="Cliente no encontrado.")
        al = _parse_fecha_mov(mov["fecha_hora"])
        est = _estado_cuenta_de(cursor, cliente, hasta_id=mov["id"], al=al)
        return {
            "movimiento_id": mov["id"],
            "fecha": mov["fecha_hora"],
            "monto": float(mov["monto"] or 0),
            "metodo": _metodo_desde_detalle(mov["detalle"]),
            "detalle": mov["detalle"],
            **est,
        }
    finally:
        conexion.close()


@router.get("/deudores", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def listar_deudores():
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute(
            "SELECT * FROM clientes WHERE IFNULL(saldo_actual_deudor, 0) != 0 ORDER BY nombre_completo"
        )
        filas = []
        for c in cursor.fetchall():
            est = _estado_cuenta_de(cursor, c)
            item = dict(c)
            item["vencido"] = est["vencido"]
            item["abierto"] = est["abierto"]
            item["a_favor"] = est["a_favor"]
            item["ultimo_cierre"] = est["ultimo_cierre"]
            item["sin_pactar"] = est["sin_pactar"]
            filas.append(item)
        filas.sort(key=lambda r: (-float(r["vencido"] or 0), -abs(float(r["saldo_actual_deudor"] or 0))))
        return {"deudores": filas}
    finally:
        conexion.close()

# --- 3. COBRO DE DEUDA (Multiuso: Admin o POS) ---
@router.put("/pagar_deuda/{cliente_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def registrar_pago_deuda(cliente_id: int, pago: PagoDeuda):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        fecha_actual = datetime.now(ZONA_AR).strftime("%Y-%m-%d %H:%M:%S")
        
        # 1. Le descontamos la deuda al cliente
        cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor - ? WHERE id = ?", (pago.monto_pago, cliente_id))

        # 2. Dejamos el registro en su historial
        origen = "Caja/Mostrador" if pago.afecta_caja else "Administración"
        cursor.execute('''
            INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
            VALUES (?, ?, 'PAGO', ?, ?, ?)
        ''', (cliente_id, fecha_actual, pago.monto_pago, f"Pago en {origen} ({pago.metodo_pago})", pago.usuario_id))
        
        # 3. EL SWITCH: Si afecta caja y es en efectivo, recién ahí inflamos el cajón del turno
        if pago.afecta_caja and pago.metodo_pago.upper() == "EFECTIVO":
            turno_id = pago.turno_id
            if not turno_id:
                cursor.execute(
                    "SELECT id FROM turnos_caja WHERE estado_turno = 'ABIERTO' ORDER BY id DESC LIMIT 1"
                )
                turno = cursor.fetchone()
                turno_id = turno[0] if turno else None
            if turno_id:
                cursor.execute('''
                    INSERT INTO movimientos_caja (fecha_hora, usuario_id, tipo_movimiento, monto, observaciones, turno_id)
                    VALUES (?, ?, 'INGRESO', ?, ?, ?)
                ''', (fecha_actual, pago.usuario_id, pago.monto_pago, f"Cobro Deuda Cliente ID: {cliente_id}", turno_id))

        conexion.commit()
        return {"mensaje": "Pago procesado correctamente."}
    except Exception as e:
        if conexion:
            conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        # 2. Si es un error de negocio tuyo, lo mostramos normal
        return {"error": mensaje_error}
    finally:
        conexion.close()

# --- 4. HISTORIAL (La Película Completa) ---
@router.get("/historial/{cliente_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def ver_historial_cliente(cliente_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        cursor.execute('''
            SELECT id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id 
            FROM movimientos_clientes 
            WHERE cliente_id = ? 
            ORDER BY fecha_hora DESC, id DESC
        ''', (cliente_id,))
        movimientos = [dict(m) for m in cursor.fetchall()]
        return {"movimientos": movimientos}
    except Exception as e:
        if conexion:
            conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        # 2. Si es un error de negocio tuyo, lo mostramos normal
        return {"error": mensaje_error}
    finally:
        conexion.close()
        
        # --- 5. RECARGOS Y AJUSTES POR INFLACIÓN ---
class AjusteDeuda(BaseModel):
    monto: float
    motivo: str
    usuario_id: int = 1

@router.put("/aplicar_recargo/{cliente_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def aplicar_recargo(cliente_id: int, ajuste: AjusteDeuda):
    conexion = obtener_conexion()
    cursor = conexion.cursor()
    try:
        fecha_actual = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # 1. Sumamos la deuda
        cursor.execute("UPDATE clientes SET saldo_actual_deudor = saldo_actual_deudor + ? WHERE id = ?", (ajuste.monto, cliente_id))
        
        # 2. Registramos el movimiento
        cursor.execute('''
            INSERT INTO movimientos_clientes (cliente_id, fecha_hora, tipo_movimiento, monto, detalle, usuario_id)
            VALUES (?, ?, 'RECARGO', ?, ?, ?)
        ''', (cliente_id, fecha_actual, ajuste.monto, ajuste.motivo, ajuste.usuario_id))
        
        conexion.commit()
        return {"mensaje": "Recargo aplicado correctamente."}
    except Exception as e:
        if conexion:
            conexion.rollback() # <-- "Ctrl + Z" por si quedó algo a medio guardar
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 ERROR CRÍTICO SQL: {mensaje_error}")
            return {"error": "Ocurrió un error interno al procesar la solicitud."}
            
        # 2. Si es un error de negocio tuyo, lo mostramos normal
        return {"error": mensaje_error}
    finally:
        conexion.close()

@router.get("/simular_actualizacion/{cliente_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO"]))])
def simular_actualizacion_precios(cliente_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    try:
        # 1. Vemos cuánta plata debe hoy
        cursor.execute("SELECT saldo_actual_deudor FROM clientes WHERE id = ?", (cliente_id,))
        cliente = cursor.fetchone()
        if not cliente or cliente['saldo_actual_deudor'] <= 0:
            return {"error": "El cliente no tiene deuda para actualizar."}
            
        deuda_actual = cliente['saldo_actual_deudor']
        
        # 2. Buscamos los últimos tickets fiados hasta cubrir el monto de la deuda
        cursor.execute("SELECT detalle, monto FROM movimientos_clientes WHERE cliente_id = ? AND tipo_movimiento = 'CARGO' ORDER BY fecha_hora DESC", (cliente_id,))
        cargos = cursor.fetchall()
        
        deuda_restante = deuda_actual
        tickets_a_revisar = []
        for cargo in cargos:
            if deuda_restante <= 0: break
            if "Ticket POS #" in cargo['detalle']:
                try:
                    ticket_id = int(cargo['detalle'].split('#')[1])
                    tickets_a_revisar.append(ticket_id)
                except: pass
            deuda_restante -= cargo['monto']

        # 3. Viajamos al pasado, leemos qué llevó, y le ponemos el precio del futuro (hoy)
        valor_historico_total = 0
        nuevo_valor_total = 0
        
        for t_id in tickets_a_revisar:
            cursor.execute('''
                SELECT vd.cantidad, vd.precio_unitario_historico, p.precio_venta_final
                FROM ventas_detalle vd
                JOIN productos p ON vd.producto_id = p.id
                WHERE vd.venta_id = ?
            ''', (t_id,))
            items = cursor.fetchall()
            for item in items:
                valor_historico_total += (item['cantidad'] * item['precio_unitario_historico'])
                nuevo_valor_total += (item['cantidad'] * item['precio_venta_final'])
                
        diferencia = nuevo_valor_total - valor_historico_total
        
        # Ajustamos proporcionalmente por si ya pagó una parte de esos tickets
        if valor_historico_total > 0:
            porcentaje_impago = deuda_actual / valor_historico_total
            if porcentaje_impago > 1: porcentaje_impago = 1.0
            diferencia_real = diferencia * porcentaje_impago
        else:
            diferencia_real = 0

        return {
            "deuda_vieja": deuda_actual,
            "diferencia": round(diferencia_real, 2),
            "deuda_nueva": round(deuda_actual + diferencia_real, 2)
        }
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 Error en simulación de actualización de precios 🚨: {mensaje_error}")
            return {"error": "Error interno. Contacte al soporte técnico"}
            
        return {"error": mensaje_error}
    finally:
        conexion.close()
        
@router.get("/resumen_pendientes/{cliente_id}", dependencies=[Depends(VerificarRol(["ADMIN", "ENCARGADO", "CAJERO"]))])
def resumen_pendientes(cliente_id: int):
    conexion = obtener_conexion()
    conexion.row_factory = sqlite3.Row
    cursor = conexion.cursor()
    
    try:
        # 1. Buscamos al cliente y vemos cuánta plata debe
        cursor.execute("SELECT saldo_actual_deudor FROM clientes WHERE id = ?", (cliente_id,))
        cliente = cursor.fetchone()
        
        if not cliente or cliente['saldo_actual_deudor'] <= 0:
            return {"error": False, "articulos": [], "saldo_total": 0}
            
        deuda_restante = cliente['saldo_actual_deudor']
        
        # 2. Buscamos sus compras fiadas, de la MÁS NUEVA a la MÁS VIEJA
        cursor.execute('''
            SELECT id, total_venta 
            FROM ventas_cabecera 
            WHERE cliente_id = ? 
            AND UPPER(metodo_pago) IN ('CUENTA CORRIENTE', 'FIADO') 
            AND estado != 'ANULADA'
            ORDER BY fecha_hora DESC
        ''', (cliente_id,))
        ventas_fiadas = cursor.fetchall()
        
        articulos_agrupados = {}
        
        # 3. Recorremos los tickets de atrás para adelante
        for venta in ventas_fiadas:
            if deuda_restante <= 0:
                break # Si ya cubrimos la plata que debe, dejamos de buscar
                
            deuda_restante -= venta['total_venta']
            
            # Traemos los productos de este ticket (cruzando con la tabla productos)
            cursor.execute('''
                SELECT vd.cantidad, vd.subtotal, p.nombre, p.unidad_medida 
                FROM ventas_detalle vd
                LEFT JOIN productos p ON vd.producto_id = p.id
                WHERE vd.venta_id = ?
            ''', (venta['id'],))
            
            detalles = cursor.fetchall()
            
            for item in detalles:
                nombre_prod = item['nombre'] or "Artículo"
                unidad_prod = item['unidad_medida'] or "un"
                
                if nombre_prod in articulos_agrupados:
                    articulos_agrupados[nombre_prod]['cantidad'] += item['cantidad']
                    articulos_agrupados[nombre_prod]['subtotal'] += item['subtotal']
                else:
                    articulos_agrupados[nombre_prod] = {
                        "cantidad": item['cantidad'],
                        "unidad": unidad_prod,
                        "subtotal": item['subtotal']
                    }
                    
        # 4. Formateamos la lista final para el frontend
        lista_final = []
        for nombre, datos in articulos_agrupados.items():
            lista_final.append({
                "nombre": nombre,
                "cantidad": datos["cantidad"],
                "unidad": datos["unidad"],
                "subtotal": datos["subtotal"]
            })
            
        return {"error": False, "articulos": lista_final, "saldo_total": cliente['saldo_actual_deudor']}
        
    except Exception as e:
        if conexion:
            conexion.close()
            
        mensaje_error = str(e)
        # 1. Si es un error feo de base de datos, pared ciega al navegador y log en tu consola
        if "sqlite3" in str(type(e)).lower() or "syntax" in mensaje_error.lower():
            print(f"🚨 No se pudo obtener el resumen del cliente {cliente_id} 🚨: {mensaje_error}")
            return {"error": "Error interno. Contacte al soporte técnico."}
            
        return {"error": mensaje_error}
    finally:
        conexion.close()