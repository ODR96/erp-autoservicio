import sqlite3

conexion = obtener_conexion()
cursor = conexion.cursor()
try:
    # Inyectamos el producto "Varios" genérico
    cursor.execute('''
        INSERT INTO productos (id, codigo_barras, nombre, categoria_id, tipo_venta, costo_sin_iva, porcentaje_iva, precio_venta_final, stock_minimo_alerta, activo)
        VALUES (999, 'VARIOS', 'Artículo Varios', 1, 'Unidad', 0, 0, 0, 0, 1)
    ''')
    # Le creamos un lote con stock "infinito" para que no corte la venta
    cursor.execute('''
        INSERT INTO lotes_stock (producto_id, numero_lote_proveedor, fecha_ingreso, fecha_vencimiento, cantidad_inicial, cantidad_disponible, costo_real_ingreso, estado_lote)
        VALUES (999, 'GENERICO', '2026-01-01', '2099-12-31', 999999, 999999, 0, 'Activo')
    ''')
    conexion.commit()
    print("¡Producto Varios (Precio Manual) habilitado con éxito!")
except Exception as e:
    print("El producto ya existía o hubo un error:", e)
finally:
    conexion.close()