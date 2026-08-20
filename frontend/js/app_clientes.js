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

let clientesGlobales = [];
let clienteSeleccionadoId = null;
let clienteEditandoId = null;
let modalClienteInstance;

document.addEventListener('DOMContentLoaded', () => {
    modalClienteInstance = new bootstrap.Modal(document.getElementById('modalEdicionCliente'));
    cargarClientes();
    iniciarNavegacionTeclado();
});

async function cargarClientes() {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/clientes/listado`);
        const data = await res.json();
        clientesGlobales = data.clientes || [];
        filtrarClientesUI(); 
    } catch (e) {
        console.error("Error al cargar clientes", e);
    }
}

// --- DIBUJAR INTERFAZ (Tabla y Lista) ---
function dibujarTablaDirectorio(lista) {
    const tbody = document.getElementById('tablaClientesBody');
    if(!tbody) return;
    tbody.innerHTML = '';
    
    if (lista.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">No se encontraron clientes.</td></tr>';
        return;
    }

    lista.forEach(c => {
        let badgeIva = c.condicion_iva === 'Responsable Inscripto' 
            ? '<span class="badge bg-primary">Resp. Inscripto</span>' 
            : `<span class="badge bg-secondary">${c.condicion_iva || 'Consumidor Final'}</span>`;

        const limite = parseFloat(c.limite_credito) || 0;

        tbody.innerHTML += `
            <tr>
                <td class="fw-bold text-dark">${c.nombre_completo}</td>
                <td class="text-muted">${c.cuit || '---'}</td>
                <td>${badgeIva}</td>
                <td>${c.telefono_whatsapp || '---'}</td>
                <td class="text-end fw-bold text-danger">$ ${limite.toFixed(2)}</td>
                <td class="text-center">
                    <button class="btn btn-sm btn-outline-primary shadow-sm" onclick="abrirEditarCliente(${c.id})" title="Editar Ficha">
                        <i class="bi bi-pencil-square"></i> Editar
                    </button>
                </td>
            </tr>
        `;
    });
}

function dibujarListaSaldos(lista) {
    const contenedor = document.getElementById('listaSaldosClientes');
    if(!contenedor) return;
    contenedor.innerHTML = '';
    if (lista.length === 0) { contenedor.innerHTML = '<div class="p-3 text-center text-muted">No hay resultados.</div>'; return; }

    lista.forEach(c => {
        const saldo = parseFloat(c.saldo_actual_deudor) || 0;
        let colorClase = 'text-success opacity-75';
        let textoSaldo = `$ ${saldo.toFixed(2)}`;
        
        // LA LÓGICA DE ANTICIPOS: Si es negativo, es a favor
        if (saldo > 0) { colorClase = 'text-danger fw-bold'; }
        else if (saldo < 0) { 
            colorClase = 'text-success fw-bold'; 
            textoSaldo = `A Favor: $${Math.abs(saldo).toFixed(2)}`; 
        }
        
        contenedor.innerHTML += `
            <button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center py-3 item-cliente-lista" 
                onclick="seleccionarCliente(${c.id})" tabindex="0" data-id="${c.id}">
                <div class="text-start">
                    <div class="fw-bold text-primary">${c.nombre_completo}</div>
                    <small class="text-muted">CUIT/DNI: ${c.cuit || '---'}</small>
                </div>
                <div class="text-end">
                    <div class="fs-5 ${colorClase}">${textoSaldo}</div>
                </div>
            </button>
        `;
    });
}

// --- BUSCADOR UNIFICADO ---
document.getElementById('inputBuscarCliente').addEventListener('input', filtrarClientesUI);

function filtrarClientesUI() {
    const inputBusqueda = document.getElementById('inputBuscarCliente');
    if(!inputBusqueda) return;

    const query = inputBusqueda.value.toLowerCase().trim();
    
    const filtrados = clientesGlobales.filter(c => {
        const nombre = (c.nombre_completo || "").toLowerCase();
        const cuit = c.cuit ? String(c.cuit).toLowerCase() : "";
        return nombre.includes(query) || cuit.includes(query);
    });

    dibujarTablaDirectorio(filtrados);
    dibujarListaSaldos(filtrados);
}

// --- NAVEGACIÓN POR TECLADO PARA LA LISTA ---
function iniciarNavegacionTeclado() {
    const buscador = document.getElementById('inputBuscarCliente');
    if(!buscador) return;
    
    buscador.addEventListener('keydown', (e) => {
        if(document.getElementById('tab-ctacte').classList.contains('d-none')) return;

        const items = document.querySelectorAll('.item-cliente-lista');
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            items[0].focus(); 
        }
    });

    document.getElementById('listaSaldosClientes').addEventListener('keydown', (e) => {
        const target = e.target;
        if (!target.classList.contains('item-cliente-lista')) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (target.nextElementSibling) target.nextElementSibling.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (target.previousElementSibling) {
                target.previousElementSibling.focus();
            } else {
                buscador.focus(); 
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            target.click(); 
        }
    });
}

// --- GESTIÓN DE CUENTA CORRIENTE Y TICKETS ---
async function seleccionarCliente(id) {
    clienteSeleccionadoId = id;
    const cliente = clientesGlobales.find(c => c.id === id);
    if(!cliente) return;
    
    document.getElementById('mensajeSeleccion').classList.add('d-none');
    document.getElementById('panelDetalleCliente').classList.remove('d-none');
    document.getElementById('nombreClienteDetalle').innerText = cliente.nombre_completo;
    document.getElementById('dniClienteDetalle').innerText = `DNI/CUIT: ${cliente.cuit || '---'}`;
    
    // EL CARTEL GRANDE: Rojo (Debe) o Verde (A Favor)
    const saldoFinal = parseFloat(cliente.saldo_actual_deudor) || 0;
    const cajaSaldo = document.getElementById('saldoClienteDetalle');
    if (saldoFinal > 0) {
        cajaSaldo.className = "fw-bold text-danger mb-0";
        cajaSaldo.innerText = `$ ${saldoFinal.toFixed(2)}`;
    } else if (saldoFinal < 0) {
        cajaSaldo.className = "fw-bold text-success mb-0";
        cajaSaldo.innerText = `A favor: $ ${Math.abs(saldoFinal).toFixed(2)}`;
    } else {
        cajaSaldo.className = "fw-bold text-success mb-0 opacity-75";
        cajaSaldo.innerText = `$ 0.00`;
    }
    
    document.getElementById('inputMontoPago').value = '';
    setTimeout(() => document.getElementById('inputMontoPago').focus(), 100);
    cargarHistorialCliente(id);
}

async function cargarHistorialCliente(id) {
    const tbody = document.getElementById('tablaHistorialMovimientos');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4"><div class="spinner-border text-primary" role="status"></div></td></tr>';
    
    try {
        const res = await fetch(`${obtenerBaseUrl()}/clientes/historial/${id}`);
        const data = await res.json();
        
        tbody.innerHTML = '';
        if(!data.movimientos || data.movimientos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">No hay movimientos registrados.</td></tr>';
            return;
        }

        data.movimientos.forEach(m => {
            const esPago = m.tipo_movimiento === 'PAGO';
            const colorMonto = esPago ? 'text-success' : 'text-danger';
            const signo = esPago ? '-' : '+';
            const montoValido = parseFloat(m.monto) || 0;
            
            // LA MAGIA: Si el movimiento es una deuda por venta de ticket, le ponemos el botón para chusmearlo
            let btnAccion = '<span class="text-muted small">---</span>';
            let matchTicket = m.detalle.match(/#(\d+)/); 
            
            if (matchTicket && !esPago) {
                btnAccion = `<button class="btn btn-sm btn-outline-primary py-0 shadow-sm" onclick="verDetalleTicketAdmin(${matchTicket[1]})" title="Ver Ticket">
                                <i class="bi bi-eye"></i> Ver
                             </button>`;
            }
            
            tbody.innerHTML += `
                <tr>
                    <td class="text-muted align-middle text-start">${m.fecha_hora.split(' ')[0]}</td>
                    <td class="align-middle"><span class="badge ${esPago ? 'bg-success' : 'bg-danger'}">${m.tipo_movimiento}</span></td>
                    <td class="small align-middle text-start">${m.detalle}</td>
                    <td class="text-end fw-bold ${colorMonto} align-middle">${signo} $${montoValido.toFixed(2)}</td>
                    <td class="text-center align-middle">${btnAccion}</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Error al cargar historial</td></tr>';
    }
}

// NUEVA FUNCIÓN: Trae la factura completa al panel de administración
async function verDetalleTicketAdmin(ventaId) {
    Swal.fire({ title: 'Buscando Remito...', didOpen: () => Swal.showLoading() });
    try {
        const res = await fetch(`${obtenerBaseUrl()}/ventas/ticket/${ventaId}`);
        const data = await res.json();
        
        if (data.error) throw new Error(data.error);

        let html = `<div class="table-responsive"><table class="table table-sm text-start align-middle">
        <thead class="table-light"><tr><th>Cant.</th><th>Producto</th><th class="text-end">Total</th></tr></thead><tbody>`;

        data.detalle_compra.forEach(d => {
            html += `<tr>
            <td class="fw-bold">${d.cantidad}</td>
            <td class="small">${d.nombre}</td>
            <td class="text-end fw-bold text-success">$${d.subtotal.toFixed(2)}</td>
        </tr>`;
        });

        html += `</tbody></table></div>
             <div class="text-end fw-bold fs-5 mt-2 text-danger border-top pt-2">Total Llevado: $${data.totales.total_a_pagar.toFixed(2)}</div>
             <div class="text-start mt-3 small text-muted bg-light p-2 rounded border">
                <i class="bi bi-clock"></i> Fecha: ${data.encabezado.fecha}<br>
                <i class="bi bi-person-badge"></i> Cajero: ${data.encabezado.cajero || data.encabezado.usuario || data.encabezado.vendedor || 'Caja Principal'}
             </div>`;

        Swal.fire({
            title: `<i class="bi bi-receipt text-primary"></i> Detalle Remito #${ventaId}`,
            html: html, 
            width: '500px', 
            showCloseButton: true, 
            confirmButtonText: '<i class="bi bi-check-circle"></i> Entendido', 
            confirmButtonColor: '#198754'
        });
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el detalle de la compra.', 'error');
    }
}

async function registrarPagoCliente() {
    const monto = parseFloat(document.getElementById('inputMontoPago').value);
    const metodo = document.getElementById('metodoPagoCliente').value;
    const afectaCaja = document.getElementById('checkAfectaCaja').checked; // <-- AHORA LEE EL SWITCH
    
    if(!monto || monto <= 0) return Swal.fire('Atención', 'Ingresá un monto válido para el pago.', 'warning');

    Swal.fire({ title: 'Procesando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        const res = await fetch(`${obtenerBaseUrl()}/clientes/pagar_deuda/${clienteSeleccionadoId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                monto_pago: monto,
                metodo_pago: metodo,
                observaciones: "Pago ingresado en Administración",
                usuario_id: 1,
                afecta_caja: afectaCaja // <-- LE MANDA LA VERDAD A PYTHON
            })
        });
        
        const data = await res.json();
        if(data.error) throw new Error(data.error);
        
        const clienteObj = clientesGlobales.find(c => c.id === clienteSeleccionadoId);
        const saldoRestante = clienteObj.saldo_actual_deudor - monto;

        await Swal.fire({title: '¡Pago Exitoso!', text: 'El saldo del cliente ha sido actualizado.', icon: 'success', timer: 1000, showConfirmButton: false});
        
        const imprimir = await Swal.fire({
            title: '¿Imprimir Recibo de Pago?',
            text: `El cliente entregó $${monto.toFixed(2)}`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonColor: '#198754',
            confirmButtonText: '<i class="bi bi-printer"></i> Sí, imprimir',
            cancelButtonText: 'No'
        });

        if(imprimir.isConfirmed) {
            imprimirReciboCtaCte(clienteObj.nombre_completo, monto, metodo, saldoRestante);
        }

        document.getElementById('inputMontoPago').value = '';
        document.getElementById('checkAfectaCaja').checked = false; // Lo apagamos por seguridad
        await cargarClientes();
        seleccionarCliente(clienteSeleccionadoId);
        
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}
// --- FUNCIONES A PRUEBA DE BALAS ---
function setValorSeguro(id, valor) {
    const elemento = document.getElementById(id);
    if (elemento) elemento.value = valor;
}

function abrirModalCliente() {
    clienteEditandoId = null;
    
    setValorSeguro('cliNombre', '');
    setValorSeguro('cliDni', ''); // <--- ERA cliDni
    setValorSeguro('cliIva', 'Consumidor Final');
    setValorSeguro('cliLimite', '50000');
    setValorSeguro('cliTel', '');
    setValorSeguro('cliDireccion', ''); 
    
    const titulo = document.getElementById('tituloModalCliente');
    if (titulo) titulo.innerHTML = '<i class="bi bi-person-plus"></i> Nuevo Cliente';
    
    if (modalClienteInstance) modalClienteInstance.show();
}

function abrirEditarCliente(id) {
    const cliente = clientesGlobales.find(c => c.id === id);
    if (!cliente) return;
    clienteEditandoId = id;
    
    setValorSeguro('cliNombre', cliente.nombre_completo || '');
    setValorSeguro('cliDni', cliente.cuit || ''); // <--- ERA cliDni
    setValorSeguro('cliIva', cliente.condicion_iva || 'Consumidor Final');
    setValorSeguro('cliLimite', cliente.limite_credito || '50000');
    setValorSeguro('cliTel', cliente.telefono_whatsapp || '');
    setValorSeguro('cliDireccion', cliente.direccion || '');
    
    const titulo = document.getElementById('tituloModalCliente');
    if (titulo) titulo.innerHTML = '<i class="bi bi-pencil"></i> Editar Cliente';
    
    if (modalClienteInstance) modalClienteInstance.show();
}

document.getElementById('modalEdicionCliente').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        guardarCliente();
    }
});

async function guardarCliente() {
    const payload = {
        nombre_completo: document.getElementById('cliNombre').value.trim(),
        cuit: document.getElementById('cliDni').value.trim(),
        condicion_iva: document.getElementById('cliIva').value,
        telefono_whatsapp: document.getElementById('cliTel').value.trim(),
        direccion: document.getElementById('cliDireccion').value.trim(),
        limite_credito: parseFloat(document.getElementById('cliLimite').value) || 50000
    };

    if (!payload.nombre_completo) {
        return Swal.fire({ target: document.getElementById('modalEdicionCliente'), title: 'Aviso', text: 'El nombre es obligatorio.', icon: 'warning' });
    }

    Swal.fire({ target: document.getElementById('modalEdicionCliente'), title: 'Guardando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        let res;
        if (clienteEditandoId) {
            res = await fetch(`${obtenerBaseUrl()}/clientes/actualizar/${clienteEditandoId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
        } else {
            res = await fetch(`${obtenerBaseUrl()}/clientes/registrar', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            }`);
        }

        const data = await res.json();
        if(data.error) throw new Error(data.error);

        Swal.fire({ title: '¡Guardado!', text: data.mensaje, icon: 'success', timer: 1500, showConfirmButton: false });
        modalClienteInstance.hide();
        cargarClientes(); 

    } catch (e) {
        Swal.fire({ target: document.getElementById('modalEdicionCliente'), title: 'Error', text: e.message, icon: 'error' });
    }
}

// --- UTILIDADES BLINDADAS CONTRA BOOTSTRAP ---
function cambiarPestana(id) {
    // 1. Limpiamos diseño de los botones
    document.querySelectorAll('#clientesTabs .nav-link').forEach(el => {
        el.classList.remove('active', 'text-primary');
        el.classList.add('text-secondary');
    });
    
    // 2. Apagamos TODOS los paneles (El truco es quitar el 'active')
    document.querySelectorAll('.tab-pane').forEach(el => {
        el.classList.add('d-none');
        el.classList.remove('active');
    });
    
    // 3. Prendemos el botón que tocamos
    const btn = document.querySelector(`button[onclick="cambiarPestana('${id}')"]`);
    if(btn) {
        btn.classList.add('active', 'text-primary');
        btn.classList.remove('text-secondary');
    }
    
    // 4. Prendemos el panel y le damos 'active' para que Bootstrap no lo oculte
    const tab = document.getElementById('tab-' + id);
    if(tab) {
        tab.classList.remove('d-none');
        tab.classList.add('active'); 
    }
    
    // 5. Forzamos la actualización de la lista de clientes
    filtrarClientesUI();
    const inputBuscar = document.getElementById('inputBuscarCliente');
    if(inputBuscar) inputBuscar.focus();
}

// --- MOTOR IMPRESIÓN RESUMEN DE CUENTA ---
async function imprimirResumenCuenta() {
    if (!clienteSeleccionadoId) return;
    const cliente = clientesGlobales.find(c => c.id === clienteSeleccionadoId);
    Swal.fire({ title: 'Generando Resumen...', didOpen: () => Swal.showLoading() });

    try {
        const res = await fetch(`${obtenerBaseUrl()}/clientes/historial/${clienteSeleccionadoId}`);
        const data = await res.json();
        
        // Invertimos la lista para que arranque del más viejo al más nuevo (como un resumen de banco real)
        const historial = data.movimientos ? data.movimientos.reverse() : [];
        
        let html = `
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Resumen de Cuenta</title>
        <style>
            body { font-family: Arial, sans-serif; font-size: 14px; margin: 40px; color: #333; }
            .header { border-bottom: 2px solid #1b365d; padding-bottom: 10px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th { background-color: #f8f9fa; border-bottom: 2px solid #ddd; padding: 10px; text-align: left; }
            td { border-bottom: 1px solid #eee; padding: 10px; }
            .debe { color: #dc3545; font-weight: bold; }
            .haber { color: #198754; font-weight: bold; }
            .text-end { text-align: right; }
        </style></head><body>
            <div class="header">
                <h2 style="margin:0; color:#1b365d;">Autoservicio 20 de Junio</h2>
                <p style="margin:5px 0 0 0; color:#666;">Resumen de Cuenta Corriente</p>
            </div>
            <div style="display:flex; justify-content: space-between; margin-bottom: 20px;">
                <div><strong>Cliente:</strong> ${cliente.nombre_completo}<br><strong>DNI/CUIT:</strong> ${cliente.cuit || 'S/N'}</div>
                <div class="text-end"><strong>Fecha Emisión:</strong> ${new Date().toLocaleDateString('es-AR')}<br>
                <strong>Saldo Final:</strong> ${cliente.saldo_actual_deudor > 0 ? '$'+cliente.saldo_actual_deudor.toFixed(2) : 'A Favor $'+Math.abs(cliente.saldo_actual_deudor).toFixed(2)}</div>
            </div>
            <table>
                <thead><tr><th>Fecha</th><th>Concepto</th><th class="text-end">Cargos (Debe)</th><th class="text-end">Pagos (Abono)</th><th class="text-end">Saldo Parcial</th></tr></thead>
                <tbody>
        `;

        let saldoAcumulado = 0;
        if(historial.length === 0) { html += `<tr><td colspan="5" style="text-align:center;">Sin movimientos</td></tr>`; }

        historial.forEach(m => {
            const esPago = m.tipo_movimiento === 'PAGO';
            const monto = parseFloat(m.monto) || 0;
            
            // Si es un pago, resta a la deuda. Si es otra cosa (ticket), suma a la deuda.
            if(esPago) saldoAcumulado -= monto; else saldoAcumulado += monto;
            
            html += `<tr>
                <td style="font-size:12px; color:#555;">${m.fecha_hora}</td>
                <td>${m.detalle}</td>
                <td class="text-end ${!esPago ? 'debe' : ''}">${!esPago ? '$'+monto.toFixed(2) : ''}</td>
                <td class="text-end ${esPago ? 'haber' : ''}">${esPago ? '$'+monto.toFixed(2) : ''}</td>
                <td class="text-end font-weight-bold" style="background:#fafafa;">$${saldoAcumulado.toFixed(2)}</td>
            </tr>`;
        });

        html += `</tbody></table>
            <div style="margin-top:40px; text-align:center; font-size:12px; color:#888;">Documento de control interno no válido como factura.</div>
        </body></html>`;

        Swal.close();
        let vent = window.open('', '_blank');
        vent.document.write(html); vent.document.close();
        setTimeout(() => { vent.print(); }, 500);

    } catch(e) { Swal.fire('Error', 'No se pudo generar el resumen.', 'error'); }
}

// ==========================================
// HERRAMIENTAS AVANZADAS: RECARGOS Y RECÁLCULOS
// ==========================================

async function aplicarRecargoManual() {
    if (!clienteSeleccionadoId) return;

    const { value: formValues } = await Swal.fire({
        title: 'Aplicar Recargo / Mora',
        html: `
            <input id="swal-recargo-monto" type="number" class="swal2-input" placeholder="Monto a sumar ($)">
            <input id="swal-recargo-motivo" type="text" class="swal2-input" placeholder="Concepto (Ej: Mora 10 días)" value="Recargo por Mora">
        `,
        focusConfirm: false, showCancelButton: true, confirmButtonText: 'Aplicar', confirmButtonColor: '#dc3545',
        preConfirm: () => {
            const monto = document.getElementById('swal-recargo-monto').value;
            const motivo = document.getElementById('swal-recargo-motivo').value;
            if (!monto || monto <= 0) { Swal.showValidationMessage('Ingrese un monto mayor a 0'); return false; }
            if (!motivo) { Swal.showValidationMessage('Especifique el concepto'); return false; }
            return { monto: parseFloat(monto), motivo: motivo };
        }
    });

    if (formValues) {
        Swal.fire({ title: 'Aplicando...', didOpen: () => Swal.showLoading() });
        try {
            await fetch(`${obtenerBaseUrl()}/clientes/aplicar_recargo/${clienteSeleccionadoId}`, {
                method: 'PUT', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ monto: formValues.monto, motivo: formValues.motivo, usuario_id: 1 })
            });
            await cargarClientes(); seleccionarCliente(clienteSeleccionadoId);
            Swal.fire('¡Aplicado!', 'La deuda se incrementó correctamente.', 'success');
        } catch(e) { Swal.fire('Error', 'No se pudo aplicar el recargo', 'error'); }
    }
}

async function recalcularDeudaInflacion() {
    if (!clienteSeleccionadoId) return;
    
    Swal.fire({ title: 'Analizando tickets...', text: 'Calculando precios actuales de góndola...', didOpen: () => Swal.showLoading() });

    try {
        const res = await fetch(`${obtenerBaseUrl()}/clientes/simular_actualizacion/${clienteSeleccionadoId}`);
        const data = await res.json();
        
        if (data.error) return Swal.fire('Aviso', data.error, 'info');
        if (data.diferencia <= 0) return Swal.fire('Al día', 'Los productos que debe no han sufrido aumentos de precio.', 'success');

        const confirm = await Swal.fire({
            title: 'Actualización de Precios',
            html: `
                El sistema detectó aumentos en los productos que el cliente se llevó fiados.<br><br>
                Deuda Histórica: <b>$${data.deuda_vieja.toFixed(2)}</b><br>
                Deuda Actualizada: <b class="text-danger fs-4">$${data.deuda_nueva.toFixed(2)}</b><br><br>
                <span class="text-muted small">Diferencia a aplicar: $${data.diferencia.toFixed(2)}</span>
            `,
            icon: 'warning', showCancelButton: true, confirmButtonColor: '#0d6efd', confirmButtonText: 'Sí, actualizar deuda', cancelButtonText: 'Cancelar'
        });

        if (confirm.isConfirmed) {
            Swal.fire({ title: 'Actualizando...', didOpen: () => Swal.showLoading() });
            await fetch(`${obtenerBaseUrl()}/clientes/aplicar_recargo/${clienteSeleccionadoId}`, {
                method: 'PUT', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ monto: data.diferencia, motivo: "Ajuste por Inflación (Actualización a precio de góndola)", usuario_id: 1 })
            });
            await cargarClientes(); seleccionarCliente(clienteSeleccionadoId);
            Swal.fire('¡Actualizado!', 'La cuenta corriente ahora refleja los precios de hoy.', 'success');
        }
    } catch(e) { Swal.fire('Error', 'No se pudo calcular la inflación', 'error'); }
}

// ==========================================
// IMPRESIÓN DEL RECIBO DE PAGO (TICKET 80mm)
// ==========================================
function imprimirReciboCtaCte(cliente, montoPagado, metodo, saldoRestante) {
    let fechaActual = `${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;

    let html = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Recibo de Pago</title>
    <style>
        @page { margin: 0; }
        body { font-family: Arial, Helvetica, sans-serif; font-size: 13px; font-weight: 600; color: #000; margin: 0; padding: 2mm 4mm; width: 72mm; -webkit-font-smoothing: none; text-rendering: crispEdges; }
        .center { text-align: center; } .right { text-align: right; } .left { text-align: left; } .bold { font-weight: bold; }
        .divisor { border-top: 1px dashed #000; margin: 6px 0; }
        .divisor-doble { border-top: 2px solid #000; border-bottom: 2px solid #000; height: 2px; margin: 6px 0; }
        .fila { display: flex; justify-content: space-between; margin-bottom: 4px; }
    </style>
    </head><body>
        <div class="center bold" style="font-size: 16px;">AUTOSERVICIO 20 DE JUNIO</div>
        <div class="center" style="font-size: 14px; margin-top: 4px;">RECIBO DE PAGO</div>
        <div class="center" style="font-size: 11px;">COPIA CLIENTE</div>
        
        <div class="divisor-doble"></div>
        <div class="fila"><span>Fecha:</span> <span>${fechaActual}</span></div>
        <div class="fila"><span>Cliente:</span> <span class="right">${cliente}</span></div>
        <div class="divisor-doble"></div>
        
        <div class="center bold" style="font-size: 15px; margin: 10px 0;">IMPORTE ABONADO</div>
        <div class="center bold" style="font-size: 26px; border: 1px solid #000; padding: 5px; border-radius: 5px;">$ ${montoPagado.toFixed(2)}</div>
        
        <div class="divisor" style="margin-top: 15px;"></div>
        <div class="fila"><span>Medio de Pago:</span> <span>${metodo}</span></div>
        <div class="fila mt-2" style="font-size: 14px;">
            <span>SALDO RESTANTE:</span> 
            <span class="bold ${saldoRestante <= 0 ? '' : ''}">${saldoRestante <= 0 ? '$ 0.00' : '$ ' + saldoRestante.toFixed(2)}</span>
        </div>
        
        <br><br><br>
        <div class="center divisor" style="width: 70%; margin: 0 auto;"></div>
        <div class="center small">Firma y Aclaración (Cajero)</div>
        
        <div class="center" style="font-size: 10px; margin-top:20px;">Comprobante no válido como factura.</div>
        <div style="margin-bottom: 25mm;"></div>
    </body></html>
    `;

    let vent = window.open('', '_blank', 'width=300,height=500');
    vent.document.write(html); vent.document.close(); vent.focus();
    setTimeout(() => { vent.print(); vent.close(); }, 500);
}