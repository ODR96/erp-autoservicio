import sqlite3
from passlib.context import CryptContext

# 1. CONFIGURACIÓN DE SEGURIDAD PERSONALIZADA
print("--- CONFIGURACIÓN DE ACCESO INICIAL ---")
usuario_nombre = input("Ingresá tu nombre (ej: Orlando): ")
credencial_admin = input("Elegí tu código de barras para entrar (ej: 202604): ")
pin_admin = input("Elegí tu PIN de 4 números (ej: 8855): ")

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
pin_encriptado = pwd_context.hash(pin_admin)

print("\nConstruyendo el sistema para 'Autoservicio 20 de Junio'...")

conexion = obtener_conexion()
cursor = conexion.cursor()

# --- MÓDULO 1: PRODUCTOS, STOCK Y CARTELERÍA ---
cursor.execute('''CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_barras TEXT,
    nombre TEXT NOT NULL,
    categoria_id INTEGER,
    tipo_venta TEXT,
    costo_sin_iva REAL,
    porcentaje_iva REAL DEFAULT 21.0,
    precio_venta_final REAL NOT NULL,
    stock_minimo_alerta REAL,
    dias_alerta_vencimiento INTEGER DEFAULT 0,
    unidad_medida TEXT DEFAULT 'Unidad',
    proveedor_habitual_id INTEGER,
    stock_comprometido REAL DEFAULT 0,
    activo INTEGER DEFAULT 1
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS categorias_productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    descripcion TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS categorias_pos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    palabra_clave TEXT,
    icono TEXT DEFAULT 'bi-box',
    color_fondo TEXT DEFAULT '#ffffff'
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS productos_combos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_padre_id INTEGER,
    producto_hijo_id INTEGER,
    cantidad_hijo REAL
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS lotes_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER,
    numero_lote_proveedor TEXT,
    fecha_ingreso DATE,
    fecha_vencimiento DATE,
    cantidad_inicial REAL,
    cantidad_disponible REAL,
    costo_real_ingreso REAL,
    estado_lote TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS promociones_volumen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER,
    cantidad_minima REAL,
    precio_oferta_unitario REAL
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS cola_impresion_etiquetas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER,
    tipo_cartel TEXT,
    cantidad_copias INTEGER,
    texto_personalizado TEXT,
    precio_falso REAL,
    impreso BOOLEAN DEFAULT 0
)''')

# --- MÓDULO 2: CLIENTES Y VENTAS ---
cursor.execute('''CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_completo TEXT NOT NULL,
    cuit TEXT,
    condicion_iva TEXT,
    telefono_whatsapp TEXT,
    limite_credito REAL,
    saldo_actual_deudor REAL DEFAULT 0
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS ventas_cabecera (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_hora DATETIME,
    usuario_id INTEGER,
    cliente_id INTEGER,
    tipo_comprobante TEXT,
    nombre_cliente_factura TEXT,
    documento_cliente TEXT,
    condicion_iva_cliente TEXT,
    total_venta REAL,
    metodo_pago TEXT,
    descuento_recargo_global REAL,
    estado TEXT,
    autorizado_por INTEGER
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS ventas_detalle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id INTEGER,
    producto_id INTEGER,
    descripcion_historica TEXT,
    cantidad REAL,
    precio_unitario_historico REAL,
    subtotal REAL
)''')

# --- MÓDULO 3: COMPRAS Y PROVEEDORES ---
cursor.execute('''CREATE TABLE IF NOT EXISTS proveedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_comercial TEXT NOT NULL,
    cuit TEXT,
    telefono_vendedor TEXT,
    activo INTEGER DEFAULT 1
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS compras_cabecera (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor_id INTEGER,
    numero_factura TEXT,
    fecha_compra DATE,
    total_factura REAL,
    condicion_pago TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS compras_detalle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compra_id INTEGER,
    producto_id INTEGER,
    descripcion_historica TEXT,
    cantidad_comprada REAL,
    costo_unitario REAL,
    fecha_vencimiento DATE,
    numero_lote_proveedor TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS proveedores_ctacte (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor_id INTEGER,
    saldo_deudor REAL DEFAULT 0
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS pagos_proveedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proveedor_id INTEGER,
    fecha_pago DATETIME,
    monto_total_pagado REAL,
    metodo_pago TEXT,
    observaciones TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS cheques_emitidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pago_proveedor_id INTEGER,
    numero_cheque TEXT,
    banco TEXT,
    fecha_emision DATE,
    fecha_cobro DATE,
    monto REAL,
    estado TEXT
)''')

# --- MÓDULO 4: CAJA Y GASTOS ---
cursor.execute('''CREATE TABLE IF NOT EXISTS cajas_fisicas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    estado TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS turnos_caja (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caja_id INTEGER,
    usuario_id INTEGER,
    fecha_hora_apertura DATETIME,
    monto_inicial REAL,
    fecha_hora_cierre DATETIME,
    monto_final_sistema REAL,
    monto_final_declarado REAL,
    diferencia REAL,
    estado_turno TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS movimientos_caja (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_hora DATETIME,
    usuario_id INTEGER,
    tipo_movimiento TEXT,
    monto REAL,
    observaciones TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS categorias_gasto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS gastos_operativos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha DATETIME,
    categoria_id INTEGER,
    descripcion_detalle TEXT,
    monto REAL,
    metodo_pago TEXT
)''')

# --- MÓDULO 5: CONFIGURACIÓN, SEGURIDAD Y AUDITORÍA ---
cursor.execute('''CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_completo TEXT NOT NULL,
    rol TEXT NOT NULL,
    codigo_barras_credencial TEXT UNIQUE,
    pin_secreto TEXT,
    estado TEXT DEFAULT 'ACTIVO'
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS configuracion_negocio (
    id INTEGER PRIMARY KEY,
    nombre_comercial TEXT,
    razon_social TEXT,
    cuit_negocio TEXT,
    direccion TEXT,
    telefono TEXT,
    mensaje_pie_ticket TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS movimientos_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
    producto_id INTEGER,
    lote_id INTEGER,
    cantidad REAL,
    tipo_movimiento TEXT, 
    motivo TEXT,
    usuario_id INTEGER
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS registro_mermas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
    producto_id INTEGER,
    lote_id INTEGER,
    cantidad REAL,
    motivo TEXT,
    costo_perdido REAL,
    usuario_id INTEGER,
    observaciones TEXT
)''')

cursor.execute('''CREATE TABLE IF NOT EXISTS productos_solicitados_faltantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
    descripcion_producto TEXT,
    cantidad_pedida REAL,
    notas TEXT
)''')

# ========================================================
# INSERCIÓN DE DATOS INICIALES (LA MAGIA DE LOS PARCHES)
# ========================================================

# 1. Crear tu usuario Administrador
cursor.execute('''
    INSERT OR IGNORE INTO usuarios (id, nombre_completo, rol, codigo_barras_credencial, pin_secreto)
    VALUES (1, ?, 'ADMIN', ?, ?)
''', (usuario_nombre, credencial_admin, pin_encriptado))

# 2. Insertar caja por defecto
cursor.execute("INSERT OR IGNORE INTO cajas_fisicas (id, nombre, estado) VALUES (1, 'Caja Mostrador Principal', 'CERRADA')")

# 3. Insertar las 8 categorías de botones del POS
categorias_base = [
    (1, 'Bebidas', 'coca', 'bi-cup-straw', '#90caf9'),
    (2, 'Almacén', 'pan', 'bi-shop', '#a5d6a7'),
    (3, 'Lácteos', 'queso', 'bi-egg', '#fff59d'),
    (4, 'Limpieza', 'lavandina', 'bi-droplet', '#f48fb1'),
    (5, 'Panadería', 'panaderia', 'bi-baguette', '#ffcc80'),
    (6, 'Verdulería', 'fruta', 'bi-apple', '#c5e1a5'),
    (7, 'Fiambrería', 'fiambre', 'bi-pie-chart', '#ffe082'),
    (8, 'Carnes', 'carne', 'bi-piggy-bank', '#ef9a9a')
]
cursor.executemany("INSERT OR IGNORE INTO categorias_pos (id, nombre, palabra_clave, icono, color_fondo) VALUES (?, ?, ?, ?, ?)", categorias_base)

# 4. Insertar el Producto "VARIOS" (ID 999) y su stock infinito
cursor.execute('''
    INSERT OR IGNORE INTO productos (id, codigo_barras, nombre, categoria_id, tipo_venta, costo_sin_iva, porcentaje_iva, precio_venta_final, stock_minimo_alerta, activo)
    VALUES (999, 'VARIOS', 'Artículo Varios', 1, 'Unidad', 0, 0, 0, 0, 1)
''')
cursor.execute('''
    INSERT OR IGNORE INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
    VALUES (999, 'GENERICO', '2026-04-14', '2099-12-31', 999999, 999999, 0, 'Activo')
''')

conexion.commit()
conexion.close()
print("\n¡ÉXITO TOTAL! Base de datos construida al 100%. Mermas, pedidos y seguridad instalados.")