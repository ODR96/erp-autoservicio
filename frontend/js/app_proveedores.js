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
                <td class="text-muted fw-bold align-middle col-hide-xs">#${p.id}</td>
                <td class="fw-bold text-start align-middle">${p.nombre_comercial} ${iconoNota} ${!esActivo ? '<span class="badge bg-secondary ms-2">INACTIVO</span>' : ''}</td>
                <td class="align-middle col-hide-xs">${p.cuit || '-'}</td>
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

function cambiarModoIngreso(modo) {
    const esDeuda = modo === 'deuda';
    document.getElementById('modoIngresoDeuda')?.classList.toggle('active', esDeuda);
    document.getElementById('modoIngresoStock')?.classList.toggle('active', !esDeuda);
    document.getElementById('panelDeudaRapida')?.classList.toggle('d-none', !esDeuda);
    document.getElementById('panelIngresoStock')?.classList.toggle('d-none', esDeuda);
    const ayuda = document.getElementById('ayudaModoIngreso');
    if (ayuda) {
        ayuda.textContent = esDeuda
            ? 'Anota factura o remito y el total. No toca stock ni precios.'
            : 'Escaneá cada producto para actualizar stock, costo y precio.';
    }
}

function limpiarFactura() {
    facturaActualItems = [];
    document.getElementById('inputNumFactura').value = '';
    const extra = document.getElementById('inputCargosExtra');
    if (extra) extra.value = '0';
    dibujarTablaFactura();
}

async function preguntarPagoInmediato(total, condicion) {
    const esCC = condicion === 'Cuenta Corriente';
    const eleccion = await Swal.fire({
        title: esCC ? '¿Pagás algo ahora?' : 'Contado: ¿de dónde salió la plata?',
        html: esCC
            ? '<p class="small text-muted mb-0">La factura suma deuda. Si pagás de esta caja, el cajón baja y <b>no</b> es gasto del mes.</p>'
            : '<p class="small text-muted mb-0">Contado no saca el cajón solo. Si salió efectivo de la registradora, registralo acá (no uses Gastos del POS).</p>',
        input: 'radio',
        inputOptions: esCC
            ? {
                despues: 'Queda deuda (pago después)',
                caja: 'Pago efectivo de esta caja',
                bolsillo: 'Pago bolsillo / transferencia'
            }
            : {
                caja: 'Efectivo de esta caja (todo o parte)',
                bolsillo: 'Bolsillo / ya no está en el cajón',
                papel: 'Solo anotar, sin pago'
            },
        inputValue: esCC ? 'despues' : 'caja',
        showCancelButton: true,
        confirmButtonText: 'Seguir',
        cancelButtonText: 'Cancelar carga',
        confirmButtonColor: '#1b365d'
    });
    if (!eleccion.isConfirmed) return { cancel: true };
    const modo = eleccion.value;
    if (modo === 'despues' || modo === 'papel') return { pago: null };

    const montoDlg = await Swal.fire({
        title: 'Monto a pagar ahora',
        input: 'number',
        inputValue: total,
        inputAttributes: { min: 0.01, step: 0.01 },
        showCancelButton: true,
        confirmButtonText: 'Confirmar monto',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#1b365d',
        preConfirm: (v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n) || n <= 0) {
                Swal.showValidationMessage('Monto mayor a cero');
                return false;
            }
            if (n > total + 0.009) {
                Swal.showValidationMessage('No puede ser mayor al total de la factura');
                return false;
            }
            return n;
        }
    });
    if (!montoDlg.isConfirmed) return { cancel: true };

    return {
        pago: {
            metodo_pago: modo === 'caja' ? 'EFECTIVO CAJA' : 'EFECTIVO BOLSILLO',
            monto: montoDlg.value,
            observaciones: modo === 'caja'
                ? 'Pago al cargar (efectivo caja)'
                : 'Pago al cargar (bolsillo / transferencia)'
        }
    };
}

async function confirmarDeudaRapida() {
    const provId = document.getElementById('selectProvIngreso').value;
    const numFactura = document.getElementById('inputNumFactura').value.trim();
    const condicion = document.getElementById('selectCondicionPago').value;
    const total = parseFloat(document.getElementById('inputTotalDeudaRapida').value);
    const observaciones = document.getElementById('inputObsDeudaRapida').value.trim();

    if (!provId) return Swal.fire('Atención', 'Seleccioná un proveedor.', 'warning');
    if (!numFactura) return Swal.fire('Atención', 'Ingresá el N° de factura o remito.', 'warning');
    if (!Number.isFinite(total) || total <= 0) return Swal.fire('Atención', 'Ingresá un total mayor a cero.', 'warning');

    const confirm = await Swal.fire({
        title: '¿Guardar deuda?',
        text: condicion === 'Cuenta Corriente'
            ? `Se suma $${total.toFixed(2)} al saldo del proveedor. El stock no cambia.`
            : `Queda registrada como Contado por $${total.toFixed(2)}. El stock no cambia.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Guardar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#1b365d'
    });
    if (!confirm.isConfirmed) return;

    const pagoAhora = await preguntarPagoInmediato(total, condicion);
    if (pagoAhora.cancel) return;

    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/deuda_rapida`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                proveedor_id: parseInt(provId),
                numero_factura: numFactura,
                condicion_pago: condicion,
                total_factura: total,
                observaciones,
                pago_inmediato: pagoAhora.pago
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.error || 'No se pudo guardar.'));
        }
        if (data.error) throw new Error(data.error);

        document.getElementById('inputNumFactura').value = '';
        document.getElementById('inputTotalDeudaRapida').value = '';
        document.getElementById('inputObsDeudaRapida').value = '';
        await cargarProveedores();
        const extraPago = pagoAhora.pago
            ? (pagoAhora.pago.metodo_pago === 'EFECTIVO CAJA'
                ? ' Se registró el pago de caja (no es gasto).'
                : ' Se registró el pago (bolsillo / transferencia).')
            : '';
        Swal.fire('Deuda registrada', (data.mensaje || 'Listo. El stock no se tocó.') + extraPago, 'success');
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function confirmarIngresoMercaderia() {
    const provId = document.getElementById('selectProvIngreso').value;
    const numFactura = document.getElementById('inputNumFactura').value.trim() || `INT-${new Date().getTime()}`;
    const condicion = document.getElementById('selectCondicionPago').value;

    if (!provId) return Swal.fire('Error', 'Debe seleccionar un proveedor.', 'warning');
    if (facturaActualItems.length === 0) return Swal.fire('Error', 'No hay productos en la factura.', 'warning');

    const cargosExtraIngresados = parseFloat(document.getElementById('inputCargosExtra').value) || 0;
    const totalEstimado = facturaActualItems.reduce((acc, it) => acc + (it.cantidad_comprada * it.costo_unitario), 0) + cargosExtraIngresados;

    const pagoAhora = await preguntarPagoInmediato(totalEstimado, condicion);
    if (pagoAhora.cancel) return;

    Swal.fire({ title: 'Procesando ingreso...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    const btnGuardar = document.querySelector('button[onclick="confirmarIngresoMercaderia()"]');
    if (btnGuardar) {
        btnGuardar.disabled = true;
        btnGuardar.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Guardando...';
    }

    try {
        const payload = {
            proveedor_id: parseInt(provId),
            numero_factura: numFactura,
            condicion_pago: condicion,
            cargos_extra: cargosExtraIngresados, // <--- ACÁ VIAJA EL DATO A PYTHON
            items: facturaActualItems,
            pago_inmediato: pagoAhora.pago
        };

        const res = await fetch(`${obtenerBaseUrl()}/proveedores/cargar_factura`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.error || 'No se pudo guardar.'));
        }
        if (data.error) throw new Error(data.error);

        const extraPago = pagoAhora.pago
            ? (pagoAhora.pago.metodo_pago === 'EFECTIVO CAJA'
                ? ' Pago de caja registrado (no es gasto).'
                : ' Pago bolsillo / transferencia registrado.')
            : '';
        Swal.fire('¡Mercadería Ingresada!', 'El stock, los costos y la deuda se actualizaron.' + extraPago, 'success');
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

        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.error || 'No se pudo registrar el pago.'));
        }
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
            document.getElementById('montoProvDeuda').innerText = '$ ' + parseFloat(provActualizado.saldo_deudor || 0).toFixed(2);
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


// ==========================================
// 4. MÓDULO DE FALTANTES Y PEDIDOS
// ==========================================
let faltantesCache = [];
let alertasStockCache = [];
let filtroFaltantes = 'PENDIENTE';
let seleccionFaltantes = new Set();
let seleccionAlertas = new Set();

document.getElementById('tabBtnPedidos')?.addEventListener('click', cargarTableroPedidos);

function escapeHtmlPedidos(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fechaHoyAR() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

function formatearCantidadPedido(valor) {
    const n = parseFloat(valor);
    if (!Number.isFinite(n)) return '1';
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function etiquetaEstadoFaltante(estado) {
    if (estado === 'PEDIDO') return '<span class="badge bg-primary">Pedido</span>';
    if (estado === 'RECIBIDO') return '<span class="badge bg-success">Recibido</span>';
    return '<span class="badge bg-warning text-dark">Pendiente</span>';
}

function faltantesVisibles() {
    return faltantesCache.filter(f => {
        const estado = f.estado || 'PENDIENTE';
        return estado === filtroFaltantes;
    });
}

function idsFaltantesVisibles() {
    return faltantesVisibles().map(f => Number(f.id));
}

function idsFaltantesParaAccion() {
    const visibles = new Set(idsFaltantesVisibles());
    const seleccionVisible = Array.from(seleccionFaltantes).filter(id => visibles.has(id));
    if (seleccionVisible.length > 0) return seleccionVisible;
    return Array.from(visibles);
}

function esFiltroRecibidos() {
    return filtroFaltantes === 'RECIBIDO';
}

function aplicarFiltroFaltantes(vista) {
    filtroFaltantes = vista;
    seleccionFaltantes.clear();
    document.querySelectorAll('[aria-label="Filtro de faltantes"] .btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('filtroFaltantes' + vista)?.classList.add('active');
    dibujarFaltantesCaja();
    actualizarAccionesFaltantes();
}

function actualizarAccionesFaltantes() {
    const recibidos = esFiltroRecibidos();
    const mostrar = (id, si) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('d-none', !si);
    };
    mostrar('btnFaltantesMarcarPedido', !recibidos);
    mostrar('btnFaltantesMarcarRecibido', !recibidos);
    mostrar('btnFaltantesWhatsapp', !recibidos);
    mostrar('btnFaltantesCotizacion', !recibidos);
    mostrar('btnFaltantesVolverPendiente', !recibidos);
    mostrar('btnFaltantesExcel', !recibidos);
    mostrar('btnFaltantesPdf', !recibidos);
}

async function cargarTableroPedidos() {
    try {
        const resFaltantes = await fetch(`${obtenerBaseUrl()}/reportes/faltantes_pendientes`);
        const dataFaltantes = await resFaltantes.json();
        faltantesCache = dataFaltantes.faltantes || [];

        const resAlertas = await fetch(`${obtenerBaseUrl()}/reportes/alertas`);
        const dataAlertas = await resAlertas.json();
        alertasStockCache = dataAlertas.alertas_stock_critico || [];

        const idsVivos = new Set(faltantesCache.map(f => Number(f.id)));
        seleccionFaltantes.forEach(id => { if (!idsVivos.has(id)) seleccionFaltantes.delete(id); });
        const alertasVivas = new Set(alertasStockCache.map(p => Number(p.producto_id)));
        seleccionAlertas.forEach(id => { if (!alertasVivas.has(id)) seleccionAlertas.delete(id); });

        dibujarFaltantesCaja();
        dibujarAlertasStock();
        actualizarContadoresFiltro();
        actualizarAccionesFaltantes();
    } catch (e) {
        console.error("Error cargando pedidos:", e);
        Swal.fire('Error', 'No se pudo cargar el tablero de pedidos.', 'error');
    }
}

function dibujarFaltantesCaja() {
    const tbody = document.getElementById('tablaFaltantesCaja');
    if (!tbody) return;
    const lista = faltantesVisibles();
    const badge = document.getElementById('badgeCountFaltantes');
    if (badge) badge.textContent = String(lista.length);
    const recibidos = esFiltroRecibidos();
    const chkTodos = document.getElementById('chkTodosFaltantes');
    if (chkTodos) {
        chkTodos.closest('th')?.classList.toggle('d-none', recibidos);
        chkTodos.disabled = recibidos;
        if (recibidos) chkTodos.checked = false;
    }

    if (lista.length === 0) {
        const vacio = recibidos
            ? 'No hay recibidos. Cuando llega la mercadería, marcala desde Pedidos.'
            : 'No hay ítems en este filtro.';
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">
            <i class="bi bi-check-circle fs-4 d-block mb-2 text-success"></i>
            ${vacio}
        </td></tr>`;
        actualizarResumenSeleccion();
        return;
    }

    tbody.innerHTML = lista.map(f => {
        const id = Number(f.id);
        const estado = f.estado || 'PENDIENTE';
        const claseFila = estado === 'PEDIDO' ? 'fila-faltante-pedido' : (estado === 'RECIBIDO' ? 'fila-faltante-recibido' : '');
        const quien = f.usuario_anoto ? `<div class="small text-muted">Por ${escapeHtmlPedidos(f.usuario_anoto)}</div>` : '';
        const obs = f.notas ? escapeHtmlPedidos(f.notas) : '<span class="text-muted">—</span>';
        const cuando = f.fecha_recibido || f.fecha_pedido || f.fecha_hora || '';
        const colCheck = recibidos ? '' : `
                <td class="text-center">
                    <input class="form-check-input chk-faltante" type="checkbox" value="${id}"
                        ${seleccionFaltantes.has(id) ? 'checked' : ''}
                        onclick="event.stopPropagation()"
                        onchange="toggleSeleccionFaltante(${id}, this.checked)">
                </td>`;
        const colEstado = recibidos
            ? `<td class="small text-muted col-hide-xs">${escapeHtmlPedidos(cuando)}<div>${etiquetaEstadoFaltante(estado)}</div></td>`
            : `<td class="col-hide-xs">${etiquetaEstadoFaltante(estado)}</td>`;
        const clickFila = recibidos ? '' : `onclick="toggleFilaFaltante(event, ${id})"`;
        const cantCell = recibidos
            ? `<td class="text-center fw-bold">${formatearCantidadPedido(f.cantidad_pedida)}</td>`
            : `<td class="text-center" onclick="event.stopPropagation()">
                    <input type="number" class="form-control form-control-sm input-cant-faltante"
                        min="0.1" step="0.1" value="${formatearCantidadPedido(f.cantidad_pedida)}"
                        title="Editar cantidad"
                        onkeydown="if(event.key === 'Enter') { event.preventDefault(); this.blur(); }"
                        onchange="guardarCantidadFaltante(${id}, this)"
                        onblur="guardarCantidadFaltante(${id}, this)">
                </td>`;
        const colAccion = recibidos ? `
                <td class="text-center text-nowrap">
                    <button type="button" class="btn btn-sm btn-outline-secondary py-0" title="Volver a pendiente"
                        onclick="event.stopPropagation(); devolverFaltanteAPendiente(${id})">
                        <i class="bi bi-arrow-counterclockwise"></i>
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-danger py-0" title="Borrar del historial"
                        onclick="event.stopPropagation(); quitarFaltante(${id})">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>` : `
                <td class="text-center">
                    <button type="button" class="btn btn-sm btn-outline-danger py-0" title="Quitar de la lista"
                        onclick="event.stopPropagation(); quitarFaltante(${id})">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>`;
        return `
            <tr class="${claseFila}" ${clickFila}>
                ${colCheck}
                <td class="text-start fw-bold">${escapeHtmlPedidos(f.descripcion_producto)}${quien}</td>
                ${cantCell}
                <td class="small col-hide-xs">${obs}</td>
                ${colEstado}
                ${colAccion}
            </tr>`;
    }).join('');

    if (!recibidos && chkTodos) {
        const visiblesIds = lista.map(f => Number(f.id));
        chkTodos.checked = visiblesIds.length > 0 && visiblesIds.every(id => seleccionFaltantes.has(id));
    }
    actualizarResumenSeleccion();
}

function dibujarAlertasStock() {
    const tbody = document.getElementById('tablaFaltantesSistema');
    if (!tbody) return;
    const lista = alertasStockCache;

    if (lista.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">
            <i class="bi bi-box-seam fs-4 d-block mb-2 text-success"></i>
            Stock en niveles óptimos.
        </td></tr>`;
        const chkTodas = document.getElementById('chkTodasAlertas');
        if (chkTodas) chkTodas.checked = false;
        actualizarResumenSeleccion();
        return;
    }

    tbody.innerHTML = lista.map(p => {
        const id = Number(p.producto_id);
        const provSugerido = proveedoresGlobales.find(prov => prov.id === p.proveedor_habitual_id);
        const nombreProv = provSugerido ? provSugerido.nombre_comercial : 'Sin asignar';
        return `
            <tr onclick="toggleFilaAlerta(event, ${id})">
                <td class="text-center">
                    <input class="form-check-input chk-alerta" type="checkbox" value="${id}"
                        ${seleccionAlertas.has(id) ? 'checked' : ''}
                        onclick="event.stopPropagation()"
                        onchange="toggleSeleccionAlerta(${id}, this.checked)">
                </td>
                <td class="text-start fw-bold">${escapeHtmlPedidos(p.nombre)}</td>
                <td class="text-danger fw-bold">${p.stock_actual}</td>
                <td class="text-muted">${p.stock_minimo_alerta}</td>
                <td class="col-hide-xs"><span class="badge bg-secondary">${escapeHtmlPedidos(nombreProv)}</span></td>
            </tr>`;
    }).join('');

    const ids = lista.map(p => Number(p.producto_id));
    const chkTodas = document.getElementById('chkTodasAlertas');
    if (chkTodas) {
        chkTodas.checked = ids.length > 0 && ids.every(id => seleccionAlertas.has(id));
    }
    actualizarResumenSeleccion();
}

function toggleFilaFaltante(evento, id) {
    if (evento.target.closest('button, a, input')) return;
    const chk = document.querySelector(`.chk-faltante[value="${id}"]`);
    if (!chk) return;
    chk.checked = !chk.checked;
    toggleSeleccionFaltante(id, chk.checked);
}

function toggleFilaAlerta(evento, id) {
    if (evento.target.closest('button, a, input')) return;
    const chk = document.querySelector(`.chk-alerta[value="${id}"]`);
    if (!chk) return;
    chk.checked = !chk.checked;
    toggleSeleccionAlerta(id, chk.checked);
}

function toggleSeleccionFaltante(id, checked) {
    if (checked) seleccionFaltantes.add(Number(id));
    else seleccionFaltantes.delete(Number(id));
    const visiblesIds = faltantesVisibles().map(f => Number(f.id));
    const chkTodos = document.getElementById('chkTodosFaltantes');
    if (chkTodos) chkTodos.checked = visiblesIds.length > 0 && visiblesIds.every(i => seleccionFaltantes.has(i));
    actualizarResumenSeleccion();
}

function toggleSeleccionAlerta(id, checked) {
    if (checked) seleccionAlertas.add(Number(id));
    else seleccionAlertas.delete(Number(id));
    const ids = alertasStockCache.map(p => Number(p.producto_id));
    const chkTodas = document.getElementById('chkTodasAlertas');
    if (chkTodas) chkTodas.checked = ids.length > 0 && ids.every(i => seleccionAlertas.has(i));
    actualizarResumenSeleccion();
}

function toggleTodosFaltantes(checked) {
    if (esFiltroRecibidos()) return;
    faltantesVisibles().forEach(f => {
        const id = Number(f.id);
        if (checked) seleccionFaltantes.add(id);
        else seleccionFaltantes.delete(id);
    });
    dibujarFaltantesCaja();
}

function toggleTodasAlertas(checked) {
    alertasStockCache.forEach(p => {
        const id = Number(p.producto_id);
        if (checked) seleccionAlertas.add(id);
        else seleccionAlertas.delete(id);
    });
    dibujarAlertasStock();
}

function actualizarResumenSeleccion() {
    const el = document.getElementById('resumenSeleccionFaltantes');
    if (!el) return;
    const nFalt = seleccionFaltantes.size;
    const nAlert = seleccionAlertas.size;
    if (nFalt === 0 && nAlert === 0) {
        el.textContent = esFiltroRecibidos()
            ? 'Recibidos es historial: ya llegó. El tacho borra el renglón. Pendiente los saca de acá si el camión no era.'
            : 'Ningún ítem tildado en esta pestaña. Excel, WhatsApp y las hojas usan lo tildado; si no hay tilde, lo visible.';
        return;
    }
    const partes = [];
    if (nFalt) partes.push(`${nFalt} de caja`);
    if (nAlert) partes.push(`${nAlert} de stock mínimo`);
    el.textContent = `Seleccionados: ${partes.join(' · ')}.`;
}

async function guardarCantidadFaltante(id, input) {
    const item = faltantesCache.find(f => Number(f.id) === Number(id));
    const cantidad = parseFloat(input.value);
    const anterior = item ? parseFloat(item.cantidad_pedida) : NaN;

    if (!Number.isFinite(cantidad) || cantidad <= 0) {
        input.value = formatearCantidadPedido(anterior);
        return Swal.fire('Atención', 'La cantidad tiene que ser mayor a cero.', 'warning');
    }
    if (Number.isFinite(anterior) && cantidad === anterior) return;

    input.disabled = true;
    try {
        const res = await fetch(`${obtenerBaseUrl()}/reportes/faltantes/cantidad`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: Number(id), cantidad })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.error || 'No se pudo guardar la cantidad.'));
        }
        if (item) item.cantidad_pedida = cantidad;
        input.value = formatearCantidadPedido(cantidad);
    } catch (e) {
        input.value = formatearCantidadPedido(anterior);
        Swal.fire('Error', e.message, 'error');
    } finally {
        input.disabled = false;
    }
}

function actualizarContadoresFiltro() {
    const nPend = faltantesCache.filter(f => (f.estado || 'PENDIENTE') === 'PENDIENTE').length;
    const nPed = faltantesCache.filter(f => f.estado === 'PEDIDO').length;
    const nRec = faltantesCache.filter(f => f.estado === 'RECIBIDO').length;
    const setLabel = (id, texto, n) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `${texto} <span class="badge rounded-pill bg-white text-secondary border ms-1">${n}</span>`;
    };
    setLabel('filtroFaltantesPENDIENTE', 'Pendientes', nPend);
    setLabel('filtroFaltantesPEDIDO', 'Pedidos', nPed);
    setLabel('filtroFaltantesRECIBIDO', 'Recibidos', nRec);
}

async function marcarSeleccionFaltantes(estado) {
    const ids = idsFaltantesParaAccion();
    const seleccionVisible = idsFaltantesVisibles().filter(id => seleccionFaltantes.has(id)).length;

    if (ids.length === 0) {
        return Swal.fire('Atención', 'No hay productos para actualizar en este filtro.', 'info');
    }

    const titulos = {
        PEDIDO: 'Marcar como pedido',
        RECIBIDO: 'Marcar como recibido',
        PENDIENTE: 'Volver a pendiente'
    };
    const confirm = await Swal.fire({
        title: titulos[estado] || 'Actualizar estado',
        text: seleccionVisible > 0
            ? `Se actualizan ${ids.length} ítem(s) tildados de esta pestaña.`
            : `No hay tilde: se actualizan los ${ids.length} ítem(s) visibles.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Confirmar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#1b365d'
    });
    if (!confirm.isConfirmed) return;

    try {
        const res = await fetch(`${obtenerBaseUrl()}/reportes/faltantes/estado`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, estado })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.error || 'No se pudo actualizar.'));
        }
        seleccionFaltantes.clear();
        await cargarTableroPedidos();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Lista actualizada', showConfirmButton: false, timer: 1400 });
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function devolverFaltanteAPendiente(id) {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/reportes/faltantes/estado`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [Number(id)], estado: 'PENDIENTE' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.error || 'No se pudo actualizar.'));
        }
        await cargarTableroPedidos();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Volvió a pendientes', showConfirmButton: false, timer: 1400 });
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function quitarFaltante(id) {
    const confirm = await Swal.fire({
        title: '¿Quitar de la lista?',
        text: 'Se borra el anotado de caja. No afecta el stock.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Quitar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#dc3545'
    });
    if (!confirm.isConfirmed) return;

    try {
        const res = await fetch(`${obtenerBaseUrl()}/reportes/resolver_faltante/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('No se pudo quitar.');
        seleccionFaltantes.delete(Number(id));
        await cargarTableroPedidos();
    } catch (e) {
        Swal.fire('Error', e.message || 'No se pudo actualizar.', 'error');
    }
}

async function pasarAlertasALista() {
    const seleccionadas = alertasStockCache.filter(p => seleccionAlertas.has(Number(p.producto_id)));
    if (seleccionadas.length === 0) {
        return Swal.fire('Atención', 'Seleccioná alertas de stock para pasarlas a la lista de caja.', 'info');
    }

    try {
        for (const p of seleccionadas) {
            const provSugerido = proveedoresGlobales.find(prov => prov.id === p.proveedor_habitual_id);
            const nombreProv = provSugerido ? provSugerido.nombre_comercial : 'Sin asignar';
            const res = await fetch(`${obtenerBaseUrl()}/reportes/registrar_faltante`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    descripcion: p.nombre,
                    cantidad: 1.0,
                    notas: `Stock ${p.stock_actual} / mín. ${p.stock_minimo_alerta} · ${nombreProv}`,
                    usuario_nombre: 'Sistema (stock mínimo)'
                })
            });
            if (!res.ok) throw new Error('No se pudo pasar una alerta a la lista.');
        }
        seleccionAlertas.clear();
        await cargarTableroPedidos();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Pasadas a la lista', showConfirmButton: false, timer: 1400 });
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

function recolectarItemsPedido() {
    const visiblesFalt = faltantesVisibles();
    const visSet = new Set(visiblesFalt.map(f => Number(f.id)));
    const selFalt = Array.from(seleccionFaltantes).filter(id => visSet.has(id));
    const faltantesFuente = selFalt.length > 0
        ? visiblesFalt.filter(f => selFalt.includes(Number(f.id)))
        : visiblesFalt;
    const faltantes = faltantesFuente.map(f => ({
        producto: f.descripcion_producto || '',
        cantidad: formatearCantidadPedido(f.cantidad_pedida),
        observacion: f.notas || '',
        pedidoPor: f.usuario_anoto || '',
        estado: f.estado || 'PENDIENTE',
        origen: 'Caja',
        proveedor: ''
    }));

    const hayAlertas = seleccionAlertas.size > 0;
    const alertas = (hayAlertas
        ? alertasStockCache.filter(p => seleccionAlertas.has(Number(p.producto_id)))
        : []
    ).map(p => {
        const provSugerido = proveedoresGlobales.find(prov => prov.id === p.proveedor_habitual_id);
        return {
            producto: p.nombre || '',
            cantidad: '1',
            observacion: `Disp. ${p.stock_actual} / mín. ${p.stock_minimo_alerta}`,
            pedidoPor: 'Stock mínimo',
            estado: 'PENDIENTE',
            origen: 'Stock',
            proveedor: provSugerido ? provSugerido.nombre_comercial : 'Sin asignar'
        };
    });

    return faltantes.concat(alertas);
}

function csvCeldaPedido(valor) {
    const texto = String(valor ?? '').replace(/"/g, '""');
    return `"${texto}"`;
}

function exportarPedidoExcel() {
    const items = recolectarItemsPedido();
    if (items.length === 0) return Swal.fire('Aviso', 'No hay productos para exportar.', 'info');

    let csv = '\uFEFF';
    csv += 'Producto;Cantidad;Observacion;Pedido por;Estado;Origen;Proveedor\n';
    items.forEach(item => {
        csv += [
            csvCeldaPedido(item.producto),
            csvCeldaPedido(item.cantidad),
            csvCeldaPedido(item.observacion),
            csvCeldaPedido(item.pedidoPor),
            csvCeldaPedido(item.estado),
            csvCeldaPedido(item.origen),
            csvCeldaPedido(item.proveedor)
        ].join(';') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Pedido_faltantes_${fechaHoyAR()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function htmlPedidoFaltantes(items) {
    const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: 'Autoservicio 20 de Junio' };
    const nombreLocal = config.nombre_negocio || 'Autoservicio 20 de Junio';
    const filas = items.map(item => `
        <tr>
            <td>${escapeHtmlPedidos(item.producto)}</td>
            <td style="text-align:center;">${escapeHtmlPedidos(item.cantidad)}</td>
            <td>${escapeHtmlPedidos(item.observacion || '—')}</td>
            <td>${escapeHtmlPedidos(item.pedidoPor || '—')}</td>
            <td>${escapeHtmlPedidos(item.estado)}</td>
            <td>${escapeHtmlPedidos(item.proveedor || item.origen)}</td>
        </tr>`).join('');

    return `
        <h2>Pedido de faltantes</h2>
        <div class="meta">${escapeHtmlPedidos(nombreLocal)} · ${fechaHoyAR()} · ${items.length} ítem(s)</div>
        <table>
            <thead>
                <tr>
                    <th>Producto</th>
                    <th>Cant.</th>
                    <th>Obs.</th>
                    <th>Pedido por</th>
                    <th>Estado</th>
                    <th>Proveedor / origen</th>
                </tr>
            </thead>
            <tbody>${filas}</tbody>
        </table>`;
}

function htmlHojaCotizacion(items, columnas) {
    const n = Math.min(4, Math.max(2, parseInt(columnas, 10) || 3));
    const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: 'Autoservicio 20 de Junio' };
    const nombreLocal = config.nombre_negocio || 'Autoservicio 20 de Junio';
    const celdasPrecio = Array.from({ length: n }, () => '<td class="celda-precio"></td>').join('');
    const encabezadosRayas = Array.from({ length: n }, (_, i) => `Prov. ${i + 1}: ____________`).join(' &nbsp;&nbsp; ');
    const thPrecios = Array.from({ length: n }, (_, i) => `<th>Precio ${i + 1}</th>`).join('');
    const filas = items.map(item => `
        <tr>
            <td>${escapeHtmlPedidos(item.producto)}</td>
            <td style="text-align:center;">${escapeHtmlPedidos(item.cantidad)}</td>
            ${celdasPrecio}
        </tr>`).join('');

    return `
        <h2>Hoja de cotización</h2>
        <div class="meta">${escapeHtmlPedidos(nombreLocal)} · ${fechaHoyAR()} · ${items.length} ítem(s) — ${n} proveedor(es)</div>
        <div class="encabezados-prov">${encabezadosRayas}</div>
        <table>
            <thead>
                <tr>
                    <th>Producto</th>
                    <th style="width:70px;">Cant.</th>
                    ${thPrecios}
                </tr>
            </thead>
            <tbody>${filas}</tbody>
        </table>`;
}

function abrirPreviewPedido(html, titulo, modo) {
    const hoja = document.getElementById('previewPedidoHoja');
    const modalEl = document.getElementById('modalPreviewPedido');
    const tituloEl = document.getElementById('tituloPreviewPedido');
    if (!hoja || !modalEl) return Swal.fire('Error', 'No se encontró la vista previa.', 'error');
    hoja.innerHTML = html;
    hoja.dataset.modo = modo || 'pedido';
    if (tituloEl) tituloEl.innerHTML = titulo;
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function exportarPedidoPdf() {
    const items = recolectarItemsPedido();
    if (items.length === 0) return Swal.fire('Aviso', 'No hay productos para exportar.', 'info');
    abrirPreviewPedido(htmlPedidoFaltantes(items), '<i class="bi bi-file-earmark-pdf me-2"></i>Vista previa del pedido', 'pedido');
}

async function exportarHojaCotizacion() {
    const items = recolectarItemsPedido();
    if (items.length === 0) return Swal.fire('Aviso', 'No hay productos para la hoja.', 'info');

    const previa = parseInt(localStorage.getItem('cotizacion_columnas_prov') || '3', 10);
    const { value: columnas, isConfirmed } = await Swal.fire({
        title: 'Columnas de precio',
        text: 'Cuántos proveedores vas a comparar en esta salida.',
        input: 'select',
        inputOptions: { 2: '2 proveedores', 3: '3 proveedores', 4: '4 proveedores' },
        inputValue: [2, 3, 4].includes(previa) ? String(previa) : '3',
        showCancelButton: true,
        confirmButtonText: 'Armar hoja',
        cancelButtonText: 'Cancelar'
    });
    if (!isConfirmed) return;

    const n = parseInt(columnas, 10) || 3;
    localStorage.setItem('cotizacion_columnas_prov', String(n));
    abrirPreviewPedido(htmlHojaCotizacion(items, n), '<i class="bi bi-clipboard2-plus me-2"></i>Hoja de cotización', 'cotizacion');
}

async function enviarPedidoWhatsapp() {
    const items = recolectarItemsPedido();
    if (items.length === 0) return Swal.fire('Aviso', 'No hay productos para enviar.', 'info');

    const confirm = await Swal.fire({
        title: '¿Mandar al grupo?',
        text: `Se envían ${items.length} ítem(s) al grupo de compras. No se marca Pedido solo por enviar.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Enviar WhatsApp',
        cancelButtonText: 'Cancelar'
    });
    if (!confirm.isConfirmed) return;

    try {
        const res = await fetch(`${obtenerBaseUrl()}/reportes/faltantes/whatsapp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quien: localStorage.getItem('usuario_nombre') || '',
                items: items.map(i => ({
                    producto: i.producto,
                    cantidad: i.cantidad,
                    observacion: i.observacion || ''
                }))
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.error || 'No se pudo enviar.'));
        }
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Disparado al grupo', showConfirmButton: false, timer: 1600 });
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

let timeoutSugerirFaltante = null;
function sugerirFaltanteCatalogo() {
    const input = document.getElementById('faltanteAltaNombre');
    const lista = document.getElementById('faltanteAltaSugerencias');
    if (!input || !lista) return;
    const q = input.value.trim();
    clearTimeout(timeoutSugerirFaltante);
    if (q.length < 2) {
        lista.innerHTML = '';
        return;
    }
    timeoutSugerirFaltante = setTimeout(async () => {
        try {
            const res = await fetch(`${obtenerBaseUrl()}/productos/buscar?termino=${encodeURIComponent(q)}`);
            const data = await res.json();
            lista.innerHTML = (data.productos || []).slice(0, 12).map(p =>
                `<option value="${escapeHtmlPedidos(p.nombre)}"></option>`
            ).join('');
        } catch (e) {
            lista.innerHTML = '';
        }
    }, 250);
}

async function anotarFaltanteManual() {
    const nombre = (document.getElementById('faltanteAltaNombre')?.value || '').trim();
    const obs = (document.getElementById('faltanteAltaObs')?.value || '').trim();
    const cantidad = parseFloat(document.getElementById('faltanteAltaCant')?.value);

    if (!nombre) return Swal.fire('Atención', 'Escribí el producto (del catálogo o a mano).', 'warning');
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
        return Swal.fire('Atención', 'La cantidad tiene que ser mayor a cero.', 'warning');
    }

    try {
        const res = await fetch(`${obtenerBaseUrl()}/reportes/registrar_faltante`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                descripcion: nombre,
                cantidad,
                notas: obs,
                usuario_nombre: localStorage.getItem('usuario_nombre') || 'Oficina'
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.error || 'No se pudo anotar.'));
        }
        document.getElementById('faltanteAltaNombre').value = '';
        document.getElementById('faltanteAltaObs').value = '';
        document.getElementById('faltanteAltaCant').value = '1';
        await cargarTableroPedidos();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Anotado', showConfirmButton: false, timer: 1200 });
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

function imprimirPedidoDesdePreview() {
    const hoja = document.getElementById('previewPedidoHoja');
    if (!hoja || !hoja.innerHTML.trim()) {
        return Swal.fire('Aviso', 'No hay vista previa para imprimir.', 'info');
    }

    const esCotizacion = hoja.dataset.modo === 'cotizacion';
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) return Swal.fire('Aviso', 'El navegador bloqueó la ventana de impresión.', 'info');

    win.document.write(`
        <html>
        <head>
            <title>${esCotizacion ? 'Hoja de cotización' : 'Pedido de faltantes'}</title>
            <style>
                @page { size: A4 ${esCotizacion ? 'landscape' : 'portrait'}; margin: 12mm; }
                body { font-family: 'Segoe UI', sans-serif; color: #212529; padding: 12px; }
                h2 { margin: 0 0 4px; color: #1b365d; }
                .meta { color: #6c757d; margin-bottom: 10px; font-size: 13px; }
                .encabezados-prov { margin-bottom: 12px; font-size: 13px; }
                table { width: 100%; border-collapse: collapse; font-size: 13px; }
                th { background: #f8f9fa; text-align: left; padding: 8px; border-bottom: 2px solid #1b365d; text-transform: uppercase; font-size: 11px; letter-spacing: .03em; }
                td { padding: 8px; border-bottom: 1px solid #e9ecef; vertical-align: top; }
                td.celda-precio { width: 18%; height: 28px; border: 1px solid #adb5bd; }
            </style>
        </head>
        <body>
            ${hoja.innerHTML}
        </body>
        </html>
    `);
    win.document.close();
    setTimeout(() => win.print(), 300);
}

// ARRANQUE INICIAL
document.addEventListener("DOMContentLoaded", cargarProveedores);