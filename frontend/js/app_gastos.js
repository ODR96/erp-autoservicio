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

const empleadoStorage = JSON.parse(localStorage.getItem('empleado_pos')) || {};
const idUsuarioReal = empleadoStorage.id || parseInt(localStorage.getItem('usuario_id')) || 1;

// --- 1. CARGAR CATEGORÍAS EN EL SELECTOR ---
async function cargarCategorias() {
    const selector = document.getElementById('selectCategoriaGasto');
    try {
        const res = await apiFetchSeguro('/gastos/categorias'); // Asegurate del prefijo
        const data = await res.json();
        
        selector.innerHTML = '<option value="" disabled selected>-- Elegí una categoría --</option>';
        
        if (data.categorias) {
            data.categorias.forEach(cat => {
                selector.innerHTML += `<option value="${cat.id}">${cat.nombre}</option>`;
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
                <option value="RETIRO_SOCIO">Retiro Personal / Socio</option>
                <option value="MOVIMIENTO_INTERNO">Movimiento Interno (Sangría a Caja Fuerte)</option>
            </select>
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
            const data = await res.json();
            
            if(data.error) throw new Error(data.error);
            
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
            origen_fondos: origen,
            usuario_id: idUsuarioReal        
        };

        const res = await apiFetchSeguro('/gastos/registrar', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (data.error) throw new Error(data.error);

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
            document.getElementById('kpiRetiros').innerText = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(totalRetirosSocio);
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
// saliendo de algún lado se muestran como tal. Los movimientos de RRHH (liquidaciones de
// sueldo y consumos regalados) son costos contables, no salidas de caja. ---
function mapearOrigenFondos(origen) {
    if (origen === 'CAJA_MAYOR') return { texto: 'Caja Fuerte', color: 'bg-success' };
    if (origen && origen.includes('CAJA_DIARIA')) return { texto: 'Cajón (POS)', color: 'bg-secondary' };
    if (origen === 'RRHH') return { texto: 'Sin salida de caja (Sueldo)', color: 'bg-info text-dark' };
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

            tbody.innerHTML += `
                <tr class="${esAnulado ? 'text-decoration-line-through opacity-50' : ''}">
                    <td class="text-white">${fechaCorta}</td>
                    <td class="text-start fw-bold text-info">${mov.categoria}</td>
                    <td class="text-start text-muted">${mov.detalle}</td>
                    <td>
                        <span class="badge ${origenInfo.color}">${origenInfo.texto}</span>
                        ${esAnulado ? '<span class="badge bg-danger ms-1">ANULADO</span>' : ''}
                    </td>
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
                    <td class="text-start">${c.nombre} ${inactiva ? '<span class="badge bg-secondary ms-1">Oculta</span>' : ''}</td>
                    <td class="small">${ETIQUETAS_TIPO_CATEGORIA[c.tipo_categoria] || c.tipo_categoria}</td>
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
        title: `Editar: ${cat.nombre}`,
        html: `
            <input id="swal-edit-nombre" class="swal2-input form-control-dark w-75 mx-auto" value="${cat.nombre}">
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
        const data = await res.json();
        if (data.detail || data.error) throw new Error(data.detail || data.error);

        Swal.fire({ icon: 'success', title: '¡Listo!', text: data.mensaje, background: '#111C2A', color: '#fff', timer: 1500, showConfirmButton: false });
        cargarCategorias();
        abrirGestionCategorias();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

async function eliminarCategoriaConfirmar(cat) {
    const result = await Swal.fire({
        title: `¿Eliminar "${cat.nombre}"?`,
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
        const data = await res.json();
        if (data.detail || data.error) throw new Error(data.detail || data.error);

        Swal.fire({ icon: 'success', title: '¡Listo!', text: data.mensaje, background: '#111C2A', color: '#fff' });
        cargarCategorias();
        abrirGestionCategorias();
    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff' });
    }
}

// Asegurate de que tu DOMContentLoaded final quede así:
document.addEventListener('DOMContentLoaded', () => {
    cargarCategorias();
    cargarResumenMensual();
    cargarHistorial();
    const btnGestion = document.getElementById('btnGestionCategorias');
    if (btnGestion) btnGestion.addEventListener('click', abrirGestionCategorias);
});