// frontend/js/app_proveedores.js
// --- EL INTERCEPTOR DE SEGURIDAD ---
// --- INTERCEPTOR DE SEGURIDAD GLOBAL ---
// --- INTERCEPTOR DE SEGURIDAD GLOBAL ---
const originalFetch = window.fetch;
window.fetch = async function() {
    let [recurso, config] = arguments;
    if (!config) config = {};
    if (!config.headers) config.headers = {};
    
    // 1. Verificamos si la petición va a TU servidor
    const vaAMiServidor = recurso.toString().includes(obtenerBaseUrl());
    
    // 2. SOLO si va a tu servidor, le pegamos el token secreto
    if (vaAMiServidor) {
        const tokenSeguridad = localStorage.getItem('token') || localStorage.getItem('token_pos');
        if (tokenSeguridad) {
            config.headers['Authorization'] = `Bearer ${tokenSeguridad}`;
        }
    }
    
    const respuesta = await originalFetch(recurso, config);
    
    // 3. El blindaje: Si es nuestro servidor y nos rechaza (401)
    if (vaAMiServidor && respuesta.status === 401) {
        console.warn("Sesión expirada o sin permisos (401)");
        localStorage.clear();
        window.location.href = 'index.html'; // Pateamos al usuario al login
        throw new Error("Acceso denegado (401)");
    }
    
    return respuesta;
};
// ---------------------------------------
// ---------------------------------------


let proveedoresGlobales = [];
let facturaActualItems = [];
let provSeleccionadoParaPago = null;

// ==========================================
// 1. GESTIÓN DE PROVEEDORES (ABM COMPLETO)
// ==========================================
async function cargarProveedores() {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/listado`);
        const data = await res.json();
        
        proveedoresGlobales = Array.isArray(data) ? data : (data.proveedores || []);
        
        dibujarTablaDirectorio(proveedoresGlobales);
        llenarSelectoresProveedores();
        dibujarListaCtaCte();
    } catch (e) {
        console.error("Error cargando proveedores:", e);
    }
}

// Buscador dinámico de la tabla
document.getElementById('inputBuscarProv')?.addEventListener('input', function() {
    const busqueda = this.value.toLowerCase();
    const filtrados = proveedoresGlobales.filter(p => 
        p.nombre_comercial.toLowerCase().includes(busqueda) || 
        (p.cuit && p.cuit.includes(busqueda))
    );
    dibujarTablaDirectorio(filtrados);
});

function dibujarTablaDirectorio(lista) {
    const tbody = document.getElementById('tablaProveedoresBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (lista.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-muted py-4">No hay proveedores registrados.</td></tr>';
        return;
    }

    lista.forEach(p => {
        const esActivo = p.activo !== 0;
        const claseFila = esActivo ? '' : 'opacity-50 bg-light';
        const saldo = p.saldo_deudor || 0;

        // LA MAGIA: El botoncito de la nota (Si es que tiene una)
        let iconoNota = '';
        if (p.observaciones && p.observaciones.trim() !== "") {
            let notaLimpia = p.observaciones.replace(/"/g, "'"); 
            iconoNota = `<i class="bi bi-info-circle-fill text-primary ms-2" data-bs-toggle="tooltip" data-bs-placement="top" title="${notaLimpia}" style="cursor:help; font-size: 1.1rem;"></i>`;
        }

        let botones = esActivo 
            ? `<button class="btn btn-sm btn-outline-info py-0 me-1" title="Ver Historial" onclick="verHistorialProveedor(${p.id}, '${p.nombre_comercial}')"><i class="bi bi-clock-history"></i></button>
            <button class="btn btn-sm btn-outline-primary py-0" onclick="abrirEditarProveedor(${p.id})"><i class="bi bi-pencil"></i></button>
               <button class="btn btn-sm btn-outline-danger py-0 ms-1" onclick="darDeBajaProveedor(${p.id}, '${p.nombre_comercial}')"><i class="bi bi-trash"></i></button>`
            : `<button class="btn btn-sm btn-success py-0 fw-bold" onclick="reactivarProveedor(${p.id})"><i class="bi bi-arrow-counterclockwise"></i> Restaurar</button>`;

        tbody.innerHTML += `
            <tr class="${claseFila}">
                <td class="text-muted fw-bold align-middle">#${p.id}</td>
                <td class="fw-bold text-start align-middle">${p.nombre_comercial} ${iconoNota} ${!esActivo ? '<span class="badge bg-secondary ms-2">INACTIVO</span>' : ''}</td>
                <td class="align-middle">${p.cuit || '-'}</td>
                <td class="align-middle"><i class="bi bi-whatsapp text-success"></i> ${p.telefono_vendedor || '-'}</td>
                <td class="fw-bold align-middle ${saldo > 0 ? 'text-danger' : 'text-success'}">$ ${saldo.toFixed(2)}</td>
                <td class="align-middle">${botones}</td>
            </tr>`;
    });

    // Encendemos los "Cartelitos Flotantes" de Bootstrap para las notas
    const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
    [...tooltipTriggerList].map(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl));
}

function abrirModalProveedor() {
    document.getElementById('provId').value = "";
    document.getElementById('provNombre').value = "";
    document.getElementById('provCuit').value = "";
    document.getElementById('provTel').value = "";
    document.getElementById('provObs').value = ""; // Vaciamos
    document.getElementById('tituloModalProv').innerHTML = '<i class="bi bi-building-add"></i> Nuevo Proveedor';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProveedor')).show();
}

function abrirEditarProveedor(id) {
    const p = proveedoresGlobales.find(x => x.id === id);
    if (!p) return;
    document.getElementById('provId').value = p.id;
    document.getElementById('provNombre').value = p.nombre_comercial;
    document.getElementById('provCuit').value = p.cuit || "";
    document.getElementById('provTel').value = p.telefono_vendedor || "";
    document.getElementById('provObs').value = p.observaciones || ""; // Llenamos
    document.getElementById('tituloModalProv').innerHTML = '<i class="bi bi-pencil"></i> Editar Proveedor';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProveedor')).show();
}

// Soporte Enter en Modal
document.getElementById('modalProveedor')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') guardarProveedor();
});

async function guardarProveedor() {
    const id = document.getElementById('provId').value;
    const payload = {
        nombre_comercial: document.getElementById('provNombre').value.trim(),
        cuit: document.getElementById('provCuit').value.trim(),
        telefono_vendedor: document.getElementById('provTel').value.trim(),
        observaciones: document.getElementById('provObs').value.trim() // ENVIAMOS LA NOTA
    };

    if (!payload.nombre_comercial) return Swal.fire('Error', 'El nombre comercial es obligatorio', 'warning');

    const url = id ? `${obtenerBaseUrl()}/proveedores/actualizar/${id}` : `${obtenerBaseUrl()}/proveedores/alta`;
    const metodo = id ? 'PUT' : 'POST';

    try {
        await fetch(url, { method: metodo, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
        bootstrap.Modal.getInstance(document.getElementById('modalProveedor')).hide();
        cargarProveedores();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Guardado correctamente', showConfirmButton: false, timer: 1500 });
    } catch (e) { Swal.fire('Error', 'No se pudo guardar', 'error'); }
}

async function darDeBajaProveedor(id, nombre) {
    const res = await Swal.fire({ title: `¿Dar de baja a ${nombre}?`, text: "No podrás cargarle más facturas hasta restaurarlo.", icon: 'warning', showCancelButton: true, confirmButtonColor: '#d33', confirmButtonText: 'Sí, desactivar' });
    if (res.isConfirmed) {
        await fetch(`${obtenerBaseUrl()}/proveedores/baja/${id}`, { method: 'DELETE' });
        cargarProveedores();
    }
}

async function reactivarProveedor(id) {
    await fetch(`${obtenerBaseUrl()}/proveedores/reactivar/${id}`, { method: 'PUT' });
    cargarProveedores();
}

function llenarSelectoresProveedores() {
    const selIngreso = document.getElementById('selectProvIngreso');
    if (selIngreso) {
        selIngreso.innerHTML = '<option value="">-- Seleccionar Proveedor --</option>';
        proveedoresGlobales.filter(p => p.activo !== 0).forEach(p => {
            selIngreso.innerHTML += `<option value="${p.id}">${p.nombre_comercial}</option>`;
        });
    }
}

// ==========================================
// ==========================================
// 2. INGRESO DE FACTURAS (BUSCADOR BLINDADO)
// ==========================================
document.getElementById('inputScanCompra')?.addEventListener('keypress', async function (e) {
    if (e.key === 'Enter') {
        e.preventDefault(); // Evitamos que el Enter intente enviar un formulario fantasma
        const query = this.value.trim();
        
        // Bajamos el límite a > 0 por si buscás IDs muy cortos
        if (query.length > 0) {
            Swal.fire({ title: 'Buscando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            await buscarParaCompra(query);
        }
        this.value = '';
    }
});

async function buscarParaCompra(query) {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/buscar?termino=${encodeURIComponent(query)}`);
        const data = await res.json(); 

        // PARCHE A PRUEBA DE BALAS: Atajamos el dato venga como venga
        const productos = Array.isArray(data) ? data : (data.productos || []);

        if (productos.length === 0) {
            Swal.fire('No encontrado', 'El producto no existe en el catálogo. Cargalo primero en Stock.', 'warning');
            return;
        }

        if (productos.length === 1) {
            Swal.close();
            pedirDatosIngresoItem(productos[0]);
        } else {
            let htmlOpciones = '<div class="list-group text-start mt-2" style="max-height: 250px; overflow-y: auto;">';
            productos.forEach(p => {
                let prodObj = encodeURIComponent(JSON.stringify(p));
                htmlOpciones += `<button type="button" class="list-group-item list-group-item-action py-2" onclick="seleccionarOpcionCompra('${prodObj}')">
                    <i class="bi bi-box"></i> <b>${p.codigo_barras || 'S/C'}</b> - ${p.nombre} <span class="float-end text-muted">Costo: $${p.costo_sin_iva}</span>
                </button>`;
            });
            htmlOpciones += '</div>';

            Swal.fire({ title: 'Seleccione un producto', html: htmlOpciones, showConfirmButton: false, showCloseButton: true });
        }
    } catch (e) { 
        console.error(e); 
        Swal.fire('Error', 'Fallo de conexión al buscar.', 'error');
    }
}

window.seleccionarOpcionCompra = function(prodObjString) {
    Swal.close();
    let prod = JSON.parse(decodeURIComponent(prodObjString));
    pedirDatosIngresoItem(prod);
}

async function pedirDatosIngresoItem(producto) {
    const margenActual = ((producto.precio_venta_final / (producto.costo_sin_iva || 1)) - 1) * 100;
    
    // PARCHE: Aseguramos que el IVA sea un número válido
    const iva = (producto.porcentaje_iva !== undefined && producto.porcentaje_iva !== null) ? producto.porcentaje_iva : 21; 
    const precioSugeridoInicial = (producto.costo_sin_iva * (1 + iva/100) * (1 + margenActual/100)).toFixed(2);

    const { value: formValues } = await Swal.fire({
        title: `<h4 class="text-primary fw-bold mb-0"><i class="bi bi-box-seam"></i> ${producto.nombre}</h4>`,
        html: `
            <div class="text-start mt-3" style="overflow-x: hidden;">
                
                <div class="row g-2 mb-3">
                    <div class="col-6">
                        <label class="small fw-bold text-muted mb-1">Cant. Recibida:</label>
                        <input id="swal-cant" type="number" class="form-control form-control-lg text-center fw-bold border-secondary" value="1" min="0.1" step="0.1">
                    </div>
                    <div class="col-6">
                        <label class="small fw-bold text-muted mb-1">Vencimiento (Opcional):</label>
                        <input id="swal-venc" type="date" class="form-control form-control-lg text-center text-muted">
                    </div>
                </div>

                <div class="p-3 bg-light border rounded mb-3 shadow-sm">
                    <label class="small fw-bold text-primary mb-1">Costo Unitario Neto (Sin IVA):</label>
                    <div class="input-group mb-2">
                        <span class="input-group-text bg-primary text-white fw-bold">$</span>
                        <input id="swal-costo" type="number" class="form-control fw-bold border-primary text-end fs-5" value="${producto.costo_sin_iva || 0}" step="0.01"
                            oninput="document.getElementById('lbl-sugerido').innerText = '$' + (this.value * (1 + ${iva}/100) * (1 + ${margenActual}/100)).toFixed(2)">
                    </div>
                    <div class="d-flex justify-content-between small">
                        <span class="text-muted">Margen Config.: <b>${margenActual.toFixed(1)}%</b></span>
                        <span class="text-muted">Sugerido Venta: <b id="lbl-sugerido" class="text-primary">$${precioSugeridoInicial}</b></span>
                    </div>
                </div>

                <label class="small fw-bold text-success mb-1">Precio Público Actual (Góndola):</label>
                <div class="input-group input-group-lg shadow-sm">
                    <span class="input-group-text bg-success text-white fw-bold">$</span>
                    <input id="swal-precio" type="number" class="form-control border-success text-success fw-bold text-end" value="${producto.precio_venta_final}" step="0.01">
                </div>

            </div>
        `,
        width: '450px',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: '<i class="bi bi-plus-circle"></i> Agregar a Factura',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#0d6efd',
        cancelButtonColor: '#6c757d',
        preConfirm: () => {
            return {
                cant: parseFloat(document.getElementById('swal-cant').value),
                costo: parseFloat(document.getElementById('swal-costo').value),
                venc: document.getElementById('swal-venc').value || "2099-12-31",
                precioNuevo: parseFloat(document.getElementById('swal-precio').value)
            }
        }
    });

    if (formValues && formValues.cant > 0) {
        facturaActualItems.push({
            producto_id: producto.id,
            nombre: producto.nombre,
            cantidad_comprada: formValues.cant,
            costo_unitario: formValues.costo,
            fecha_vencimiento: formValues.venc,
            nuevo_precio_venta: formValues.precioNuevo,
            numero_lote_proveedor: "LOTE-" + new Date().getTime().toString().slice(-4)
        });
        dibujarTablaFactura();
    }
}

function dibujarTablaFactura() {
    const tbody = document.getElementById('tablaIngresoBody');
    tbody.innerHTML = '';
    let total = 0;

    if (facturaActualItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-muted py-4">La factura está vacía. Escanee productos.</td></tr>';
        document.getElementById('totalFacturaVista').innerText = '$ 0.00';
        return;
    }

    facturaActualItems.forEach((item, idx) => {
        let subtotal = item.cantidad_comprada * item.costo_unitario;
        total += subtotal;
        let vencVisual = item.fecha_vencimiento === "2099-12-31" ? "Sin Venc." : item.fecha_vencimiento;

        tbody.innerHTML += `
            <tr>
                <td class="fw-bold">${item.cantidad_comprada}</td>
                <td class="text-start fw-bold">${item.nombre} <br><small class="text-success fw-normal">Actualiza a $${item.nuevo_precio_venta.toFixed(2)}</small></td>
                <td class="small text-muted">${vencVisual}</td>
                <td>$${item.costo_unitario.toFixed(2)}</td>
                <td class="fw-bold">$${subtotal.toFixed(2)}</td>
                <td><button class="btn btn-sm text-danger border-0" onclick="facturaActualItems.splice(${idx}, 1); dibujarTablaFactura();"><i class="bi bi-trash"></i></button></td>
            </tr>
        `;
    });

actualizarTotalVista();
}

function limpiarFactura() {
    facturaActualItems = [];
    document.getElementById('inputNumFactura').value = '';
    dibujarTablaFactura();
}

async function confirmarIngresoMercaderia() {
    const provId = document.getElementById('selectProvIngreso').value;
    const numFactura = document.getElementById('inputNumFactura').value.trim() || `INT-${new Date().getTime()}`;
    const condicion = document.getElementById('selectCondicionPago').value;

    if (!provId) return Swal.fire('Error', 'Debe seleccionar un proveedor.', 'warning');
    if (facturaActualItems.length === 0) return Swal.fire('Error', 'No hay productos en la factura.', 'warning');

    Swal.fire({ title: 'Procesando ingreso...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    const btnGuardar = document.querySelector('button[onclick="confirmarIngresoMercaderia()"]');
    if (btnGuardar) {
        btnGuardar.disabled = true;
        btnGuardar.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Guardando...';
    }

    try {
        const cargosExtraIngresados = parseFloat(document.getElementById('inputCargosExtra').value) || 0;

        const payload = {
            proveedor_id: parseInt(provId),
            numero_factura: numFactura,
            condicion_pago: condicion,
            cargos_extra: cargosExtraIngresados, // <--- ACÁ VIAJA EL DATO A PYTHON
            items: facturaActualItems
        };

        const res = await fetch(`${obtenerBaseUrl()}/proveedores/cargar_factura, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }`);

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        Swal.fire('¡Mercadería Ingresada!', 'El stock, los costos y la deuda se actualizaron correctamente.', 'success');
        limpiarFactura();
        cargarProveedores(); // Recarga saldos de cuenta corriente
    } catch (e) {
        Swal.fire('Error al ingresar', e.message, 'error');
    }
    finally {
        // 2. PASE LO QUE PASE (éxito o error), DEVOLVEMOS EL BOTÓN A LA NORMALIDAD
        if (btnGuardar) {
            btnGuardar.disabled = false;
            btnGuardar.innerHTML = '<i class="bi bi-check2-all"></i> GUARDAR INGRESO';
        }
    }
}

// ==========================================
// SELECCIONAR PROVEEDOR PARA PAGAR DEUDA
// ==========================================
function seleccionarProvParaPago(id, nombre, deuda) {
    provSeleccionadoParaPago = id;
    
    const panel = document.getElementById('panelPagoProv');
    const msjFantasma = document.getElementById('mensajeSeleccionProv'); // <-- Atrapamos el cartel gigante

    if (panel) panel.classList.remove('d-none');
    if (msjFantasma) msjFantasma.classList.add('d-none'); // <-- Le decimos que se esconda

    document.getElementById('nombreProvDeuda').innerText = nombre;
    document.getElementById('montoProvDeuda').innerText = '$ ' + parseFloat(deuda).toFixed(2);
    document.getElementById('montoPagoProv').value = '';
    document.getElementById('obsPagoProv').value = '';
    document.getElementById('metodoPagoProv').value = 'EFECTIVO CAJA';
    
    if (typeof toggleCamposCheque === 'function') {
        toggleCamposCheque(); 
    }

    if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// ==========================================
// 3. CUENTAS CORRIENTES Y PAGOS
// ==========================================
function dibujarListaCtaCte() {
    const contenedor = document.getElementById('listaDeudasProv');
    if(!contenedor) return;
    contenedor.innerHTML = '';

    proveedoresGlobales.forEach(p => {
        let saldo = p.saldo_deudor || 0;
        let colorDeuda = saldo > 0 ? 'text-danger fw-bold' : 'text-success';

        contenedor.innerHTML += `
            <button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="seleccionarProvParaPago(${p.id}, '${p.nombre_comercial}', ${saldo})">
                <span class="fw-bold">${p.nombre_comercial}</span>
                <span class="${colorDeuda}">$ ${saldo.toFixed(2)}</span>
            </button>
        `;
    });
}

async function registrarPagoProveedor() {
    const monto = parseFloat(document.getElementById('montoPagoProv').value);
    const metodo = document.getElementById('metodoPagoProv').value;
    const obs = document.getElementById('obsPagoProv').value;

    if (!monto || monto <= 0) return Swal.fire('Error', 'Ingrese un monto válido', 'warning');

    const payload = {
        proveedor_id: provSeleccionadoParaPago,
        monto_pagado: monto,
        metodo_pago: metodo,
        observaciones: obs
    };

    try {
        // LA RUTA CORRECTA ES /pagar
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/pagar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

Swal.fire('¡Éxito!', 'Pago registrado y deuda actualizada.', 'success');
        
        // Limpiamos los inputs
        document.getElementById('montoPagoProv').value = '';
        document.getElementById('obsPagoProv').value = '';
        
        // 1. EL PARCHE: Usamos "await" para esperar a que Python nos devuelva los saldos nuevos
        await cargarProveedores(); 
        
        // 2. ACTUALIZACIÓN VISUAL: Buscamos el saldo fresco y actualizamos el cartel grandote de la derecha
        const provActualizado = proveedoresGlobales.find(p => p.id === provSeleccionadoParaPago);
        if (provActualizado) {
            document.getElementById('montoProvDeuda').innerText = '$ ' + parseFloat(provActualizado.saldo_deuda || 0).toFixed(2);
        }
        
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// --- VER HISTORIAL DE PAGOS (RECIBOS) ---
async function verHistorialPagos() {
    if (!provSeleccionadoParaPago) return;
    const nombre = document.getElementById('nombreProvDeuda').innerText;

    Swal.fire({ title: 'Cargando pagos...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/historial_pagos/${provSeleccionadoParaPago}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Agregamos una columna para la impresora
        let html = '<div class="table-responsive text-start"><table class="table table-sm table-hover align-middle"><thead><tr class="table-light"><th>Fecha</th><th>Método</th><th class="text-end">Monto</th><th>Observaciones</th><th class="text-center"><i class="bi bi-printer"></i></th></tr></thead><tbody>';

        if (data.pagos.length === 0) {
            html += '<tr><td colspan="5" class="text-center text-muted py-3">No hay pagos registrados.</td></tr>';
        } else {
            data.pagos.forEach(p => {
                // Escapamos comillas para que no se rompa el botón si alguien escribe "Cheque de Juan's"
                let obsEscapada = (p.observaciones || '').replace(/'/g, "\\'");
                
                html += `<tr>
                    <td class="text-muted small">${p.fecha_pago}</td>
                    <td class="fw-bold"><span class="badge bg-secondary">${p.metodo_pago}</span></td>
                    <td class="text-end fw-bold text-success">$${p.monto.toFixed(2)}</td>
                    <td class="small">${p.observaciones || '-'}</td>
                    <td class="text-center">
                        <button class="btn btn-sm btn-outline-dark" onclick="imprimirComprobantePago('${nombre}', '${p.fecha_pago}', ${p.monto}, '${p.metodo_pago}', '${obsEscapada}')" title="Imprimir Recibo">
                            <i class="bi bi-printer"></i>
                        </button>
                    </td>
                </tr>`;
            });
        }
        html += '</tbody></table></div>';

        Swal.fire({ title: `<i class="bi bi-cash-coin text-success"></i> Pagos a: ${nombre}`, html: html, width: '750px', showCloseButton: true, showConfirmButton: false });
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el historial de pagos.', 'error');
    }
}
// --- VER HISTORIAL DE COMPRAS ---
// --- VER HISTORIAL DE COMPRAS ---
async function verHistorialProveedor(id, nombre) {
    Swal.fire({ title: 'Cargando historial...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/historial/${id}`);
        const data = await res.json();
        
        if (data.error) throw new Error(data.error);

        // EL PARCHE: Agregamos el botón de Excel acá arriba y le ponemos el ID a la tabla
        let html = `
        <div class="text-end mb-2">
            <button class="btn btn-sm btn-success fw-bold shadow-sm" onclick="exportarComprasAExcel('${nombre}')">
                <i class="bi bi-file-earmark-excel"></i> Exportar a Excel
            </button>
        </div>
        <div class="table-responsive text-start">
        <table class="table table-sm table-hover align-middle" id="tablaHistorialExcel">
        <thead><tr class="table-light"><th>Fecha</th><th>N° Factura</th><th>Condición</th><th class="text-end">Total</th></tr></thead><tbody>`;

        if (data.historial.length === 0) {
            html += '<tr><td colspan="4" class="text-center text-muted py-3">No hay compras registradas.</td></tr>';
        } else {
            data.historial.forEach(c => {
                let badge = c.condicion_pago.includes('Contado') ? 'bg-success' : 'bg-warning text-dark';
                html += `<tr>
                    <td class="text-muted small">${c.fecha_compra}</td>
                    <td class="fw-bold"><a href="#" onclick="verDetalleFactura(${c.id}, '${c.numero_factura}', ${id}, '${nombre}')" class="text-decoration-none">${c.numero_factura} <i class="bi bi-box-arrow-up-right small"></i></a></td>
                    <td><span class="badge ${badge}">${c.condicion_pago}</span></td>
                    <td class="text-end fw-bold">$${c.total_factura.toFixed(2)}</td>
                </tr>`;
            });
        }
        html += '</tbody></table></div>';

        Swal.fire({
            title: `<i class="bi bi-clock-history text-primary"></i> Historial: ${nombre}`,
            html: html,
            width: '600px',
            showCloseButton: true,
            showConfirmButton: false
        });
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el historial.', 'error');
    }
}

// --- VER EL DESGLOSE DE PRODUCTOS DE UNA FACTURA ---
// --- VER EL DESGLOSE CON NAVEGACIÓN E IMPRESIÓN ---
async function verDetalleFactura(compraId, numFactura, proveedorId, nombreProveedor) {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/factura_detalle/${compraId}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        let html = '<div id="areaImprimirFactura" class="table-responsive text-start"><table class="table table-sm table-bordered align-middle text-center"><thead><tr class="table-light"><th>Cant.</th><th class="text-start">Producto</th><th>Costo Unit.</th><th>Subtotal</th></tr></thead><tbody>';

        let subtotalProductos = 0;
        data.detalle.forEach(d => {
            subtotalProductos += d.subtotal;
            html += `<tr><td class="fw-bold">${d.cantidad_comprada}</td><td class="text-start">${d.descripcion_historica}</td><td class="text-muted">$${d.costo_unitario.toFixed(2)}</td><td class="fw-bold text-primary">$${d.subtotal.toFixed(2)}</td></tr>`;
        });
        
        html += `</tbody></table></div>`;

        // EL PARCHE MATEMÁTICO: Mostramos el desglose real abajo de la tabla
        html += `
            <div class="mt-3 p-3 bg-light border rounded text-end shadow-sm" style="font-family: sans-serif;">
                <div class="small text-muted">Subtotal Mercadería: $${subtotalProductos.toFixed(2)}</div>
                <div class="small text-danger">+ Cargos Extra (IVA/Flete/Redondeo): $${parseFloat(data.cargos_extra || 0).toFixed(2)}</div>
                <div class="border-top mt-2 pt-2 fw-bold fs-5 text-success">TOTAL FACTURADO: $${parseFloat(data.total_factura || 0).toFixed(2)}</div>
            </div>
        `;

        const resultado = await Swal.fire({
            title: `<i class="bi bi-receipt"></i> Factura: ${numFactura}`,
            html: html,
            width: '750px',
            showCloseButton: true,
            showDenyButton: true,
            showCancelButton: true,
            confirmButtonText: 'Cerrar',
            denyButtonText: '<i class="bi bi-arrow-left"></i> Volver',
            cancelButtonText: '<i class="bi bi-printer"></i> Imprimir',
            cancelButtonColor: '#198754',
            confirmButtonColor: '#3085d6'
        });

        if (resultado.isDenied) {
            verHistorialProveedor(proveedorId, nombreProveedor);
        } else if (resultado.dismiss === Swal.DismissReason.cancel) {
            // Mandamos el total_factura real a la impresora
            imprimirTicketDetalle(data.detalle, numFactura, nombreProveedor, data.total_factura);
        }
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el detalle.', 'error');
    }
}

function imprimirTicketDetalle(items, numFactura, proveedor, total) {
    const fecha = new Date().toLocaleDateString();
    let tablaHtml = '';
    items.forEach(i => {
        tablaHtml += `<tr><td>${i.cantidad_comprada}</td><td>${i.descripcion_historica}</td><td>$${i.costo_unitario.toFixed(2)}</td><td>$${i.subtotal.toFixed(2)}</td></tr>`;
    });

    const win = window.open('', '_blank');
    win.document.write(`
        <html>
        <head>
            <title>Factura ${numFactura}</title>
            <style>
                body { font-family: 'Courier New', Courier, monospace; padding: 20px; font-size: 14px; }
                .header { text-align: center; border-bottom: 2px solid #000; margin-bottom: 10px; padding-bottom: 10px; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
                .total { text-align: right; font-size: 18px; font-weight: bold; margin-top: 20px; border-top: 2px solid #000; padding-top: 10px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1 style="margin:0;">AUTOSERVICIO 20 DE JUNIO</h1>
                <p style="margin:2px;">Calle 20 de Junio - El Colorado, Formosa</p>
                <hr>
                <p><b>PROVEEDOR:</b> ${proveedor} | <b>FACTURA:</b> ${numFactura}</p>
                <p><b>FECHA DE IMPRESIÓN:</b> ${fecha}</p>
            </div>
            <table>
                <thead><tr><th>CANT.</th><th>PRODUCTO</th><th>COSTO U.</th><th>SUBTOTAL</th></tr></thead>
                <tbody>${tablaHtml}</tbody>
            </table>
            <div class="total">TOTAL: $${total.toFixed(2)}</div>
            <p style="text-align:center; margin-top:50px;">--------------------------<br>Firma Recepción</p>
            <script>setTimeout(() => { window.print(); window.close(); }, 500);</script>
        </body>
        </html>
    `);
    win.document.close();
}

// Agregá esto en app_proveedores.js
function actualizarTotalVista() {
    if (!facturaActualItems) return; // Si no hay array, cortamos acá
    
    // 1. Sumamos los productos
    let subtotalProductos = facturaActualItems.reduce((acc, item) => acc + (item.cantidad_comprada * item.costo_unitario), 0);
    
    // 2. Buscamos el casillero de forma SEGURA
    let inputExtra = document.getElementById('inputCargosExtra');
    let cargosExtra = 0;
    
    if (inputExtra && inputExtra.value) {
        cargosExtra = parseFloat(inputExtra.value) || 0;
    }
    
    // 3. Calculamos y dibujamos (siempre que estemos en la pestaña correcta)
    let totalReal = subtotalProductos + cargosExtra;
    let vistaTotal = document.getElementById('totalFacturaVista');
    
    if (vistaTotal) {
        vistaTotal.innerText = '$ ' + totalReal.toFixed(2);
    }
}

// --- GENERAR TICKET DE PAGO (RECIBO) ---
function imprimirComprobantePago(proveedor, fecha, monto, metodo, obs) {
    let win = window.open('', '_blank', 'width=400,height=600');
    win.document.write(`
        <html>
        <head>
            <title>Recibo de Pago</title>
            <style>
                body { font-family: monospace; padding: 15px; font-size: 14px; color: #000; }
                h2, h3 { text-align: center; margin: 5px 0; }
                .line { border-top: 2px dashed #000; margin: 15px 0; }
                .monto { font-size: 22px; font-weight: bold; text-align: center; border: 2px solid #000; padding: 10px; margin: 20px 0; }
                .firma { margin-top: 60px; text-align: center; }
            </style>
        </head>
        <body>
            <h2>AUTOSERVICIO 20 DE JUNIO</h2>
            <h3>COMPROBANTE DE PAGO</h3>
            <div class="line"></div>
            <p><b>PROVEEDOR:</b> ${proveedor}</p>
            <p><b>FECHA:</b> ${fecha}</p>
            <p><b>MÉTODO:</b> ${metodo}</p>
            <p><b>DETALLE:</b> ${obs || 'Pago a cuenta'}</p>
            
            <div class="monto">TOTAL PAGADO: $${parseFloat(monto).toFixed(2)}</div>
            
            <div class="line"></div>
            <div class="firma">
                <p>_______________________</p>
                <p>Firma y Aclaración<br>Recibí Conforme</p>
            </div>
            
            <script>
                setTimeout(() => { 
                    window.print(); 
                    window.close(); 
                }, 500);
            </script>
        </body>
        </html>
    `);
    win.document.close();
}

// --- EXPORTAR HISTORIAL DE COMPRAS A EXCEL (CSV) ---
// --- EXPORTAR HISTORIAL DE COMPRAS A EXCEL (CSV) ---
function exportarComprasAExcel(proveedorNombre) {
    // Busca exclusivamente la tabla del historial por su ID nuevo
    const tabla = document.getElementById('tablaHistorialExcel');
    if (!tabla) return Swal.fire('Aviso', 'No hay datos para exportar.', 'info');

    let csvContent = "\uFEFF"; // Truco para que Excel lea los acentos (UTF-8 BOM)
    csvContent += "Fecha;Factura;Condicion;Total\n"; 

    const filas = tabla.querySelectorAll('tbody tr');
    
    // Si la primera fila dice que está vacío, frenamos
    if (filas.length === 1 && filas[0].innerText.includes("No hay compras")) {
        return Swal.fire('Aviso', 'No hay compras para exportar.', 'info');
    }

    // Leemos fila por fila
    filas.forEach(fila => {
        const celdas = fila.querySelectorAll('td');
        if (celdas.length >= 4) {
            let fecha = celdas[0].innerText.trim();
            let factura = celdas[1].innerText.trim();
            let condicion = celdas[2].innerText.trim();
            // Le sacamos el símbolo $ y espacios al total para que Excel pueda sumar la columna
            let total = celdas[3].innerText.replace('$', '').trim(); 
            
            csvContent += `${fecha};${factura};${condicion};${total}\n`;
        }
    });

    // Descargamos el archivo
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.setAttribute("href", URL.createObjectURL(blob));
    link.setAttribute("download", `Compras_${proveedorNombre.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ARRANQUE INICIAL
document.addEventListener("DOMContentLoaded", cargarProveedores);