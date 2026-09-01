// frontend/js/app_cajas.js
async function apiFetch(recurso, config = {}) {
    if (!config.headers) config.headers = {};
    const token = localStorage.getItem('token') || localStorage.getItem('token_pos');
    if (token) config.headers['Authorization'] = `Bearer ${token}`;
    
    const respuesta = await fetch(recurso, config);
    if (respuesta.status === 401) {
        console.warn("Sesión expirada o sin permisos (401)");
        localStorage.clear();
        window.location.href = 'index.html'; 
        throw new Error("Acceso denegado (401)");
    }
    return respuesta;
}

function cambiarPestana(id, evento) {
    document.querySelectorAll('#cajaTabs .nav-link').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    evento.target.classList.add('active');
    document.getElementById('tab-' + id).classList.add('active');
}

async function cargarDatosEnVivo() {
    cargarMonitor();
    cargarEmpleados();
    cargarCajasFisicas();
}

async function cargarMonitor() {
    const contenedor = document.getElementById('contenedorMonitorVivo');

    try {
        const response = await apiFetch(`${obtenerBaseUrl()}/caja/monitor_vivo`);
        const data = await response.json();

        if (data.error) throw new Error(data.error);

        const turnos = data.turnos_vivos;
        contenedor.innerHTML = '';

        if (turnos.length === 0) {
            contenedor.innerHTML = `
                <div class="col-12 text-center text-muted py-5">
                    <i class="bi bi-safe display-1 mb-3 d-block opacity-50"></i>
                    <h4>No hay ninguna caja abierta en este momento.</h4>
                    <p>El mostrador está cerrado.</p>
                </div>
            `;
            return;
        }

        turnos.forEach(t => {
            // Formatear la fecha para que se lea linda
            let fecha = new Date(t.fecha_hora_apertura).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

            contenedor.innerHTML += `
                <div class="col-md-6 col-lg-4">
                    <div class="card border-success h-100 shadow-sm">
                        <div class="card-header bg-success text-white fw-bold d-flex justify-content-between align-items-center">
                            <span><i class="bi bi-display"></i> CAJA ${t.caja_id}</span>
                            <span class="badge bg-light text-success"><i class="bi bi-circle-fill text-success" style="font-size:0.5rem; vertical-align: middle;"></i> ONLINE</span>
                        </div>
                        <div class="card-body">
                            <h5 class="fw-bold mb-0 text-primary">${t.cajero || "Cajero Desconocido"}</h5>
                            <small class="text-muted d-block mb-3">Abrió a las: ${fecha}</small>
                            
<ul class="list-group list-group-flush mb-3 small">
                                <li class="list-group-item d-flex justify-content-between px-0">
                                    <span>Fondo Inicial:</span> <b>$${t.monto_inicial.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 text-success">
                                    <span>Ventas Efectivo:</span> <b>+$${t.ventas_efectivo.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 text-success">
                                    <span>Otros Ingresos:</span> <b>+$${t.ingresos.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 text-danger">
                                    <span>Retiros/Gastos:</span> <b>-$${t.retiros.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 bg-light mt-2 border-top border-secondary">
                                    <span class="text-muted"><i class="bi bi-credit-card"></i> Tarjetas:</span> <b class="text-muted">$${t.ventas_tarjeta.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 bg-light">
                                    <span class="text-muted"><i class="bi bi-qr-code-scan"></i> Billeteras Virtuales:</span> <b class="text-muted">$${t.ventas_virtual.toFixed(2)}</b>
                                </li>
                            </ul>
                            
                            <div class="p-3 bg-light rounded text-center border">
                                <span class="d-block text-muted fw-bold small text-uppercase mb-1">Efectivo Físico en Cajón</span>
                                <h3 class="fw-bold text-success mb-0">$${t.total_esperado.toFixed(2)}</h3>
                            </div>
                            <div class="d-flex gap-2 mt-3">
                                <button class="btn btn-info w-100 fw-bold shadow-sm" onclick="auditarTurno(${t.turno_id})">
                                    <i class="bi bi-search"></i> AUDITAR
                                </button>
                                <button class="btn btn-outline-danger w-100 fw-bold shadow-sm" onclick="forzarCierreRemoto(${t.turno_id})">
                                    <i class="bi bi-x-octagon-fill"></i> CERRAR
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

    } catch (e) {
        contenedor.innerHTML = `<div class="col-12 text-center text-danger py-4 fw-bold">Error de conexión con el servidor.</div>`;
    }
}

// --- MOTOR DE CIERRE DE EMERGENCIA REMOTO ---
async function forzarCierreRemoto(turnoId) {
    const confirm = await Swal.fire({
        title: '¿Forzar Cierre Remoto?',
        text: "Vas a cerrar este turno desde la oficina. Se declararán $0 de efectivo físico en el conteo manual (podrás ajustarlo en los reportes luego). Usar solo si la caja quedó trabada.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonText: 'Cancelar',
        confirmButtonText: 'Sí, forzar cierre'
    });

    if (confirm.isConfirmed) {
        Swal.fire({ title: 'Cerrando caja remotamente...', didOpen: () => Swal.showLoading() });
        try {
            const res = await apiFetch(`${obtenerBaseUrl()}/caja/cerrar`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    turno_id: turnoId,
                    monto_final_declarado: 0 // Declaramos 0 porque el cajero no hizo el conteo manual
                })
            });

            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || "Fallo al cerrar remotamente");

            Swal.fire('¡Cerrada!', 'La caja fue destrabada y cerrada exitosamente.', 'success');
            cargarDatosEnVivo(); // Refresca el monitor y desaparece la caja
        } catch (e) {
            Swal.fire('Error', e.message, 'error');
        }
    }
}

// --- MOTOR DE AUDITORÍA EN TIEMPO REAL ---
async function auditarTurno(turnoId) {
    document.getElementById('audiTurnoId').innerText = turnoId + " - Cargando...";
    const tbody = document.getElementById('tablaAuditoriaBody');
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted py-5"><div class="spinner-border text-info mb-2"></div><br>Reconstruyendo línea de tiempo...</td></tr>';
    
    // MAGIA: Si el modal de historial de ayer está abierto, lo ocultamos para que no se pisen las ventanas
    const modalHistorico = bootstrap.Modal.getInstance(document.getElementById('modalVentasHistoricas'));
    if (modalHistorico) modalHistorico.hide();

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAuditoriaTurno')).show();

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/caja/auditoria/${turnoId}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // ¡ACÁ ESTÁ EL NOMBRE DEL CAJERO!
        document.getElementById('audiTurnoId').innerText = `${turnoId} - ${data.cajero}`;

        tbody.innerHTML = '';
        if (data.linea_tiempo.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-muted py-4">No hay registros para este turno.</td></tr>';
            return;
        }

        data.linea_tiempo.forEach(item => {
            let colorFila = '';
            let colorMonto = 'text-dark';
            let signo = '';
            let detalleAdicional = item.detalle ? `<br><small class="text-muted">${item.detalle}</small>` : '';

            if (item.tipo === 'VENTA') {
                colorMonto = 'text-success fw-bold';
                signo = '+';
            } else if (item.tipo === 'VENTA ANULADA') {
                colorFila = 'bg-light text-muted text-decoration-line-through';
                colorMonto = 'text-muted';
            } else if (item.tipo === 'INGRESO') {
                colorMonto = 'text-primary fw-bold';
                signo = '+';
            } else if (item.tipo === 'RETIRO') {
                colorMonto = 'text-danger fw-bold';
                signo = '-';
            } else if (item.tipo === 'APERTURA') {
                colorMonto = 'text-success fw-bold fs-6';
                signo = '$';
            }

            tbody.innerHTML += `
                <tr class="${colorFila}">
                    <td class="align-middle text-muted">${item.hora}</td>
                    <td class="text-start align-middle">
                        <span class="fw-bold">${item.accion}</span>
                        ${detalleAdicional}
                    </td>
                    <td class="align-middle"><span class="badge border text-dark">${item.metodo || '-'}</span></td>
                    <td class="text-end pe-3 align-middle ${colorMonto}">${signo}$${item.monto.toLocaleString('es-AR', {minimumFractionDigits: 2})}</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-danger fw-bold py-4">Error: ${e.message}</td></tr>`;
    }
}

async function buscarVentasPorFecha() {
    const fecha = document.getElementById('inputFechaHistorica').value;
    if (!fecha) return Swal.fire('Aviso', 'Elegí una fecha primero.', 'warning');

    const tbody = document.getElementById('tablaVentasHistoricas');
    const totalVisor = document.getElementById('totalDiaHistorico');
    const desglose = document.getElementById('desgloseHistorico');
    
    // Capturamos los contenedores nuevos
    const contenedorTurnos = document.getElementById('contenedorTurnosHistoricos');
    const listaTurnos = document.getElementById('listaTurnosHistoricos');
    
    tbody.innerHTML = '<tr><td colspan="8" class="py-4"><div class="spinner-border text-warning"></div> Buscando...</td></tr>';
    desglose.classList.add('d-none');
    if (contenedorTurnos) contenedorTurnos.classList.add('d-none');
    
    try {
        // 1. Buscamos los TURNOS de ese día y dibujamos las tarjetas
        if (contenedorTurnos && listaTurnos) {
            const resTurnos = await apiFetch(`${obtenerBaseUrl()}/caja/turnos_por_fecha?fecha=${fecha}`);
            const dataTurnos = await resTurnos.json();
            
            if (dataTurnos.turnos && dataTurnos.turnos.length > 0) {
                listaTurnos.innerHTML = '';
                dataTurnos.turnos.forEach(t => {
                    let estadoBadge = t.estado_turno === 'CERRADO' ? '<span class="badge bg-secondary">Cerrado</span>' : '<span class="badge bg-success">Abierto</span>';
                    let difBadge = '';
                    if (t.estado_turno === 'CERRADO') {
                        if (t.diferencia < 0) difBadge = `<span class="badge bg-danger rounded-pill"><i class="bi bi-arrow-down-short"></i> Faltante: $${Math.abs(t.diferencia).toFixed(2)}</span>`;
                        else if (t.diferencia > 0) difBadge = `<span class="badge bg-info text-dark rounded-pill"><i class="bi bi-arrow-up-short"></i> Sobrante: $${t.diferencia.toFixed(2)}</span>`;
                        else difBadge = `<span class="badge bg-success rounded-pill">Caja Exacta</span>`;
                    }

                    listaTurnos.innerHTML += `
                        <div class="card border-primary shadow-sm" style="min-width: 260px;">
                            <div class="card-body p-3">
                                <h6 class="fw-bold mb-1">Turno #${t.turno_id} ${estadoBadge}</h6>
                                <div class="small text-muted mb-2"><i class="bi bi-person-badge"></i> ${t.cajero || 'Desconocido'}</div>
                                <div class="mb-3">${difBadge}</div>
                                <button class="btn btn-sm btn-info w-100 fw-bold shadow-sm" onclick="auditarTurno(${t.turno_id})"><i class="bi bi-search"></i> Auditar Turno</button>
                            </div>
                        </div>
                    `;
                });
                contenedorTurnos.classList.remove('d-none');
            }
        }

        // 2. Buscamos los TICKETS individuales (Tu código original intacto)
        const res = await apiFetch(`${obtenerBaseUrl()}/ventas/por_fecha?fecha=${fecha}`);
        const data = await res.json();
        
        if (!res.ok) {
            let errorOculto = data.detail ? JSON.stringify(data.detail) : 'Ruta no encontrada';
            throw new Error(data.error || errorOculto);
        }
        if (data.error) throw new Error(data.error);

        tbody.innerHTML = '';
        let sumaTotal = 0, sumaEfectivo = 0, sumaVirtual = 0, sumaFiado = 0;

        if (!data.ventas || data.ventas.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-muted py-4">No hay ventas registradas en este día.</td></tr>';
            totalVisor.innerText = '$0.00';
            return;
        }

        data.ventas.forEach(v => {
            const esAnulada = v.estado === 'ANULADA';
            const colorFila = esAnulada ? 'text-muted text-decoration-line-through bg-light' : '';
            const badge = esAnulada ? '<span class="badge bg-danger">Anulada</span>' : '<span class="badge bg-success">Ok</span>';
            
            if (!esAnulada) {
                sumaTotal += v.total_venta;
                let metodo = (v.metodo_pago || "").toUpperCase();
                if (metodo.includes('EFECTIVO')) sumaEfectivo += v.total_venta;
                else if (metodo.includes('CUENTA CORRIENTE') || metodo.includes('FIADO')) sumaFiado += v.total_venta;
                else sumaVirtual += v.total_venta; 
            }

            const numTicket = v.numero_ticket || v.id;
            let clienteLimpio = v.cliente || 'Consumidor Final';
            clienteLimpio = clienteLimpio.split(' Debe:')[0].split(' A favor:')[0].trim();

            const btnOjo = `<button class="btn btn-sm btn-outline-info py-0 me-1" onclick="verDetalleTicketHistorico(${v.id}); event.stopPropagation();" title="Ver Detalle"><i class="bi bi-eye"></i></button>`;
            const btnImprimir = `<button class="btn btn-sm btn-outline-secondary py-0" onclick="imprimirTicketHistorico(${v.id}); event.stopPropagation();" title="Imprimir Copia"><i class="bi bi-printer"></i></button>`;

            tbody.innerHTML += `
                <tr class="fila-historica ${colorFila}" style="cursor:pointer;" ondblclick="verDetalleTicketHistorico(${v.id})" title="Doble clic para ver detalle">
                    <td>${v.fecha_hora.split(' ')[1]}</td>
                    <td class="fw-bold">${numTicket}</td>
                    <td>${clienteLimpio}</td>
                    <td>${v.metodo_pago}</td>
                    <td>${v.cajero_nombre || '-'}</td>
                    <td class="text-end fw-bold pe-3">$${v.total_venta.toLocaleString('es-AR', {minimumFractionDigits: 2})}</td>
                    <td>${badge}</td>
                    <td>${btnOjo} ${btnImprimir}</td>
                </tr>
            `;
        });

        totalVisor.innerText = `$${sumaTotal.toLocaleString('es-AR', {minimumFractionDigits: 2})}`;
        document.getElementById('badgeEfectivo').innerText = `Efec: $${sumaEfectivo.toLocaleString('es-AR', {minimumFractionDigits: 2})}`;
        document.getElementById('badgeVirtual').innerText = `Virt: $${sumaVirtual.toLocaleString('es-AR', {minimumFractionDigits: 2})}`;
        document.getElementById('badgeFiado').innerText = `Cta: $${sumaFiado.toLocaleString('es-AR', {minimumFractionDigits: 2})}`;
        desglose.classList.remove('d-none');

    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-danger fw-bold py-4">Error: ${e.message}</td></tr>`;
        totalVisor.innerText = '$0.00';
    }
}

// LA MEJORA 2: Función de filtro instantáneo
function filtrarTablaHistorica() {
    const texto = document.getElementById('inputFiltroHistorico').value.toLowerCase();
    const filas = document.querySelectorAll('#tablaVentasHistoricas .fila-historica');

    filas.forEach(fila => {
        // Lee todo el texto de la fila (cliente, ticket, monto) y oculta lo que no coincide
        const contenido = fila.textContent.toLowerCase();
        fila.style.display = contenido.includes(texto) ? '' : 'none';
    });
}

// --- EL OJO: Ver Detalle del Ticket ---
async function verDetalleTicketHistorico(ventaId) {
    Swal.fire({ title: 'Cargando detalle...', didOpen: () => Swal.showLoading() });
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/ventas/ticket/${ventaId}`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        let html = `<div class="table-responsive"><table class="table table-sm text-start align-middle">
            <thead class="table-light"><tr><th>Cant.</th><th>Producto</th><th class="text-end">Total</th></tr></thead><tbody>`;

        data.detalle_compra.forEach(d => {
            html += `<tr>
                <td class="fw-bold">${d.cantidad}</td>
                <td class="small">${d.nombre}</td>
                <td class="text-end">$${d.subtotal.toFixed(2)}</td>
            </tr>`;
        });

        html += `</tbody></table></div>
                 <div class="text-end fw-bold fs-5 mt-2 text-success">Total Pagado: $${data.totales.total_a_pagar.toFixed(2)}</div>`;

        // El modal es tan inteligente que te permite imprimir directamente desde adentro
        Swal.fire({
            title: `<i class="bi bi-receipt text-primary"></i> Detalle del Ticket #${data.encabezado.numero_ticket || ventaId}`,
            html: html, width: '500px', showCloseButton: true, showCancelButton: true,
            confirmButtonText: '<i class="bi bi-printer"></i> Imprimir Copia',
            cancelButtonText: 'Cerrar',
            confirmButtonColor: '#1b365d'
        }).then((result) => {
            if (result.isConfirmed) {
                imprimirTicketHistorico(ventaId);
            }
        });
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el detalle del ticket.', 'error');
    }
}

// --- LA IMPRESORA: Generar ticket de 80mm desde Admin ---
async function imprimirTicketHistorico(ticketId) {
    try {
        Swal.fire({ title: 'Preparando impresión...', timer: 1000, showConfirmButton: false, didOpen: () => Swal.showLoading() });

        const res = await apiFetch(`${obtenerBaseUrl()}/ventas/ticket/${ticketId}`);
        const ticket = await res.json();

        // Buscamos los datos de tu negocio en la memoria o ponemos genéricos
        const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: "AUTOSERVICIO", direccion: "", cuit: "" };

        if (ticket.error) throw new Error(ticket.error);

        let html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    @page { margin: 0; }
                    body { font-family: Arial, sans-serif; font-size: 12px; font-weight: 600; color: #000; margin: 0; padding: 2mm 4mm; width: 72mm; }
                    .center { text-align: center; } .right { text-align: right; } .left { text-align: left; } .bold { font-weight: bold; }
                    .divisor { border-top: 1px dashed #000; margin: 4px 0; }
                    .divisor-doble { border-top: 2px solid #000; border-bottom: 2px solid #000; height: 2px; margin: 4px 0; }
                    table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 5px 0; }
                    th, td { text-align: left; padding: 2px 0; vertical-align: top; }
                </style>
            </head>
            <body>
                <div class="center bold" style="font-size: 16px;">${config.nombre_negocio.toUpperCase()}</div>
                <div class="center bold" style="font-size: 11px; border: 1px solid #000;">*** COPIA DEL TICKET ***</div>
                <div class="divisor-doble"></div>
                
                <div class="left">Ticket N°: ${ticket.encabezado.numero_ticket || ticketId}</div>
                <div class="left">Fecha: ${ticket.encabezado.fecha}</div>
                <div class="left">Cajero: ${ticket.encabezado.cajero || '-'}</div>
                <div class="left">Cliente: ${ticket.encabezado.cliente || 'Consumidor Final'}</div>
                
                <div class="divisor-doble"></div>
                
                <table>
                    <tr><th style="width: 15%;">CANT</th><th style="width: 50%;">ARTICULO</th><th class="right">TOTAL</th></tr>
                    <tr><td colspan="3"><div class="divisor"></div></td></tr>
        `;

        ticket.detalle_compra.forEach(item => {
            html += `<tr><td class="left">${item.cantidad}</td><td>${item.nombre}</td><td class="right">$${item.subtotal.toFixed(2)}</td></tr>`;
        });

        html += `
                    <tr><td colspan="3"><div class="divisor"></div></td></tr>
                </table>
                <div style="display: flex; justify-content: space-between;" class="bold">
                    <span>TOTAL:</span>
                    <span>$ ${ticket.totales.total_a_pagar.toFixed(2)}</span>
                </div>
                <div class="divisor-doble"></div>
                <div class="left">Forma de Pago: ${ticket.totales.metodo_pago}</div>
                
                <div style="margin-bottom: 25mm;"></div> 
            </body>
            </html>
        `;

        let ventanaPrint = window.open('', '_blank', 'width=300,height=500');
        ventanaPrint.document.write(html);
        ventanaPrint.document.close();
        ventanaPrint.focus();

        setTimeout(() => {
            ventanaPrint.print();
            ventanaPrint.close();
        }, 500);

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function cargarEmpleados() {
    const tbody = document.getElementById('tablaEmpleadosBody');
    try {
        const response = await apiFetch(`${obtenerBaseUrl()}/usuarios/listar`);
        const data = await response.json();

        if (data.error) throw new Error(data.error);

        tbody.innerHTML = '';
        data.usuarios.forEach(u => {
            let badgeRol = 'bg-secondary';
            if (u.rol === 'ADMIN') badgeRol = 'bg-danger';
            if (u.rol === 'ENCARGADO') badgeRol = 'bg-warning text-dark';
            if (u.rol === 'CAJERO') badgeRol = 'bg-info text-dark';

            // PARCHE: Botones de Lápiz y Basurero
            // PARCHE: Botones de Lápiz y Basurero, o Botón de Restaurar
            // PARCHE: Botones de Editar, Borrar y el nuevo de Imprimir Credencial
            let botonesAccion = u.estado === 'ACTIVO'
                ? `
                   <button class="btn btn-sm btn-outline-dark py-0 me-1" title="Imprimir Credencial" onclick="imprimirCredencial('${u.nombre_completo}', '${u.rol}', '${u.codigo_barras_credencial}')"><i class="bi bi-printer"></i></button>
                   <button class="btn btn-sm btn-outline-primary py-0" title="Editar" onclick="abrirEditarEmpleado(${u.id}, '${u.nombre_completo}', '${u.rol}', '${u.codigo_barras_credencial}')"><i class="bi bi-pencil"></i></button>
                   <button class="btn btn-sm btn-outline-danger py-0 ms-1" title="Dar de baja" onclick="darDeBajaEmpleado(${u.id}, '${u.nombre_completo}')"><i class="bi bi-trash"></i></button>
                  `
                : `<button class="btn btn-sm btn-success py-0 fw-bold shadow-sm" onclick="reactivarEmpleado(${u.id}, '${u.nombre_completo}')"><i class="bi bi-arrow-counterclockwise"></i> Restaurar</button>`;
            let badgeEstado = u.estado === 'ACTIVO' ? `<span class="badge bg-success">Activo</span>` : `<span class="badge bg-secondary">Inactivo</span>`;
            let claseFila = u.estado === 'ACTIVO' ? '' : 'opacity-50 bg-light';

            tbody.innerHTML += `
                <tr class="${claseFila}">
                    <td class="text-muted fw-bold">#${u.id}</td>
                    <td class="fw-bold">${u.nombre_completo}</td>
                    <td><span class="badge ${badgeRol}">${u.rol}</span></td>
                    <td class="text-muted"><i class="bi bi-upc-scan"></i> ${u.codigo_barras_credencial || 'Sin tarjeta'}</td>
                    <td class="text-center">${botonesAccion}</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Error cargando usuarios</td></tr>`;
    }
}

// Limpiar el modal cuando tocamos "NUEVO EMPLEADO"
document.querySelector('[data-bs-target="#modalNuevoEmpleado"]').addEventListener('click', () => {
    document.getElementById('empId').value = '';
    document.getElementById('empNombre').value = '';
    document.getElementById('empRol').value = 'CAJERO';
    document.getElementById('empPin').value = '';
    document.getElementById('empCredencial').value = '';
    document.querySelector('#modalNuevoEmpleado .modal-title').innerHTML = '<i class="bi bi-person-badge"></i> Alta de Empleado';
});

// Función para llenar el modal y abrirlo en modo "EDICIÓN"
function abrirEditarEmpleado(id, nombre, rol, credencial) {
    document.getElementById('empId').value = id;
    document.getElementById('empNombre').value = nombre;
    document.getElementById('empRol').value = rol;
    document.getElementById('empPin').value = ''; // Lo dejamos vacío por seguridad
    document.getElementById('empCredencial').value = credencial === 'null' ? '' : credencial;

    document.querySelector('#modalNuevoEmpleado .modal-title').innerHTML = '<i class="bi bi-pencil-square"></i> Editar Empleado';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalNuevoEmpleado')).show();
}

async function guardarEmpleado() {
    const idEditando = document.getElementById('empId').value; // Si tiene número, estamos editando
    const nombre = document.getElementById('empNombre').value.trim();
    const rol = document.getElementById('empRol').value;
    const pin = document.getElementById('empPin').value.trim();
    const credencial = document.getElementById('empCredencial').value.trim() || `CRED-${Math.floor(Math.random() * 10000)}`;

    // EL PARCHE: Si es nuevo exige PIN, si estamos editando lo deja pasar en blanco
    if (!nombre) return Swal.fire('Atención', 'El nombre es obligatorio', 'warning');
    if (idEditando === '' && !pin) return Swal.fire('Atención', 'El PIN es obligatorio para un empleado nuevo', 'warning');

    try {
        let url = `${obtenerBaseUrl()}/usuarios/crear`;
        let metodo = 'POST';

        // Si estamos editando, cambiamos la ruta y el método
        if (idEditando !== '') {
            url = `${obtenerBaseUrl()}/usuarios/actualizar/${idEditando}`;
            metodo = 'PUT';
        }

        const res = await apiFetch(url, {
            method: metodo,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre_completo: nombre, rol: rol, codigo_barras_credencial: credencial, pin_secreto: pin })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.detail || data.error || "Error al guardar");

        Swal.fire('¡Éxito!', 'Empleado guardado correctamente.', 'success');
        bootstrap.Modal.getInstance(document.getElementById('modalNuevoEmpleado')).hide();
        cargarEmpleados();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// Función para echar / bloquear a un empleado
async function darDeBajaEmpleado(id, nombre) {
    const confirm = await Swal.fire({
        title: '¿Dar de baja?',
        text: `El usuario ${nombre} ya no podrá entrar al sistema.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonText: 'Cancelar',
        confirmButtonText: 'Sí, bloquear acceso'
    });

    if (confirm.isConfirmed) {
        try {
            await apiFetch(`${obtenerBaseUrl()}/usuarios/baja/${id}`, { method: 'DELETE' });
            Swal.fire('Bloqueado', 'Empleado dado de baja.', 'success');
            cargarEmpleados();
        } catch (e) {
            Swal.fire('Error', 'No se pudo dar de baja.', 'error');
        }
    }
}
// Función para devolverle el acceso a un empleado
async function reactivarEmpleado(id, nombre) {
    const confirm = await Swal.fire({
        title: '¿Reactivar empleado?',
        text: `Devolver acceso al sistema a ${nombre}.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#198754',
        cancelButtonText: 'Cancelar',
        confirmButtonText: 'Sí, reactivar'
    });

    if (confirm.isConfirmed) {
        try {
            await apiFetch(`${obtenerBaseUrl()}/usuarios/alta/${id}`, { method: 'PUT' });
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Usuario reactivado', showConfirmButton: false, timer: 1500 });
            cargarEmpleados();
        } catch (e) {
            Swal.fire('Error', 'No se pudo reactivar.', 'error');
        }
    }
}

// Función para generar la credencial en PDF
function imprimirCredencial(nombre, rol, codigo) {
    if (!codigo || codigo === 'null' || codigo === '') return Swal.fire('Error', 'Este empleado no tiene un código de credencial asignado.', 'warning');

    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Credencial ${nombre}</title>
            <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.0/dist/JsBarcode.all.min.js"></script>
            <style>
                body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f0f0f0; font-family: sans-serif; }
                .credencial { width: 54mm; height: 86mm; background-color: white; border: 2px solid #333; border-radius: 10px; display: flex; flex-direction: column; align-items: center; padding: 15px; box-sizing: border-box; box-shadow: 0 4px 8px rgba(0,0,0,0.2); }
                .logo { font-weight: 900; font-size: 14px; text-transform: uppercase; color: #1b365d; text-align: center; margin-bottom: 20px; }
                .nombre { font-size: 18px; font-weight: bold; text-align: center; line-height: 1.1; margin-bottom: 5px; }
                .rol { font-size: 12px; color: #666; font-weight: bold; text-transform: uppercase; margin-bottom: auto; }
                .barcode-container { margin-top: 15px; }
                svg { width: 100%; height: 60px; }
            </style>
        </head>
        <body>
            <div class="credencial">
                <div class="logo">Autoservicio<br>20 de Junio</div>
                <div class="nombre">${nombre}</div>
                <div class="rol">${rol}</div>
                <div class="barcode-container">
                    <svg id="barcode"></svg>
                </div>
            </div>
            <script>
                JsBarcode("#barcode", "${codigo}", { format: "CODE128", width: 2, height: 50, displayValue: true, fontSize: 14, margin: 0 });
                setTimeout(() => { window.print(); }, 500);
            </script>
        </body>
        </html>
    `;

    let vent = window.open('', '_blank', 'width=400,height=600');
    vent.document.write(html);
    vent.document.close();
}

// ========================================================
// GESTIÓN DE HARDWARE (TERMINALES)
// ========================================================
async function cargarCajasFisicas() {
    const tbody = document.getElementById('tablaTerminalesBody');
    try {
        const response = await apiFetch(`${obtenerBaseUrl()}/caja/cajas_fisicas/admin_listado`);
        const data = await response.json();

        if (data.error) throw new Error(data.error);

        tbody.innerHTML = '';
        data.cajas.forEach(c => {
            let badgeEstado = c.activa ? '<span class="badge bg-success">Operativa</span>' : '<span class="badge bg-danger">Apagada / Rota</span>';
            let badgeAcceso = c.solo_admin ? '<span class="badge bg-dark"><i class="bi bi-lock-fill"></i> Solo Admin</span>' : '<span class="badge bg-info text-dark">Todo el Personal</span>';
            let btnToggle = c.activa 
                ? `<button class="btn btn-sm btn-outline-danger fw-bold py-0" onclick="toggleTerminal(${c.id})" title="Desactivar PC"><i class="bi bi-power"></i> Apagar</button>`
                : `<button class="btn btn-sm btn-success fw-bold py-0" onclick="toggleTerminal(${c.id})" title="Activar PC"><i class="bi bi-check-circle"></i> Habilitar</button>`;

            tbody.innerHTML += `
                <tr class="${c.activa ? '' : 'bg-light opacity-75'}">
                    <td class="fw-bold fs-5 text-primary">${c.id}</td>
                    <td class="text-start fw-bold">${c.nombre}</td>
                    <td>${badgeAcceso}</td>
                    <td>${badgeEstado}</td>
                    <td>${btnToggle}</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Error cargando terminales</td></tr>`;
    }
}

async function guardarTerminal() {
    const id = document.getElementById('termId').value;
    const nombre = document.getElementById('termNombre').value.trim();
    const solo_admin = document.getElementById('termSoloAdmin').checked;

    if (!id || !nombre) return Swal.fire('Atención', 'Completá el número y el nombre de la terminal.', 'warning');

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/caja/cajas_fisicas/crear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: parseInt(id), nombre: nombre, solo_admin: solo_admin })
        });
        const data = await res.json();

        if (!res.ok || data.error) throw new Error(data.error || "Error al crear");

        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Terminal creada', showConfirmButton: false, timer: 1500 });
        bootstrap.Modal.getInstance(document.getElementById('modalNuevaTerminal')).hide();
        cargarCajasFisicas();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function toggleTerminal(id) {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/caja/cajas_fisicas/toggle/${id}`, { method: 'PUT' });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        cargarCajasFisicas();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}


// Arrancamos
document.addEventListener("DOMContentLoaded", () => {
    // Le agregamos el link correcto a la flecha del layout para esta página
    document.querySelector('.sidebar-menu a[href="admin_productos.html"]').classList.remove('active');


    cargarDatosEnVivo();
});