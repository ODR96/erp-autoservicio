// --- ENVOLTORIO DE SEGURIDAD PARA LLAMADAS ---
async function apiFetchSeguro(recurso, config = {}) {
    const tokenValido = localStorage.getItem('token') || localStorage.getItem('token_pos');
    if (!tokenValido) {
        window.location.href = 'index.html'; 
        throw new Error("Sin sesión");
    }
    
    if (!config.headers) config.headers = {};
    config.headers['Authorization'] = `Bearer ${tokenValido}`;
    config.headers['Content-Type'] = 'application/json';

    const res = await fetch(`${obtenerBaseUrl()}${recurso}`, config);
    if (res.status === 401) {
        localStorage.clear(); window.location.href = 'index.html';
    }
    return res;
}

function escGasto(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// FastAPI devuelve {detail} en errores (texto o lista de validación); el código viejo solo miraba {error}.
async function leerRespuestaGasto(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error || data.detail) {
        let msg = data.error || data.detail || 'El servidor rechazó la operación.';
        if (Array.isArray(msg)) msg = msg.map((d) => d.msg || '').filter(Boolean).join(' · ') || 'Datos inválidos.';
        throw new Error(msg);
    }
    return data;
}

// --- 1. CARGAR CATEGORÍAS EN EL SELECTOR ---
async function cargarCategorias() {
    const selector = document.getElementById('selectCategoriaGasto');
    try {
        const res = await apiFetchSeguro('/gastos/categorias'); // Asegurate del prefijo
        const data = await res.json();
        
        selector.innerHTML = '<option value="" disabled selected>-- Elegí una categoría --</option>';
        
        if (data.categorias) {
            data.categorias.forEach(cat => {
                // Los retiros del dueño van por su propio formulario, no como gasto.
                if ((cat.tipo_categoria || 'OPERATIVO').toUpperCase() === 'RETIRO_SOCIO') return;
                selector.innerHTML += `<option value="${cat.id}">${escGasto(cat.nombre)}</option>`;
            });
        }
    } catch (e) {
        console.error("Error al cargar categorías", e);
    }
}

// --- NUEVA FUNCIÓN PARA CREAR CATEGORÍAS ---
async function crearCategoria() {
    const { value: formValues } = await Swal.fire({
        title: 'Nueva Categoría',
        html: `
            <input id="swal-nombre" class="swal2-input form-control-dark w-75 mx-auto" placeholder="Ej: Sueldo, Luz, Limpieza">
            <select id="swal-tipo" class="swal2-select form-select-dark w-75 mx-auto mt-3">
                <option value="OPERATIVO">Gasto del Local (Costos)</option>
                <option value="MOVIMIENTO_INTERNO">Movimiento Interno (Sangría a Caja Fuerte)</option>
            </select>
            <p class="small text-muted mt-2 mb-0">Tus retiros personales no son una categoría: usá el botón "Retiro del dueño".</p>
        `,
        background: '#111C2A', color: '#fff',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Crear (Enter)',
        confirmButtonColor: '#38bdf8',
        didOpen: (popup) => {
            popup.querySelectorAll('input, select').forEach(el => {
                el.addEventListener('keypress', (e) => { if (e.key === 'Enter') Swal.clickConfirm(); });
            });
            setTimeout(() => document.getElementById('swal-nombre').focus(), 300);
        },
        preConfirm: () => {
            return {
                nombre: document.getElementById('swal-nombre').value,
                tipo_categoria: document.getElementById('swal-tipo').value
            }
        }
    });

    if (formValues && formValues.nombre) {
        try {
            Swal.fire({ title: 'Guardando...', background: '#111C2A', color: '#fff', didOpen: () => Swal.showLoading() });
            
            const res = await apiFetchSeguro('/gastos/categorias', {
                method: 'POST',
                body: JSON.stringify(formValues)
            });
            const data = await leerRespuestaGasto(res);
            
            Swal.fire({
                icon: 'success', 
                title: '¡Listo!', 
                text: data.mensaje, 
                background: '#111C2A', 
                color: '#fff', 
                timer: 1500, 
                showConfirmButton: false
            });
            
            cargarCategorias(); // Recargamos el selector automáticamente
        } catch(e) {
            Swal.fire({icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff'});
        }
    }
}

// --- 2. REGISTRAR UN NUEVO GASTO ---
async function registrarGastoNuevo() {
    const categoriaId = document.getElementById('selectCategoriaGasto').value;
    const monto = document.getElementById('inputMontoGasto').value;
    const detalle = document.getElementById('inputDetalleGasto').value;
    const origen = document.getElementById('selectOrigenFondos').value;

    if (!categoriaId || !monto || monto <= 0 || !detalle.trim()) {
        Swal.fire({
            icon: 'warning',
            title: 'Datos Incompletos',
            text: 'Por favor completá el monto, la categoría y el detalle.',
            background: '#111C2A', color: '#fff'
        });
        return;
    }

    try {
        Swal.fire({ title: 'Registrando...', background: '#111C2A', color: '#fff', didOpen: () => Swal.showLoading() });

        const payload = {
            categoria_id: parseInt(categoriaId),
            descripcion_detalle: detalle,
            monto: parseFloat(monto),
            metodo_pago: origen,
            origen_fondos: origen
        };

        const res = await apiFetchSeguro('/gastos/registrar', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const data = await leerRespuestaGasto(res);

        Swal.fire({
            icon: 'success',
            title: '¡Registrado!',
            text: data.mensaje,
            background: '#111C2A', color: '#fff',
            timer: 2000,
            showConfirmButton: false
        });

        // Limpiar el formulario
        document.getElementById('inputMontoGasto').value = '';
        document.getElementById('inputDetalleGasto').value = '';
        document.getElementById('selectCategoriaGasto').value = '';
        
        cargarResumenMensual();
        cargarHistorial();
        cargarCajaFuerte();

    } catch (e) {
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: e.message,
            background: '#111C2A', color: '#fff'
        });
    }
}

// --- 3. CARGAR LOS KPIS DEL MES ---
async function cargarResumenMensual() {
    try {
        const res = await apiFetchSeguro('/gastos/resumen_mensual');
        const data = await res.json();
        
        if (!data.error && data.gastos_por_categoria) {
            let totalGastosOperativos = 0;
            let totalRetirosSocio = 0;

            // Magia corporativa: Agrupamos leyendo el TIPO que dice la base de datos
            data.gastos_por_categoria.forEach(item => {
                if (item.tipo_categoria === 'RETIRO_SOCIO') {
                    totalRetirosSocio += item.total_gastado;
                } else if (item.tipo_categoria === 'OPERATIVO') {
                    // Solo sumamos a la aguja roja si es realmente un gasto
                    totalGastosOperativos += item.total_gastado;
                }
            });

            document.getElementById('kpiGastos').innerText = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(totalGastosOperativos);
            const nota = document.getElementById('kpiRetirosNota');
            if (nota) {
                nota.innerText = totalRetirosSocio > 0
                    ? `Aparte, ${formatoPesos(totalRetirosSocio)} cargados como gasto con categoría de retiro.`
                    : '';
            }
            const kpiCajon = document.getElementById('kpiSalidasCajon');
            if (kpiCajon) {
                kpiCajon.innerText = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(data.salidas_cajon || 0);
            }
        }
    } catch (e) {
        console.error("Error al cargar KPIs", e);
    }
}

// --- Etiqueta de origen del dinero: solo los orígenes que SÍ implican plata física
// saliendo de algún lado se muestran como tal. La liquidación de RRHH es el costo bruto;
// el pago del neto se registra aparte en RRHH. El consumo regalado no mueve plata. ---
function mapearOrigenFondos(origen) {
    if (origen === 'CAJA_MAYOR') return { texto: 'Caja Fuerte', color: 'bg-success' };
    if (origen && origen.includes('CAJA_DIARIA')) return { texto: 'Cajón (POS)', color: 'bg-secondary' };
    if (origen === 'TARJETA') return { texto: 'Tarjeta (deuda)', color: 'bg-warning text-dark' };
    if (origen === 'CHEQUE') return { texto: 'Cheque (el banco al debitarlo)', color: 'bg-warning text-dark' };
    if (origen === 'RRHH') return { texto: 'Sueldo bruto (pago en RRHH)', color: 'bg-info text-dark' };
    if (origen === 'CONSUMO_PERSONAL') return { texto: 'Sin salida de caja (Beneficio)', color: 'bg-info text-dark' };
    return { texto: 'Sin salida de caja', color: 'bg-info text-dark' };
}

// --- 4. CARGAR EL HISTORIAL DE LA TABLA DERECHA ---
async function cargarHistorial() {
    const tbody = document.getElementById('tablaGastosBody');
    try {
        // Hacemos el llamado a la ruta nueva que agregamos en rutas_gastos.py
        const res = await apiFetchSeguro('/gastos/historial'); 
        const data = await res.json();
        
        tbody.innerHTML = ''; // Limpiamos el mensaje de "Cargando..."
        
        if (data.error || !data.movimientos || data.movimientos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="py-5 text-muted">No hay movimientos registrados.</td></tr>';
            return;
        }

        // Dibujamos fila por fila
        data.movimientos.forEach(mov => {
            // Formatear fecha y plata para que se vea lindo
            const fechaCorta = mov.fecha.split(' ')[0]; 
            const plataLimpia = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(mov.monto);
            const esAnulado = mov.estado === 'ANULADO';

            // Etiqueta de color según de dónde salió la plata (o si no salió de ningún lado)
            const origenInfo = mapearOrigenFondos(mov.origen_fondos);

            const badgeOrigen = `<span class="badge ${origenInfo.color}">${origenInfo.texto}</span>`
                + (esAnulado ? '<span class="badge bg-danger ms-1">ANULADO</span>' : '');
            tbody.innerHTML += `
                <tr class="${esAnulado ? 'text-decoration-line-through opacity-50' : ''}">
                    <td class="text-white">${escGasto(fechaCorta)}</td>
                    <td class="text-start">
                        <div class="fw-bold text-info">${escGasto(mov.categoria)}</div>
                        <div class="d-md-none small text-muted text-break">${escGasto(mov.detalle)}</div>
                        <div class="d-md-none mt-1">${badgeOrigen}</div>
                    </td>
                    <td class="text-start text-muted col-hide-xs">${escGasto(mov.detalle)}</td>
                    <td class="col-hide-xs">${badgeOrigen}</td>
                    <td class="text-end fw-bold text-danger pe-4">${plataLimpia}</td>
                </tr>
            `;
        });
    } catch (e) {
        console.error("Error al cargar el historial", e);
        tbody.innerHTML = '<tr><td colspan="5" class="py-5 text-danger">Error al cargar datos.</td></tr>';
    }
}

// =================================================================
// 5. GESTIÓN DE CATEGORÍAS (editar / eliminar)
// =================================================================
async function abrirGestionCategorias() {
    try {
        const res = await apiFetchSeguro('/gastos/categorias?incluir_inactivas=true');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        renderModalGestionCategorias(data.categorias || []);
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

const ETIQUETAS_TIPO_CATEGORIA = {
    OPERATIVO: 'Gasto del Local',
    RETIRO_SOCIO: 'Retiro Personal',
    MOVIMIENTO_INTERNO: 'Mov. Interno'
};

function renderModalGestionCategorias(categorias) {
    const filasHtml = categorias.length === 0
        ? '<tr><td colspan="3" class="py-4 text-muted">No hay categorías creadas.</td></tr>'
        : categorias.map(c => {
            const inactiva = (c.activo ?? 1) === 0;
            return `
                <tr data-id="${c.id}" class="${inactiva ? 'opacity-50' : ''}">
                    <td class="text-start">${escGasto(c.nombre)} ${inactiva ? '<span class="badge bg-secondary ms-1">Oculta</span>' : ''}</td>
                    <td class="small">${escGasto(ETIQUETAS_TIPO_CATEGORIA[c.tipo_categoria] || c.tipo_categoria)}</td>
                    <td class="text-end">
                        <button class="btn btn-sm btn-outline-info btn-editar-cat" title="Editar"><i class="bi bi-pencil"></i></button>
                        <button class="btn btn-sm btn-outline-danger btn-eliminar-cat" title="Eliminar / Ocultar"><i class="bi bi-trash"></i></button>
                    </td>
                </tr>
            `;
        }).join('');

    Swal.fire({
        title: 'Gestionar Categorías de Gasto',
        width: 560,
        html: `
            <div class="table-responsive text-start" style="max-height:400px; overflow-y:auto;">
                <table class="table table-dark table-sm align-middle mb-0">
                    <thead><tr><th class="text-start">Nombre</th><th>Tipo</th><th></th></tr></thead>
                    <tbody id="tbody-gestion-categorias">${filasHtml}</tbody>
                </table>
            </div>
        `,
        background: '#111C2A', color: '#fff',
        showConfirmButton: false,
        showCloseButton: true,
        didOpen: (popup) => {
            popup.querySelectorAll('.btn-editar-cat').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const id = parseInt(e.target.closest('tr').dataset.id);
                    const cat = categorias.find(c => c.id === id);
                    if (cat) editarCategoriaModal(cat);
                });
            });
            popup.querySelectorAll('.btn-eliminar-cat').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const id = parseInt(e.target.closest('tr').dataset.id);
                    const cat = categorias.find(c => c.id === id);
                    if (cat) eliminarCategoriaConfirmar(cat);
                });
            });
        }
    });
}

async function editarCategoriaModal(cat) {
    const { value: formValues } = await Swal.fire({
        title: `Editar: ${escGasto(cat.nombre)}`,
        html: `
            <input id="swal-edit-nombre" class="swal2-input form-control-dark w-75 mx-auto" value="${escGasto(cat.nombre)}">
            <select id="swal-edit-tipo" class="swal2-select form-select-dark w-75 mx-auto mt-3">
                <option value="OPERATIVO" ${cat.tipo_categoria === 'OPERATIVO' ? 'selected' : ''}>Gasto del Local (Costos)</option>
                <option value="RETIRO_SOCIO" ${cat.tipo_categoria === 'RETIRO_SOCIO' ? 'selected' : ''}>Retiro Personal / Socio</option>
                <option value="MOVIMIENTO_INTERNO" ${cat.tipo_categoria === 'MOVIMIENTO_INTERNO' ? 'selected' : ''}>Movimiento Interno (Sangría a Caja Fuerte)</option>
            </select>
            <div class="form-check mt-3 text-start w-75 mx-auto">
                <input class="form-check-input" type="checkbox" id="swal-edit-activo" ${(cat.activo ?? 1) !== 0 ? 'checked' : ''}>
                <label class="form-check-label small" for="swal-edit-activo">Visible para elegir en gastos nuevos</label>
            </div>
        `,
        background: '#111C2A', color: '#fff',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Guardar (Enter)',
        confirmButtonColor: '#38bdf8',
        didOpen: (popup) => {
            popup.querySelectorAll('input, select').forEach(el => {
                el.addEventListener('keypress', (e) => { if (e.key === 'Enter') Swal.clickConfirm(); });
            });
            setTimeout(() => document.getElementById('swal-edit-nombre').focus(), 300);
        },
        preConfirm: () => {
            const nombre = document.getElementById('swal-edit-nombre').value.trim();
            if (!nombre) { Swal.showValidationMessage('Ingresá un nombre'); return false; }
            return {
                nombre,
                tipo_categoria: document.getElementById('swal-edit-tipo').value,
                activo: document.getElementById('swal-edit-activo').checked
            };
        }
    });

    if (!formValues) return;

    try {
        const res = await apiFetchSeguro(`/gastos/categorias/${cat.id}`, {
            method: 'PUT', body: JSON.stringify(formValues)
        });
        const data = await leerRespuestaGasto(res);

        Swal.fire({ icon: 'success', title: '¡Listo!', text: data.mensaje, background: '#111C2A', color: '#fff', timer: 1500, showConfirmButton: false });
        cargarCategorias();
        abrirGestionCategorias();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function eliminarCategoriaConfirmar(cat) {
    const result = await Swal.fire({
        title: `¿Eliminar "${escGasto(cat.nombre)}"?`,
        html: 'Si nunca tuvo gastos registrados, se borra para siempre.<br>Si ya tiene historial, se oculta en vez de borrarse (no se pierde ningún dato viejo).',
        icon: 'warning',
        background: '#111C2A', color: '#fff',
        showCancelButton: true,
        confirmButtonText: 'Sí, continuar',
        confirmButtonColor: '#dc3545'
    });
    if (!result.isConfirmed) return;

    try {
        const res = await apiFetchSeguro(`/gastos/categorias/${cat.id}`, { method: 'DELETE' });
        const data = await leerRespuestaGasto(res);

        Swal.fire({ icon: 'success', title: '¡Listo!', text: data.mensaje, background: '#111C2A', color: '#fff' });
        cargarCategorias();
        abrirGestionCategorias();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

// =================================================================
// 6. RETIROS DEL DUEÑO (no son gasto: no tocan la ganancia)
// =================================================================
const ORIGENES_RETIRO = {
    CAJA_FUERTE: 'Caja fuerte',
    MERCADOPAGO: 'Mercado Pago del negocio',
    BANCO: 'Banco del negocio',
    CAJON: 'Cajón del mostrador'
};

function formatoPesos(n) {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(n) || 0);
}

async function cargarRetirosDueno() {
    const kpi = document.getElementById('kpiRetiros');
    try {
        const res = await apiFetchSeguro('/caja/retiros_dueno');
        const data = await leerRespuestaGasto(res);
        if (kpi) kpi.innerText = formatoPesos(data.total);
        return data;
    } catch (e) {
        console.error('Error al cargar retiros del dueño', e);
        if (kpi) kpi.innerText = '—';
        return null;
    }
}

async function registrarRetiroDueno() {
    const { value: form } = await Swal.fire({
        title: 'Retiro del dueño',
        html: `
            <p class="small text-muted mb-2">Plata del negocio que te llevás vos. No es gasto: no baja la ganancia, se compara contra ella.</p>
            <input id="swal-ret-monto" type="number" inputmode="decimal" step="0.01" min="0.01" class="swal2-input form-control-dark w-75 mx-auto" placeholder="Monto ($)">
            <select id="swal-ret-origen" class="swal2-select form-select-dark w-75 mx-auto mt-3">
                <option value="CAJA_FUERTE">De la caja fuerte</option>
                <option value="MERCADOPAGO">Del Mercado Pago del negocio</option>
                <option value="BANCO">Del banco del negocio</option>
            </select>
            <input id="swal-ret-motivo" type="text" maxlength="200" autocomplete="off" class="swal2-input form-control-dark w-75 mx-auto" placeholder="Para qué (opcional)">
            <p class="small text-muted mt-2 mb-0">¿Salió del cajón? El cajero hace una sangría y acá lo cargás como caja fuerte por lo que te llevaste.</p>
        `,
        background: '#111C2A', color: '#fff',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Registrar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#f59e0b',
        didOpen: (popup) => {
            popup.querySelectorAll('input, select').forEach(el => {
                el.addEventListener('keypress', (e) => { if (e.key === 'Enter') Swal.clickConfirm(); });
            });
            setTimeout(() => document.getElementById('swal-ret-monto').focus(), 300);
        },
        preConfirm: () => {
            const monto = parseFloat(document.getElementById('swal-ret-monto').value);
            if (!monto || monto <= 0) { Swal.showValidationMessage('Ingresá un monto mayor a 0'); return false; }
            return {
                monto,
                origen: document.getElementById('swal-ret-origen').value,
                motivo: document.getElementById('swal-ret-motivo').value.trim()
            };
        }
    });
    if (!form) return;

    try {
        Swal.fire({ title: 'Registrando...', background: '#111C2A', color: '#fff', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const res = await apiFetchSeguro('/caja/retiro_dueno', { method: 'POST', body: JSON.stringify(form) });
        const data = await leerRespuestaGasto(res);
        Swal.fire({ icon: 'success', title: '¡Registrado!', text: data.mensaje, background: '#111C2A', color: '#fff', timer: 2000, showConfirmButton: false });
        cargarRetirosDueno();
        cargarCajaFuerte();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function verRetirosDueno() {
    const data = await cargarRetirosDueno();
    if (!data) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'No se pudieron cargar los retiros.', background: '#111C2A', color: '#fff' });
        return;
    }
    const filas = (data.retiros || []).length === 0
        ? '<tr><td colspan="4" class="py-4 text-muted">Sin retiros este mes.</td></tr>'
        : data.retiros.map(r => {
            const anulado = r.estado !== 'ACTIVO';
            return `
                <tr class="${anulado ? 'text-decoration-line-through opacity-50' : ''}">
                    <td class="small">${escGasto(String(r.fecha_hora || '').slice(0, 16))}</td>
                    <td class="text-start">
                        <div class="fw-bold">${escGasto(ORIGENES_RETIRO[r.origen] || r.origen)}</div>
                        <div class="small text-muted text-break">${escGasto(r.motivo)}</div>
                    </td>
                    <td class="text-end fw-bold text-warning">${formatoPesos(r.monto)}</td>
                    <td class="text-end">${anulado
                        ? '<span class="badge bg-danger">ANULADO</span>'
                        : `<button class="btn btn-sm btn-outline-danger btn-anular-retiro" data-id="${r.id}" title="Anular"><i class="bi bi-x-lg"></i></button>`}</td>
                </tr>`;
        }).join('');

    Swal.fire({
        title: `Retiros de ${escGasto(data.mes)}`,
        width: 600,
        html: `
            <div class="fw-bold text-warning mb-2">Total: ${formatoPesos(data.total)}</div>
            <div class="table-responsive text-start" style="max-height:400px; overflow-y:auto;">
                <table class="table table-dark table-sm align-middle mb-0">
                    <tbody>${filas}</tbody>
                </table>
            </div>`,
        background: '#111C2A', color: '#fff',
        showConfirmButton: false,
        showCloseButton: true,
        didOpen: (popup) => {
            popup.querySelectorAll('.btn-anular-retiro').forEach(btn => {
                btn.addEventListener('click', () => anularRetiroDueno(parseInt(btn.dataset.id)));
            });
        }
    });
}

async function anularRetiroDueno(id) {
    const ok = await Swal.fire({
        title: '¿Anular este retiro?',
        text: 'Queda en el historial como anulado y deja de contar en el mes.',
        icon: 'warning',
        background: '#111C2A', color: '#fff',
        showCancelButton: true,
        confirmButtonText: 'Sí, anular',
        cancelButtonText: 'Volver',
        confirmButtonColor: '#dc3545'
    });
    if (!ok.isConfirmed) return verRetirosDueno();
    try {
        const res = await apiFetchSeguro(`/caja/retiro_dueno/${id}/anular`, { method: 'PUT' });
        await leerRespuestaGasto(res);
        cargarCajaFuerte();
        await verRetirosDueno();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

// =================================================================
// 7. CAJA FUERTE (tesorería): saldo = suma del libro; el arqueo lo ajusta
// =================================================================
const ORIGENES_MOV_TESORERIA = {
    SANGRIA: 'Sangría',
    GASTO: 'Gasto',
    PAGO_PROVEEDOR: 'Pago a proveedor',
    RETIRO_DUENO: 'Retiro del dueño',
    VENTA_DEPOSITO: 'Venta depósito',
    CIERRE_TURNO: 'Cierre de turno',
    ADELANTO: 'Adelanto de sueldo',
    SUELDO: 'Sueldo',
    ARQUEO: 'Arqueo',
    ANULACION: 'Anulación',
    COBRO_QR: 'QR Mercado Pago',
    REEMBOLSO_QR: 'Reembolso QR',
    TRANSFERENCIA: 'Pase entre cuentas',
    TRANSFERENCIA_VENTA: 'Transferencia de venta',
    CAMBIO: 'Cambio al cajón',
    CHEQUE: 'Cheque propio'
};

const CUENTAS_TESORERIA = ['CAJA_FUERTE', 'MERCADOPAGO', 'BANCO'];

function textoEstadoCuenta(data) {
    if (!data.inicializada) {
        return '<span class="text-warning fw-bold">Sin arqueo inicial.</span> Contá lo que hay y cargalo. Hasta entonces el saldo no frena.';
    }
    const a = data.ultimo_arqueo;
    const dif = Number(a.diferencia) || 0;
    const textoDif = Math.abs(dif) < 0.01 ? 'coincidió' : (dif > 0 ? `sobraban ${formatoPesos(dif)}` : `faltaban ${formatoPesos(-dif)}`);
    return `Último arqueo: ${escGasto(String(a.fecha_hora || '').slice(0, 16))} (${textoDif}).`;
}

async function cargarCajaFuerte() {
    const cont = document.getElementById('cuentasTesoreria');
    if (!cont) return null;
    try {
        const cuentas = [];
        for (const codigo of CUENTAS_TESORERIA) {
            const res = await apiFetchSeguro(`/tesoreria/cuenta/${codigo}?limite=100`);
            cuentas.push(await leerRespuestaGasto(res));
        }
        let deuda = null;
        try {
            const resDeuda = await apiFetchSeguro('/tesoreria/deuda/TARJETA');
            deuda = await leerRespuestaGasto(resDeuda);
        } catch (e) { deuda = null; }
        const tarjeta = deuda ? `
            <div class="kpi-card p-3 d-flex flex-wrap align-items-center justify-content-between gap-3" style="border-left-color:#f59e0b;">
                <div>
                    <h6 class="text-muted text-uppercase fw-bold small mb-1">Tarjeta (lo que debés)</h6>
                    <h2 class="fw-bold mb-0 text-warning">${formatoPesos(deuda.saldo)}</h2>
                    <div class="small text-muted mt-1">${deuda.inicializada ? 'Pagar el resumen no es un gasto.' : 'Cargá lo que debés hoy. Hasta entonces el número no frena.'}</div>
                </div>
                <div class="d-flex gap-2 flex-wrap">
                    <button type="button" class="btn btn-warning fw-bold" data-teso="deuda-saldo">Lo que debo</button>
                    <button type="button" class="btn btn-outline-warning fw-bold" data-teso="deuda-pagar">Pagar resumen</button>
                    <button type="button" class="btn btn-outline-light fw-bold" data-teso="deuda-consumo">Consumo</button>
                </div>
            </div>` : '';
        const plata = `<div class="row g-3 mb-3">` + cuentas.map(c => {
            const pend = c.por_recibir || { cantidad: 0, total: 0 };
            const aviso = pend.cantidad > 0
                ? `<button type="button" class="btn btn-sm btn-warning fw-bold mt-2" data-teso="pend" data-cuenta="${escGasto(c.cuenta)}">Por recibir ${formatoPesos(pend.total)}</button>`
                : '<div class="small text-muted mt-2">Nada por recibir.</div>';
            return `
                <div class="col-md-4">
                    <div class="kpi-card p-3 h-100 d-flex flex-column" style="border-left-color:#a78bfa;">
                        <h6 class="text-muted text-uppercase fw-bold small mb-1">${escGasto(c.nombre)}</h6>
                        <h2 class="fw-bold mb-1" style="color:#c4b5fd;">${formatoPesos(c.saldo)}</h2>
                        <div class="small text-muted">${textoEstadoCuenta(c)}</div>
                        ${aviso}
                        <div class="d-flex gap-2 mt-auto pt-3">
                            <button type="button" class="btn btn-sm fw-bold flex-grow-1" style="background:#7c3aed; color:#fff;" data-teso="arqueo" data-cuenta="${escGasto(c.cuenta)}">Arqueo</button>
                            <button type="button" class="btn btn-sm btn-outline-light" data-teso="movs" data-cuenta="${escGasto(c.cuenta)}">Movimientos</button>
                        </div>
                    </div>
                </div>`;
        }).join('') + `</div>`;
        cont.innerHTML = plata + tarjeta + `
            <button type="button" id="btnPasarPlata" class="btn btn-outline-info fw-bold mt-3">Pasar plata entre cuentas</button>`;
        return cuentas[0];
    } catch (e) {
        console.error('Error al cargar tesorería', e);
        cont.innerHTML = '<div class="text-warning">No se pudieron cargar las cuentas.</div>';
        return null;
    }
}

async function hacerArqueoCajaFuerte(cuenta) {
    const codigo = (typeof cuenta === 'string' && cuenta) ? cuenta : 'CAJA_FUERTE';
    let data;
    try {
        const res = await apiFetchSeguro(`/tesoreria/cuenta/${codigo}?limite=1`);
        data = await leerRespuestaGasto(res);
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
        return;
    }
    const nombre = data.nombre || codigo;
    const primero = !data.inicializada;
    const { value: form } = await Swal.fire({
        title: primero ? `Saldo inicial de ${nombre}` : `Arqueo de ${nombre}`,
        html: `
            <p class="small text-muted mb-2">${primero
                ? `Contá toda la plata que hay en ${escGasto(nombre)} y cargá el total. Desde acá el sistema lleva la cuenta.`
                : `Según el sistema hay <b>${formatoPesos(data.saldo)}</b>. Contá y cargá lo que hay de verdad.`}</p>
            <input id="swal-arq-monto" type="number" inputmode="decimal" step="0.01" min="0" class="swal2-input form-control-dark w-75 mx-auto" placeholder="Lo que contaste ($)">
            <div id="swal-arq-dif" class="small fw-bold mt-2"></div>
            <input id="swal-arq-motivo" type="text" maxlength="200" autocomplete="off" class="swal2-input form-control-dark w-75 mx-auto" placeholder="${primero ? 'Nota (opcional)' : 'Motivo si no coincide'}">
        `,
        background: '#111C2A', color: '#fff',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Guardar arqueo',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#7c3aed',
        didOpen: (popup) => {
            const monto = document.getElementById('swal-arq-monto');
            const dif = document.getElementById('swal-arq-dif');
            monto.addEventListener('input', () => {
                if (primero || monto.value === '') { dif.innerText = ''; return; }
                const d = (parseFloat(monto.value) || 0) - Number(data.saldo);
                dif.className = `small fw-bold mt-2 ${Math.abs(d) < 0.01 ? 'text-success' : 'text-danger'}`;
                dif.innerText = Math.abs(d) < 0.01 ? 'Coincide con el sistema.' : (d > 0 ? `Sobran ${formatoPesos(d)}` : `Faltan ${formatoPesos(-d)}`);
            });
            popup.querySelectorAll('input').forEach(el => {
                el.addEventListener('keypress', (e) => { if (e.key === 'Enter') Swal.clickConfirm(); });
            });
            setTimeout(() => monto.focus(), 300);
        },
        preConfirm: () => {
            const valor = document.getElementById('swal-arq-monto').value;
            const contado = parseFloat(valor);
            if (valor === '' || !Number.isFinite(contado) || contado < 0) { Swal.showValidationMessage('Cargá lo que contaste'); return false; }
            const motivo = document.getElementById('swal-arq-motivo').value.trim();
            const d = contado - Number(data.saldo);
            if (!primero && Math.abs(d) >= 0.01 && motivo.length < 5) { Swal.showValidationMessage('No coincide: escribí el motivo'); return false; }
            return { cuenta: codigo, monto_contado: contado, motivo };
        }
    });
    if (!form) return;
    try {
        Swal.fire({ title: 'Guardando...', background: '#111C2A', color: '#fff', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const res = await apiFetchSeguro('/tesoreria/arqueo', { method: 'POST', body: JSON.stringify(form) });
        const r = await leerRespuestaGasto(res);
        Swal.fire({ icon: 'success', title: 'Arqueo guardado', text: r.mensaje, background: '#111C2A', color: '#fff' });
        cargarCajaFuerte();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

// Sobres de cierre y sangrías del cajero: no suman hasta que el dueño los cuenta.
let pendientesCajaFuerte = [];
let cuentaPorRecibir = 'CAJA_FUERTE';

function difPendienteHtml(dif) {
    const d = Number(dif) || 0;
    if (Math.abs(d) < 0.01) return '<span class="text-success">coincidió</span>';
    return `<span class="text-danger fw-bold">${d < 0 ? 'faltaron' : 'sobraron'} ${formatoPesos(Math.abs(d))}</span>`;
}

async function verPorRecibir(cuenta) {
    if (typeof cuenta === 'string' && cuenta) cuentaPorRecibir = cuenta;
    let data;
    try {
        const res = await apiFetchSeguro(`/tesoreria/pendientes?cuenta=${cuentaPorRecibir}&recibidos=10`);
        data = await leerRespuestaGasto(res);
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
        return;
    }
    pendientesCajaFuerte = data.pendientes || [];
    const filasPend = pendientesCajaFuerte.length === 0
        ? '<tr><td colspan="3" class="py-3 text-muted">No hay nada por recibir.</td></tr>'
        : pendientesCajaFuerte.map(p => `
            <tr>
                <td class="text-start">
                    <div class="fw-bold">${escGasto(ORIGENES_MOV_TESORERIA[p.origen_tipo] || p.origen_tipo)} · ${escGasto(p.declarado_por || 'Sin nombre')}</div>
                    <div class="small text-muted">${escGasto(String(p.fecha_hora || '').slice(0, 16))} · ${escGasto(p.concepto)}</div>
                </td>
                <td class="text-end fw-bold text-nowrap">${formatoPesos(p.monto_declarado)}</td>
                <td class="text-end"><button type="button" class="btn btn-sm btn-warning fw-bold" onclick="recibirPendiente(${Number(p.id)})">Contar</button></td>
            </tr>`).join('');
    const filasRec = (data.recibidos || []).map(p => `
            <tr>
                <td class="text-start small">
                    <div>${escGasto(ORIGENES_MOV_TESORERIA[p.origen_tipo] || p.origen_tipo)} · ${escGasto(p.declarado_por || 'Sin nombre')}</div>
                    <div class="text-muted">${escGasto(String(p.fecha_hora || '').slice(5, 16))} → contado ${escGasto(String(p.recibido_en || '').slice(5, 16))}${p.nota ? ' · ' + escGasto(p.nota) : ''}</div>
                </td>
                <td class="text-end small text-nowrap">${formatoPesos(p.monto_declarado)} → ${formatoPesos(p.monto_contado)}</td>
                <td class="text-end small text-nowrap">${difPendienteHtml(p.diferencia)}</td>
            </tr>`).join('');
    Swal.fire({
        title: 'Por recibir',
        width: 680,
        html: `
            <p class="small text-muted mb-2">Lo declaró el cajero. Entra a la caja fuerte lo que cuentes vos, no lo declarado.</p>
            <div class="table-responsive" style="max-height:300px; overflow-y:auto;">
                <table class="table table-dark table-sm align-middle mb-0"><tbody>${filasPend}</tbody></table>
            </div>
            ${filasRec ? `<h6 class="text-start text-muted mt-4 mb-2">Últimos recibidos</h6>
            <div class="table-responsive" style="max-height:220px; overflow-y:auto;">
                <table class="table table-dark table-sm align-middle mb-0"><tbody>${filasRec}</tbody></table>
            </div>` : ''}`,
        background: '#111C2A', color: '#fff',
        showConfirmButton: false,
        showCloseButton: true
    });
}

async function recibirPendiente(id) {
    const p = pendientesCajaFuerte.find(x => Number(x.id) === Number(id));
    if (!p) return;
    const { value: form } = await Swal.fire({
        title: 'Contar sobre',
        html: `
            <p class="small text-muted mb-2">${escGasto(ORIGENES_MOV_TESORERIA[p.origen_tipo] || p.origen_tipo)} · ${escGasto(p.declarado_por || 'Sin nombre')} · ${escGasto(String(p.fecha_hora || '').slice(0, 16))}<br>
            Declaró <b>${formatoPesos(p.monto_declarado)}</b>. Contá y cargá lo que hay de verdad.</p>
            <input id="swal-pend-monto" type="number" inputmode="decimal" step="0.01" min="0" class="swal2-input form-control-dark w-75 mx-auto" placeholder="Lo que contaste ($)">
            <div id="swal-pend-dif" class="small fw-bold mt-2"></div>
            <input id="swal-pend-nota" type="text" maxlength="200" autocomplete="off" class="swal2-input form-control-dark w-75 mx-auto" placeholder="Nota (opcional)">`,
        background: '#111C2A', color: '#fff',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Guardar en caja fuerte',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#7c3aed',
        didOpen: (popup) => {
            const monto = document.getElementById('swal-pend-monto');
            const dif = document.getElementById('swal-pend-dif');
            monto.addEventListener('input', () => {
                if (monto.value === '') { dif.innerText = ''; return; }
                const d = (parseFloat(monto.value) || 0) - Number(p.monto_declarado);
                dif.className = `small fw-bold mt-2 ${Math.abs(d) < 0.01 ? 'text-success' : 'text-danger'}`;
                dif.innerText = Math.abs(d) < 0.01 ? 'Coincide con lo declarado.' : (d < 0 ? `Faltan ${formatoPesos(-d)}` : `Sobran ${formatoPesos(d)}`);
            });
            popup.querySelectorAll('input').forEach(el => {
                el.addEventListener('keypress', (e) => { if (e.key === 'Enter') Swal.clickConfirm(); });
            });
            setTimeout(() => monto.focus(), 300);
        },
        preConfirm: () => {
            const valor = document.getElementById('swal-pend-monto').value;
            const contado = parseFloat(valor);
            if (valor === '' || !Number.isFinite(contado) || contado < 0) { Swal.showValidationMessage('Cargá lo que contaste'); return false; }
            return { monto_contado: contado, nota: document.getElementById('swal-pend-nota').value.trim() };
        }
    });
    if (!form) return verPorRecibir();
    try {
        Swal.fire({ title: 'Guardando...', background: '#111C2A', color: '#fff', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const res = await apiFetchSeguro(`/tesoreria/pendientes/${Number(id)}/recibir`, { method: 'POST', body: JSON.stringify(form) });
        const r = await leerRespuestaGasto(res);
        await Swal.fire({ icon: Math.abs(Number(r.diferencia) || 0) < 0.01 ? 'success' : 'warning', title: 'Recibido', text: r.mensaje, background: '#111C2A', color: '#fff' });
        await cargarCajaFuerte();
        verPorRecibir();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function verMovimientosCajaFuerte(cuenta) {
    const codigo = (typeof cuenta === 'string' && cuenta) ? cuenta : 'CAJA_FUERTE';
    let data;
    try {
        const res = await apiFetchSeguro(`/tesoreria/cuenta/${codigo}?limite=100`);
        data = await leerRespuestaGasto(res);
    } catch (e) {
        data = null;
    }
    if (!data) {
        Swal.fire({ icon: 'error', title: 'Error', text: 'No se pudieron cargar los movimientos.', background: '#111C2A', color: '#fff' });
        return;
    }
    const filas = (data.movimientos || []).length === 0
        ? '<tr><td colspan="3" class="py-4 text-muted">Sin movimientos todavía.</td></tr>'
        : data.movimientos.map(m => {
            const entra = Number(m.monto) > 0;
            return `
                <tr>
                    <td class="small text-nowrap">${escGasto(String(m.fecha_hora || '').slice(5, 16))}</td>
                    <td class="text-start">
                        <div class="fw-bold">${escGasto(ORIGENES_MOV_TESORERIA[m.origen_tipo] || m.origen_tipo)}</div>
                        <div class="small text-muted text-break">${escGasto(m.concepto)}</div>
                    </td>
                    <td class="text-end fw-bold text-nowrap ${entra ? 'text-success' : 'text-danger'}">${entra ? '+' : '−'}${formatoPesos(Math.abs(m.monto))}</td>
                </tr>`;
        }).join('');
    Swal.fire({
        title: data.nombre || 'Cuenta',
        width: 620,
        html: `
            <div class="fw-bold mb-2" style="color:#c4b5fd;">Saldo: ${formatoPesos(data.saldo)}</div>
            <div class="table-responsive text-start" style="max-height:420px; overflow-y:auto;">
                <table class="table table-dark table-sm align-middle mb-0"><tbody>${filas}</tbody></table>
            </div>`,
        background: '#111C2A', color: '#fff',
        showConfirmButton: false,
        showCloseButton: true
    });
}

const DESTINO_CHEQUE = { PROVEEDOR: 'Proveedor', GASTO: 'Gasto del local', RETIRO: 'Retiro del dueño' };
const ESTADO_CHEQUE = { EMITIDO: 'Emitido', DEPOSITADO: 'Depositado', DEBITADO: 'Cobrado', ANULADO: 'Anulado' };

async function emitirCheque() {
    const cats = [...document.querySelectorAll('#selectCategoriaGasto option')]
        .filter(o => o.value)
        .map(o => `<option value="${escGasto(o.value)}">${escGasto(o.textContent)}</option>`)
        .join('');
    const { value: form } = await Swal.fire({
        title: 'Emitir cheque',
        html: `
            <p class="small text-muted mb-2">No es para un proveedor. El banco no se mueve hasta marcarlo cobrado.</p>
            <select id="swal-ch-destino" class="swal2-select">
                <option value="GASTO">Gasto del local</option>
                <option value="RETIRO">Retiro mío</option>
            </select>
            <select id="swal-ch-cat" class="swal2-select">${cats}</select>
            <input id="swal-ch-monto" type="number" min="0" step="0.01" class="swal2-input" placeholder="Monto">
            <input id="swal-ch-num" class="swal2-input" placeholder="Número de cheque" maxlength="40">
            <input id="swal-ch-banco" class="swal2-input" placeholder="Banco (opcional)">
            <input id="swal-ch-fecha" type="date" class="swal2-input" title="Fecha en que lo pueden cobrar">
            <input id="swal-ch-detalle" class="swal2-input" placeholder="A quién o para qué" maxlength="200">`,
        background: '#111C2A', color: '#fff',
        showCancelButton: true,
        confirmButtonText: 'Emitir',
        confirmButtonColor: '#f59e0b',
        didOpen: () => {
            const destino = document.getElementById('swal-ch-destino');
            const cat = document.getElementById('swal-ch-cat');
            const sync = () => { cat.style.display = destino.value === 'GASTO' ? '' : 'none'; };
            destino.addEventListener('change', sync);
            sync();
        },
        preConfirm: () => {
            const destino = document.getElementById('swal-ch-destino').value;
            const monto = parseFloat(document.getElementById('swal-ch-monto').value);
            const numero = document.getElementById('swal-ch-num').value.trim();
            const detalle = document.getElementById('swal-ch-detalle').value.trim();
            const categoriaId = parseInt(document.getElementById('swal-ch-cat').value, 10);
            if (!numero) { Swal.showValidationMessage('Cargá el número de cheque'); return false; }
            if (!Number.isFinite(monto) || monto <= 0) { Swal.showValidationMessage('Cargá el monto'); return false; }
            if (detalle.length < 3) { Swal.showValidationMessage('Escribí a quién o para qué es'); return false; }
            if (destino === 'GASTO' && !categoriaId) { Swal.showValidationMessage('Elegí la categoría'); return false; }
            return {
                destino, monto, numero, detalle,
                categoria_id: destino === 'GASTO' ? categoriaId : null,
                banco: document.getElementById('swal-ch-banco').value.trim(),
                fecha_cobro: document.getElementById('swal-ch-fecha').value
            };
        }
    });
    if (!form) return;
    try {
        const res = await apiFetchSeguro('/tesoreria/cheque', { method: 'POST', body: JSON.stringify(form) });
        const r = await leerRespuestaGasto(res);
        Swal.fire({ icon: 'success', title: 'Cheque emitido', text: r.mensaje, background: '#111C2A', color: '#fff' });
        verCheques();
        cargarResumenMensual();
        cargarHistorial();
        cargarRetirosDueno();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function verCheques() {
    let data;
    try {
        const res = await apiFetchSeguro('/tesoreria/cheques');
        data = await leerRespuestaGasto(res);
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
        return;
    }
    pintarAvisoCheques(data);
    const cuerpo = document.getElementById('tablaChequesBody');
    const filas = (data.cheques || []).map(c => {
        const quien = c.destino === 'PROVEEDOR' ? (c.proveedor || c.beneficiario) : (c.detalle || c.beneficiario);
        const id = Number(c.id);
        const botones = [];
        if (c.estado === 'EMITIDO') {
            botones.push(`<button type="button" class="btn btn-sm btn-outline-info" onclick="depositarCheque(${id})">Lo depositaron</button>`);
        }
        if (c.estado === 'EMITIDO' || c.estado === 'DEPOSITADO') {
            botones.push(`<button type="button" class="btn btn-sm btn-warning" onclick="debitarCheque(${id})">Cobrado</button>`);
        }
        if (c.estado === 'EMITIDO' || c.estado === 'DEPOSITADO' || c.estado === 'DEBITADO') {
            botones.push(`<button type="button" class="btn btn-sm btn-outline-danger" onclick="anularCheque(${id})">Anular</button>`);
        }
        return `<tr>
            <td class="text-start"><div class="fw-bold">${escGasto(c.numero)}${c.banco ? ' · ' + escGasto(c.banco) : ''}</div>
                <div class="small text-muted">${escGasto(DESTINO_CHEQUE[c.destino] || c.destino)} · ${escGasto(quien || '')}${c.fecha_cobro ? ' · cobra ' + escGasto(c.fecha_cobro) : ''}</div></td>
            <td class="text-end text-nowrap">${formatoPesos(c.monto)}</td>
            <td class="small">${escGasto(ESTADO_CHEQUE[c.estado] || c.estado)}</td>
            <td class="text-end"><div class="d-flex flex-wrap justify-content-end gap-1">${botones.join('')}</div></td>
        </tr>`;
    }).join('') || '<tr><td colspan="4" class="text-muted py-4 text-center">No hay cheques.</td></tr>';
    if (cuerpo) cuerpo.innerHTML = filas;
}

function pintarAvisoCheques(data) {
    const el = document.getElementById('avisoCheques');
    if (!el) return;
    const dep = data.depositados || { cantidad: 0, total: 0 };
    const total = Number(dep.total || 0);
    const banco = Number(data.saldo_banco || 0);
    if (!dep.cantidad) {
        el.innerHTML = '<div class="small text-muted">Ningún cheque figura depositado. El saldo del banco no incluye cheques que todavía no se cobraron.</div>';
        return;
    }
    const falta = Math.round((total - banco) * 100) / 100;
    if (falta > 0.009) {
        el.innerHTML = `<div class="alert alert-danger py-2 mb-0">Depositados: ${formatoPesos(total)} (${dep.cantidad}). En el banco hay ${formatoPesos(banco)}. Faltan ${formatoPesos(falta)} para que no reboten.</div>`;
        return;
    }
    el.innerHTML = `<div class="alert alert-warning py-2 mb-0">Depositados: ${formatoPesos(total)} (${dep.cantidad}). En el banco hay ${formatoPesos(banco)}. Alcanza para que se cobren.</div>`;
}

async function depositarCheque(id) {
    try {
        const res = await apiFetchSeguro(`/tesoreria/cheque/${id}/depositar`, { method: 'PUT', body: '{}' });
        const r = await leerRespuestaGasto(res);
        await Swal.fire({ icon: 'success', title: 'Depositado', text: r.mensaje, background: '#111C2A', color: '#fff' });
        verCheques();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function debitarCheque(id) {
    try {
        const res = await apiFetchSeguro(`/tesoreria/cheque/${id}/debitar`, { method: 'PUT', body: '{}' });
        const r = await leerRespuestaGasto(res);
        await Swal.fire({ icon: 'success', title: 'Debitado', text: r.mensaje, background: '#111C2A', color: '#fff' });
        await cargarCajaFuerte();
        verCheques();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function anularCheque(id) {
    const ok = await Swal.fire({
        title: '¿Anular este cheque?',
        text: 'Si era un gasto, se anula. Si era de un proveedor, vuelve la deuda. Si ya estaba cobrado, la plata vuelve al banco.',
        icon: 'warning', background: '#111C2A', color: '#fff',
        showCancelButton: true, confirmButtonText: 'Anular', confirmButtonColor: '#dc3545'
    });
    if (!ok.isConfirmed) return;
    try {
        const res = await apiFetchSeguro(`/tesoreria/cheque/${id}/anular`, { method: 'PUT', body: '{}' });
        const r = await leerRespuestaGasto(res);
        await Swal.fire({ icon: 'success', title: 'Anulado', text: r.mensaje, background: '#111C2A', color: '#fff' });
        cargarCajaFuerte();
        cargarResumenMensual();
        cargarHistorial();
        cargarRetirosDueno();
        verCheques();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function pasarPlataEntreCuentas() {
    const opciones = CUENTAS_TESORERIA.map(c => `<option value="${c}">${c === 'CAJA_FUERTE' ? 'Caja fuerte' : (c === 'MERCADOPAGO' ? 'Mercado Pago' : 'Banco')}</option>`).join('');
    const { value: form } = await Swal.fire({
        title: 'Pasar plata',
        html: `
            <p class="small text-muted mb-2">Sale de una cuenta y entra en la otra. No es un gasto.</p>
            <select id="swal-tr-origen" class="swal2-select">${opciones}</select>
            <select id="swal-tr-destino" class="swal2-select">${opciones}</select>
            <input id="swal-tr-monto" type="number" min="0" step="0.01" class="swal2-input" placeholder="Monto">
            <input id="swal-tr-motivo" type="text" maxlength="120" class="swal2-input" placeholder="Nota (opcional)">`,
        background: '#111C2A', color: '#fff',
        showCancelButton: true,
        confirmButtonText: 'Pasar',
        confirmButtonColor: '#0ea5e9',
        preConfirm: () => {
            const origen = document.getElementById('swal-tr-origen').value;
            const destino = document.getElementById('swal-tr-destino').value;
            const monto = parseFloat(document.getElementById('swal-tr-monto').value);
            if (origen === destino) { Swal.showValidationMessage('Elegí dos cuentas distintas'); return false; }
            if (!Number.isFinite(monto) || monto <= 0) { Swal.showValidationMessage('Cargá el monto'); return false; }
            return { origen, destino, monto, motivo: document.getElementById('swal-tr-motivo').value.trim() };
        }
    });
    if (!form) return;
    try {
        const res = await apiFetchSeguro('/tesoreria/transferencia', { method: 'POST', body: JSON.stringify(form) });
        const r = await leerRespuestaGasto(res);
        Swal.fire({ icon: 'success', title: 'Listo', text: r.mensaje, background: '#111C2A', color: '#fff' });
        cargarCajaFuerte();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function fijarDeudaTarjeta() {
    const { value: monto } = await Swal.fire({
        title: 'Lo que debés en la tarjeta',
        input: 'number',
        inputAttributes: { min: 0, step: '0.01' },
        text: 'Cargá el saldo del resumen. No es un gasto.',
        background: '#111C2A', color: '#fff',
        showCancelButton: true,
        confirmButtonText: 'Guardar'
    });
    if (monto === undefined) return;
    try {
        const res = await apiFetchSeguro('/tesoreria/deuda/TARJETA/saldo', { method: 'POST', body: JSON.stringify({ monto_adeudado: parseFloat(monto) }) });
        const r = await leerRespuestaGasto(res);
        Swal.fire({ icon: 'success', title: 'Listo', text: r.mensaje, background: '#111C2A', color: '#fff' });
        cargarCajaFuerte();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function pagarResumenTarjeta() {
    const { value: form } = await Swal.fire({
        title: 'Pagar resumen',
        html: `
            <p class="small text-muted">Sale de la caja fuerte o del banco y baja la deuda. No es un gasto.</p>
            <select id="swal-res-origen" class="swal2-select">
                <option value="CAJA_FUERTE">Caja fuerte</option>
                <option value="BANCO">Banco</option>
            </select>
            <input id="swal-res-monto" type="number" min="0" step="0.01" class="swal2-input" placeholder="Monto">`,
        background: '#111C2A', color: '#fff',
        showCancelButton: true,
        confirmButtonText: 'Pagar',
        preConfirm: () => {
            const monto = parseFloat(document.getElementById('swal-res-monto').value);
            if (!Number.isFinite(monto) || monto <= 0) { Swal.showValidationMessage('Cargá el monto'); return false; }
            return { origen: document.getElementById('swal-res-origen').value, monto };
        }
    });
    if (!form) return;
    try {
        const res = await apiFetchSeguro('/tesoreria/deuda/TARJETA/pagar', { method: 'POST', body: JSON.stringify(form) });
        const r = await leerRespuestaGasto(res);
        Swal.fire({ icon: 'success', title: 'Pagado', text: r.mensaje, background: '#111C2A', color: '#fff' });
        cargarCajaFuerte();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function consumoTarjeta() {
    const cats = [...document.querySelectorAll('#selectCategoriaGasto option')].filter(o => o.value)
        .map(o => `<option value="${escGasto(o.value)}">${escGasto(o.textContent)}</option>`).join('');
    const { value: form } = await Swal.fire({
        title: 'Consumo en la tarjeta',
        html: `
            <p class="small text-muted">Interés, abono o servicio. Suma lo que debés y entra como gasto del mes. La mercadería se carga en Proveedores.</p>
            <select id="swal-con-cat" class="swal2-select">${cats}</select>
            <input id="swal-con-monto" type="number" min="0" step="0.01" class="swal2-input" placeholder="Monto">
            <input id="swal-con-det" class="swal2-input" placeholder="Qué es" maxlength="200">`,
        background: '#111C2A', color: '#fff',
        showCancelButton: true,
        confirmButtonText: 'Cargar',
        preConfirm: () => {
            const monto = parseFloat(document.getElementById('swal-con-monto').value);
            const detalle = document.getElementById('swal-con-det').value.trim();
            const categoria_id = parseInt(document.getElementById('swal-con-cat').value, 10);
            if (!categoria_id) { Swal.showValidationMessage('Elegí la categoría'); return false; }
            if (!Number.isFinite(monto) || monto <= 0) { Swal.showValidationMessage('Cargá el monto'); return false; }
            if (detalle.length < 3) { Swal.showValidationMessage('Escribí qué es'); return false; }
            return { categoria_id, monto, detalle };
        }
    });
    if (!form) return;
    try {
        const res = await apiFetchSeguro('/tesoreria/deuda/TARJETA/consumo', { method: 'POST', body: JSON.stringify(form) });
        const r = await leerRespuestaGasto(res);
        Swal.fire({ icon: 'success', title: 'Cargado', text: r.mensaje, background: '#111C2A', color: '#fff' });
        cargarCajaFuerte();
        cargarResumenMensual();
        cargarHistorial();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

// Asegurate de que tu DOMContentLoaded final quede así:
document.addEventListener('DOMContentLoaded', () => {
    cargarCategorias();
    cargarResumenMensual();
    cargarHistorial();
    cargarRetirosDueno();
    cargarCajaFuerte();
    const cuentas = document.getElementById('cuentasTesoreria');
    if (cuentas) cuentas.addEventListener('click', (e) => {
        const pasar = e.target.closest('#btnPasarPlata');
        if (pasar) { pasarPlataEntreCuentas(); return; }
        const teso = (e.target.closest('[data-teso]') || {}).getAttribute ? e.target.closest('[data-teso]').getAttribute('data-teso') : '';
        if (teso === 'deuda-saldo') { fijarDeudaTarjeta(); return; }
        if (teso === 'deuda-pagar') { pagarResumenTarjeta(); return; }
        if (teso === 'deuda-consumo') { consumoTarjeta(); return; }
        const btn = e.target.closest('[data-teso]');
        if (!btn) return;
        const cuenta = btn.getAttribute('data-cuenta');
        const accion = btn.getAttribute('data-teso');
        if (accion === 'arqueo') hacerArqueoCajaFuerte(cuenta);
        else if (accion === 'movs') verMovimientosCajaFuerte(cuenta);
        else if (accion === 'pend') verPorRecibir(cuenta);
    });
    const btnCheque = document.getElementById('btnEmitirCheque');
    if (btnCheque) btnCheque.addEventListener('click', emitirCheque);
    const tabCheques = document.querySelector('[data-bs-target="#tabCheques"]');
    if (tabCheques) tabCheques.addEventListener('shown.bs.tab', verCheques);
    const btnGestion = document.getElementById('btnGestionCategorias');
    if (btnGestion) btnGestion.addEventListener('click', abrirGestionCategorias);
    const btnRetiro = document.getElementById('btnRetiroDueno');
    if (btnRetiro) btnRetiro.addEventListener('click', registrarRetiroDueno);
    const btnVer = document.getElementById('btnVerRetiros');
    if (btnVer) btnVer.addEventListener('click', verRetirosDueno);
});