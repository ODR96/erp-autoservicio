// frontend/js/app_rrhh.js
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

const usuarioIdActual = parseInt(localStorage.getItem('usuario_id')) || 1;

let empleadoActivo = null;   // { id, nombre_completo, ... }
let tarifaVigenteActiva = null; // { modalidad_pago, valor, ... } o null

// Ancla "hoy" a la hora de Argentina (UTC-3) de forma FIJA, sin depender de cómo esté
// configurada la zona horaria del sistema operativo de esta PC/celular (puede estar mal
// configurada, sobre todo en mobile) ni de toISOString() (que da la fecha en UTC, no en
// Argentina). Date.now() siempre es la hora UTC real y correcta sin importar el reloj local;
// a partir de ahí restamos 3hs a mano, exactamente lo mismo que hace el backend con
// ZONA_AR = timezone(timedelta(hours=-3)) en rutas_rrhh.py. Esto evita que un parte de
// trabajo o una liquidación cargados de noche queden guardados con la fecha del día siguiente.
function fechaHoyArgentina(offsetDias = 0) {
    const ARGENTINA_OFFSET_MS = -3 * 60 * 60 * 1000;
    const fechaAR = new Date(Date.now() + ARGENTINA_OFFSET_MS + offsetDias * 24 * 60 * 60 * 1000);
    // Usamos los getters UTC porque el offset de Argentina ya se aplicó a mano arriba;
    // si usáramos los getters locales, se sumaría OTRA vez la zona horaria del sistema.
    const anio = fechaAR.getUTCFullYear();
    const mes = String(fechaAR.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(fechaAR.getUTCDate()).padStart(2, '0');
    return `${anio}-${mes}-${dia}`;
}

// Convierte YYYY-MM-DD (lo que guarda el backend y el <input type="date">) a DD/MM/YYYY,
// para que en una PC en inglés el usuario vea el mismo formato de fecha que usa el local
// y no confunda 08/09 (8 de septiembre) con August 9.
function formatoFechaAR(iso) {
    if (!iso) return '';
    const parte = String(iso).split(' ')[0];
    const bits = parte.split('-');
    if (bits.length !== 3) return iso;
    return `${bits[2]}/${bits[1]}/${bits[0]}`;
}

function actualizarHintsFechaLiquidacion() {
    const desde = document.getElementById('liqDesde');
    const hasta = document.getElementById('liqHasta');
    const hintDesde = document.getElementById('liqDesdeHint');
    const hintHasta = document.getElementById('liqHastaHint');
    const hintAsist = document.getElementById('asistFechaHint');
    if (hintDesde) hintDesde.innerText = desde && desde.value ? `= ${formatoFechaAR(desde.value)}` : '';
    if (hintHasta) hintHasta.innerText = hasta && hasta.value ? `= ${formatoFechaAR(hasta.value)}` : '';
    if (hintAsist) {
        const asist = document.getElementById('asistFecha');
        hintAsist.innerText = asist && asist.value ? `(día/mes/año: ${formatoFechaAR(asist.value)})` : '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    cargarSelectorEmpleados();
    cargarCategoriasGasto();
    document.getElementById('asistFecha').value = fechaHoyArgentina();
    document.getElementById('tarifaVigenteDesde').value = fechaHoyArgentina();

    document.getElementById('liqDesde').value = fechaHoyArgentina(-7);
    document.getElementById('liqHasta').value = fechaHoyArgentina();
    actualizarHintsFechaLiquidacion();
    ['liqDesde', 'liqHasta', 'asistFecha', 'tarifaVigenteDesde'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', actualizarHintsFechaLiquidacion);
    });

    // Enter-to-confirm en los formularios sueltos de la página (no son modales de SweetAlert,
    // así que no hay didOpen: atamos el Enter a mano, mismo criterio que el resto del sistema).
    atarEnterA(['tarifaValor', 'tarifaVigenteDesde'], 'guardarTarifa');
    atarEnterA(['asistHoras', 'asistObs'], 'guardarAsistencia');
    atarEnterA(['liqDesde', 'liqHasta'], 'calcularPreviewLiquidacion');
});

// Helper genérico: al presionar Enter en cualquiera de los inputs indicados, ejecuta la función
// global dada (por nombre) — evita repetir el mismo listener pegado a mano en cada formulario.
function atarEnterA(idsInputs, nombreFuncionGlobal) {
    idsInputs.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                window[nombreFuncionGlobal]();
            }
        });
    });
}

// Helper genérico para modales de SweetAlert: ata Enter -> Swal.clickConfirm() a todos los
// inputs/selects del popup, salvo los que se pasen explícitamente a excluir (por su id), porque
// esos ya tienen su propia lógica de teclado (ej: buscador con flechas + Enter propio).
function atarEnterConfirmarSwal(popup, idsExcluir = []) {
    popup.querySelectorAll('input, select').forEach(el => {
        if (idsExcluir.includes(el.id)) return;
        el.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                Swal.clickConfirm();
            }
        });
    });
}

// =====================================================================
// SELECTOR DE EMPLEADO
// =====================================================================
async function cargarSelectorEmpleados() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/usuarios/listar`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const select = document.getElementById('selectorEmpleado');
        data.usuarios.filter(u => u.estado === 'ACTIVO').forEach(u => {
            select.innerHTML += `<option value="${u.id}">${u.nombre_completo} (${u.rol})</option>`;
        });
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar la lista de empleados: ' + e.message, 'error');
    }
}

function cambiarEmpleadoActivo() {
    const id = document.getElementById('selectorEmpleado').value;
    if (!id) {
        document.getElementById('panelEmpleado').style.display = 'none';
        document.getElementById('avisoSinEmpleado').style.display = 'block';
        empleadoActivo = null;
        return;
    }
    empleadoActivo = { id: parseInt(id) };
    document.getElementById('panelEmpleado').style.display = 'block';
    document.getElementById('avisoSinEmpleado').style.display = 'none';

    cargarTarifaVigente();
    cargarHistorialTarifas();
    cargarAsistencia();
    cargarCuentaEmpleado();
    document.getElementById('previewLiquidacion').style.display = 'none';
    cargarLiquidaciones();
}

function cambiarPestanaRRHH(id, evento) {
    document.querySelectorAll('#rrhhTabs .nav-link').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#panelEmpleado .tab-pane').forEach(el => el.classList.remove('active'));
    evento.target.classList.add('active');
    document.getElementById('tabrrhh-' + id).classList.add('active');
}

// =====================================================================
// TAB 1: TARIFAS
// =====================================================================
async function cargarTarifaVigente() {
    const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/tarifa_vigente/${empleadoActivo.id}`);
    const data = await res.json();
    tarifaVigenteActiva = data.tarifa || null;

    const aviso = document.getElementById('avisoModalidadAsistencia');
    const grupoPresente = document.getElementById('grupoPresente');
    const grupoHoras = document.getElementById('grupoHoras');

    const avisoLiquidar = document.getElementById('avisoTarifaLiquidar');

    if (!tarifaVigenteActiva) {
        aviso.className = 'alert alert-warning small py-2';
        aviso.innerText = 'Este empleado no tiene una tarifa configurada todavía. Cargá una en la pestaña "Tarifa / Sueldo".';
        grupoPresente.style.display = 'none';
        grupoHoras.style.display = 'none';
        if (avisoLiquidar) {
            avisoLiquidar.className = 'alert alert-warning small py-2 mb-3';
            avisoLiquidar.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Este empleado no tiene tarifa configurada: no se puede liquidar todavía.';
        }
        return;
    }

    if (tarifaVigenteActiva.modalidad_pago === 'MENSUAL') {
        aviso.className = 'alert alert-secondary small py-2';
        aviso.innerText = 'Este empleado cobra sueldo MENSUAL fijo: no necesita cargar asistencia para liquidar.';
        grupoPresente.style.display = 'none';
        grupoHoras.style.display = 'none';
    } else if (tarifaVigenteActiva.modalidad_pago === 'JORNAL') {
        aviso.className = 'alert alert-info small py-2';
        aviso.innerText = `Cobra por JORNAL: $${tarifaVigenteActiva.valor} por día trabajado.`;
        grupoPresente.style.display = 'block';
        grupoHoras.style.display = 'none';
    } else {
        aviso.className = 'alert alert-info small py-2';
        aviso.innerText = `Cobra POR HORA: $${tarifaVigenteActiva.valor} la hora.`;
        grupoPresente.style.display = 'none';
        grupoHoras.style.display = 'block';
    }

    // Mismo aviso, pero en la pestaña de Liquidar: la causa #1 de "no puedo liquidar tal
    // fecha" es que el período elegido empieza ANTES de que esta tarifa esté vigente
    // (no cubre retroactivamente). Mostrarlo acá, antes de que el usuario ni intente
    // calcular, ahorra una vuelta de "por qué no me deja".
    if (avisoLiquidar) {
        avisoLiquidar.className = 'alert alert-secondary small py-2 mb-3';
        avisoLiquidar.innerHTML = `<i class="bi bi-info-circle"></i> Tarifa vigente desde <b>${formatoFechaAR(tarifaVigenteActiva.vigente_desde)}</b>. ` +
            `No se puede liquidar un período que empiece antes de esa fecha.`;
    }
}

async function cargarHistorialTarifas() {
    const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/tarifas/${empleadoActivo.id}`);
    const data = await res.json();
    const tbody = document.getElementById('tablaTarifasBody');
    tbody.innerHTML = '';

    if (!data.tarifas || data.tarifas.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">Sin tarifas cargadas.</td></tr>';
        return;
    }

    data.tarifas.forEach(t => {
        const vigencia = t.vigente_hasta
            ? `${formatoFechaAR(t.vigente_desde)} a ${formatoFechaAR(t.vigente_hasta)}`
            : `Desde ${formatoFechaAR(t.vigente_desde)} (Vigente)`;
        tbody.innerHTML += `
            <tr class="${!t.vigente_hasta ? 'table-success' : ''}">
                <td>${t.modalidad_pago}</td>
                <td>$${t.valor}</td>
                <td>${t.periodicidad_pago}</td>
                <td class="small">${vigencia}</td>
            </tr>
        `;
    });
}

async function guardarTarifa() {
    const valor = parseFloat(document.getElementById('tarifaValor').value);
    const vigenteDesde = document.getElementById('tarifaVigenteDesde').value;
    if (!valor || valor <= 0) return Swal.fire('Atención', 'Ingresá un valor válido.', 'warning');
    if (!vigenteDesde) return Swal.fire('Atención', 'Elegí la fecha de vigencia.', 'warning');

    const payload = {
        usuario_id: empleadoActivo.id,
        modalidad_pago: document.getElementById('tarifaModalidad').value,
        periodicidad_pago: document.getElementById('tarifaPeriodicidad').value,
        valor: valor,
        vigente_desde: vigenteDesde,
        creado_por: usuarioIdActual
    };

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/tarifas`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        Swal.fire('¡Listo!', data.mensaje, 'success');
        document.getElementById('tarifaValor').value = '';
        cargarTarifaVigente();
        cargarHistorialTarifas();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// =====================================================================
// TAB 2: ASISTENCIA
// =====================================================================
async function guardarAsistencia() {
    if (!tarifaVigenteActiva) return Swal.fire('Atención', 'Configurá primero una tarifa para este empleado.', 'warning');

    const payload = {
        usuario_id: empleadoActivo.id,
        fecha: document.getElementById('asistFecha').value,
        presente: tarifaVigenteActiva.modalidad_pago === 'POR_HORA' ? 1 : parseFloat(document.getElementById('asistPresente').value),
        horas_trabajadas: tarifaVigenteActiva.modalidad_pago === 'POR_HORA' ? parseFloat(document.getElementById('asistHoras').value || 0) : null,
        observaciones: document.getElementById('asistObs').value,
        registrado_por: usuarioIdActual
    };

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/asistencia`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        Swal.fire('¡Listo!', data.mensaje, 'success');
        document.getElementById('asistObs').value = '';
        cargarAsistencia();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function cargarAsistencia() {
    const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/asistencia/${empleadoActivo.id}`);
    const data = await res.json();
    const tbody = document.getElementById('tablaAsistenciaBody');
    tbody.innerHTML = '';

    if (!data.partes || data.partes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">Sin registros.</td></tr>';
    } else {
        data.partes.slice(0, 30).forEach(p => {
            const estado = p.liquidacion_id ? '<span class="badge bg-secondary">Liquidado</span>' : '<span class="badge bg-warning text-dark">Pendiente</span>';
            tbody.innerHTML += `
                <tr>
                    <td>${formatoFechaAR(p.fecha)}</td>
                    <td>${p.presente}</td>
                    <td>${p.horas_trabajadas ?? '-'}</td>
                    <td>${estado}</td>
                </tr>
            `;
        });
    }

    const resumen = document.getElementById('resumenPendienteAsistencia');
    if (data.resumen_pendiente) {
        resumen.innerText = `Pendiente: ${data.resumen_pendiente.dias_pendientes} días / ${data.resumen_pendiente.horas_pendientes} hs`;
    }

    // En la pestaña Liquidar: mostramos los días pendientes como chips clickeables y
    // rellenamos el período con el primero y el último, para no depender del calendario
    // nativo (en Windows en inglés muestra mes/día y es fácil elegir mal el 8 de septiembre).
    const pendientes = (data.partes || []).filter(p => !p.liquidacion_id).map(p => p.fecha).sort();
    const chips = document.getElementById('liqDiasPendientes');
    if (chips) {
        if (pendientes.length === 0) {
            chips.innerHTML = '<span class="text-muted small">No hay días de asistencia pendientes de pago.</span>';
        } else {
            chips.innerHTML = pendientes.map(f =>
                `<button type="button" class="btn btn-sm btn-outline-dark me-1 mb-1" data-fecha="${f}">${formatoFechaAR(f)}</button>`
            ).join('');
            chips.querySelectorAll('button[data-fecha]').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.getElementById('liqDesde').value = btn.dataset.fecha;
                    document.getElementById('liqHasta').value = btn.dataset.fecha;
                    actualizarHintsFechaLiquidacion();
                });
            });
            document.getElementById('liqDesde').value = pendientes[0];
            document.getElementById('liqHasta').value = pendientes[pendientes.length - 1];
            actualizarHintsFechaLiquidacion();
        }
    }
}

// =====================================================================
// TAB 3: CUENTA CORRIENTE (ADELANTOS Y CONSUMOS)
// =====================================================================
async function cargarCuentaEmpleado() {
    const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/cuenta_empleado/${empleadoActivo.id}`);
    const data = await res.json();

    document.getElementById('saldoPendienteEmpleado').innerText = `$${data.saldo_pendiente}`;

    const tbody = document.getElementById('tablaCuentaEmpleadoBody');
    tbody.innerHTML = '';
    if (!data.movimientos || data.movimientos.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Sin movimientos.</td></tr>';
        return;
    }
    data.movimientos.forEach(m => {
        const montoSaldado = m.monto_saldado || 0;
        let estado;
        if (m.liquidacion_id) {
            estado = '<span class="badge bg-secondary">Saldado</span>';
        } else if (montoSaldado > 0) {
            // Deuda grande que se cobró de a partes: ya se le descontó algo pero todavía
            // queda un resto pendiente para la próxima liquidación.
            estado = `<span class="badge bg-warning text-dark" title="Ya se descontaron $${montoSaldado}">Parcial: falta $${m.saldo_restante}</span>`;
        } else {
            estado = '<span class="badge bg-danger">Pendiente</span>';
        }
        tbody.innerHTML += `
            <tr>
                <td class="small">${m.fecha_hora}</td>
                <td>${m.tipo_movimiento}</td>
                <td class="small">${m.detalle || ''}</td>
                <td class="text-end fw-bold">$${m.monto}</td>
                <td class="text-center">${estado}</td>
            </tr>
        `;
    });
}

async function abrirModalAdelanto() {
    Swal.fire({ title: 'Buscando cajas abiertas...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });
    let turnos = [];
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/caja/monitor_vivo`);
        const data = await res.json();
        turnos = data.turnos_vivos || [];
    } catch (e) { /* seguimos igual, se avisa abajo */ }
    Swal.close();

    if (turnos.length === 0) {
        return Swal.fire('Sin cajas abiertas', 'Necesitás una caja abierta para poder entregar el adelanto en efectivo.', 'warning');
    }

    let opcionesTurno = turnos.map(t => `<option value="${t.turno_id}">Caja #${t.caja_id} - ${t.cajero || 'Sin cajero'}</option>`).join('');

    const { value: formValues } = await Swal.fire({
        title: 'Dar Adelanto de Sueldo',
        html: `
            <input id="swal-monto" type="number" class="swal2-input" placeholder="Monto ($)">
            <select id="swal-turno" class="swal2-select">${opcionesTurno}</select>
            <input id="swal-detalle" type="text" class="swal2-input" placeholder="Detalle (Ej: Adelanto quincena)">
            <input id="swal-pin" type="password" class="swal2-input" placeholder="Tu PIN de Administrador">
        `,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Registrar Adelanto (Enter)',
        confirmButtonColor: '#f59e0b',
        didOpen: (popup) => {
            atarEnterConfirmarSwal(popup);
            setTimeout(() => document.getElementById('swal-monto').focus(), 300);
        },
        preConfirm: () => {
            const monto = parseFloat(document.getElementById('swal-monto').value);
            const detalle = document.getElementById('swal-detalle').value;
            const pin = document.getElementById('swal-pin').value;
            const turnoId = document.getElementById('swal-turno').value;
            if (!monto || monto <= 0) { Swal.showValidationMessage('Ingresá un monto válido'); return false; }
            if (!detalle) { Swal.showValidationMessage('Ingresá un detalle'); return false; }
            if (!pin) { Swal.showValidationMessage('Ingresá tu PIN'); return false; }
            return { monto, detalle, pin, turnoId };
        }
    });

    if (!formValues) return;

    try {
        Swal.fire({ title: 'Procesando...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });
        const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/cuenta_empleado/adelanto`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                usuario_id: empleadoActivo.id, monto: formValues.monto, detalle: formValues.detalle,
                turno_id: parseInt(formValues.turnoId), usuario_registro: usuarioIdActual, pin_autorizante: formValues.pin
            })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        Swal.fire('¡Listo!', data.mensaje, 'success');
        cargarCuentaEmpleado();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// Estado del buscador de productos del modal de Consumo (patrón idéntico al F3 del POS:
// debounce + navegación con flechas + Enter para elegir la fila resaltada).
let rrhhProductoSeleccionado = null;
let rrhhIndexResultado = -1;
let rrhhTimeoutBusqueda = null;

async function abrirModalConsumo() {
    rrhhProductoSeleccionado = null;
    rrhhIndexResultado = -1;

    const { value: formValues } = await Swal.fire({
        title: 'Registrar Consumo de Mercadería',
        width: 480,
        html: `
            <style>
                .rrhh-form { text-align: left; }
                .rrhh-form label { display: block; font-weight: 700; font-size: 0.78rem; text-transform: uppercase;
                    letter-spacing: .03em; color: #6c757d; margin: 14px 0 4px; }
                .rrhh-form label:first-of-type { margin-top: 0; }
                .rrhh-form .swal2-input, .rrhh-form .swal2-select { margin: 0 !important; width: 100% !important; }
                .rrhh-buscar-wrap { position: relative; }
                .rrhh-resultados { position: absolute; top: 100%; left: 0; right: 0; background: #fff;
                    border: 1px solid #ced4da; border-top: none; max-height: 230px; overflow-y: auto;
                    z-index: 30; border-radius: 0 0 10px 10px; box-shadow: 0 8px 16px rgba(0,0,0,.12); text-align: left; }
                .rrhh-fila-resultado { padding: 8px 14px; cursor: pointer; display: flex; justify-content: space-between;
                    align-items: center; font-size: .88rem; gap: 8px; }
                .rrhh-fila-resultado:hover, .rrhh-fila-resultado.activa { background: #0d6efd; color: #fff; }
                .rrhh-fila-resultado .rrhh-fila-stock { font-size: .75rem; opacity: .8; white-space: nowrap; }
                .rrhh-chip { display: none; align-items: center; justify-content: space-between; gap: 10px;
                    background: #eef6ff; border: 1px solid #0d6efd; border-radius: 10px; padding: 10px 14px; }
                .rrhh-chip.activo { display: flex; }
                .rrhh-chip strong { color: #0d47a1; }
                .rrhh-chip small { display: block; color: #495057; }
                .rrhh-chip button { border: none; background: transparent; color: #dc3545; font-weight: 700;
                    cursor: pointer; font-size: .85rem; }
                .rrhh-precio-box { display: none; background: #fff8e6; border: 1px solid #ffca2c; border-radius: 10px;
                    padding: 10px 14px; margin-top: 14px; font-size: .95rem; }
                .rrhh-precio-box.activo { display: block; }
                .rrhh-precio-box .rrhh-monto { font-weight: 800; font-size: 1.25rem; color: #664d03; }
                .rrhh-sin-resultados { padding: 10px 14px; font-size: .85rem; color: #6c757d; }
            </style>
            <div class="rrhh-form">
                <label>Buscar producto (nombre o código) — usá ↑ ↓ y Enter</label>
                <div class="rrhh-buscar-wrap">
                    <input id="rrhh-buscar" type="text" class="swal2-input" autocomplete="off" placeholder="Ej: Fernet, Coca 1.5L...">
                    <div id="rrhh-resultados" class="rrhh-resultados" style="display:none;"></div>
                </div>
                <div id="rrhh-chip" class="rrhh-chip">
                    <div>
                        <strong id="rrhh-chip-nombre"></strong>
                        <small id="rrhh-chip-detalle"></small>
                    </div>
                    <button type="button" id="rrhh-chip-quitar">✕ Quitar</button>
                </div>

                <label>Cantidad</label>
                <input id="rrhh-cantidad" type="number" class="swal2-input" min="0.01" step="0.01" placeholder="Ej: 1">

                <label>¿Quién se hace cargo?</label>
                <select id="rrhh-resolucion" class="swal2-select">
                    <option value="DESCUENTA_SUELDO">Se lo descuento al empleado (precio de venta)</option>
                    <option value="GASTO_LOCAL">Lo regala el local (a costo — es Gasto Operativo)</option>
                </select>

                <div id="rrhh-grupo-categoria" style="display:none;">
                    <label>Categoría de Gasto</label>
                    <select id="rrhh-categoria-consumo" class="swal2-select"></select>
                </div>

                <div id="rrhh-precio-box" class="rrhh-precio-box">
                    Monto que se va a registrar: <span id="rrhh-precio-monto" class="rrhh-monto">$0</span>
                </div>

                <label>Detalle (opcional)</label>
                <input id="rrhh-detalle" type="text" class="swal2-input" autocomplete="off" placeholder="Detalle">

                <label>Tu PIN de Administrador</label>
                <input id="rrhh-pin" type="password" class="swal2-input" autocomplete="off" placeholder="PIN">
            </div>
        `,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Registrar Consumo (Enter)',
        confirmButtonColor: '#dc3545',
        didOpen: () => {
            const inputBuscar = document.getElementById('rrhh-buscar');
            const divResultados = document.getElementById('rrhh-resultados');
            const chip = document.getElementById('rrhh-chip');
            const selectResolucion = document.getElementById('rrhh-resolucion');
            const selectCategoria = document.getElementById('rrhh-categoria-consumo');
            const inputCantidad = document.getElementById('rrhh-cantidad');

            categoriasGastoCache.forEach(c => {
                selectCategoria.innerHTML += `<option value="${c.id}">${c.nombre}</option>`;
            });

            const actualizarPrecioPreview = () => {
                const box = document.getElementById('rrhh-precio-box');
                const montoSpan = document.getElementById('rrhh-precio-monto');
                if (!rrhhProductoSeleccionado) { box.classList.remove('activo'); return; }

                const cantidad = parseFloat(inputCantidad.value) || 0;
                const esDescuentoSueldo = selectResolucion.value === 'DESCUENTA_SUELDO';
                const unitario = esDescuentoSueldo
                    ? (rrhhProductoSeleccionado.precio_venta_final || 0)
                    : (rrhhProductoSeleccionado.costo_sin_iva || 0);
                const total = Math.round(unitario * cantidad * 100) / 100;

                box.classList.add('activo');
                montoSpan.innerText = `$${total} ${esDescuentoSueldo ? '(precio de venta)' : '(a costo)'}`;
            };

            const seleccionarProducto = (p) => {
                rrhhProductoSeleccionado = p;
                document.getElementById('rrhh-chip-nombre').innerText = p.nombre;
                document.getElementById('rrhh-chip-detalle').innerText = `Stock disponible: ${p.stock_actual} · Costo: $${p.costo_sin_iva} · Venta: $${p.precio_venta_final}`;
                chip.classList.add('activo');
                inputBuscar.style.display = 'none';
                divResultados.style.display = 'none';
                inputBuscar.value = '';
                actualizarPrecioPreview();
                inputCantidad.focus();
            };

            document.getElementById('rrhh-chip-quitar').addEventListener('click', () => {
                rrhhProductoSeleccionado = null;
                chip.classList.remove('activo');
                inputBuscar.style.display = 'block';
                actualizarPrecioPreview();
                inputBuscar.focus();
            });

            selectResolucion.addEventListener('change', () => {
                document.getElementById('rrhh-grupo-categoria').style.display = selectResolucion.value === 'GASTO_LOCAL' ? 'block' : 'none';
                actualizarPrecioPreview();
            });
            inputCantidad.addEventListener('input', actualizarPrecioPreview);

            const resaltarFila = (filas) => {
                filas.forEach((f, i) => f.classList.toggle('activa', i === rrhhIndexResultado));
                if (rrhhIndexResultado >= 0) filas[rrhhIndexResultado].scrollIntoView({ block: 'nearest' });
            };

            inputBuscar.addEventListener('input', () => {
                clearTimeout(rrhhTimeoutBusqueda);
                const termino = inputBuscar.value.trim();
                rrhhIndexResultado = -1;
                if (termino.length < 2) { divResultados.style.display = 'none'; return; }

                rrhhTimeoutBusqueda = setTimeout(async () => {
                    try {
                        const res = await apiFetch(`${obtenerBaseUrl()}/productos/buscar?q=${encodeURIComponent(termino)}`);
                        const data = await res.json();
                        const productos = data.productos || [];

                        if (productos.length === 0) {
                            divResultados.innerHTML = '<div class="rrhh-sin-resultados">Sin resultados.</div>';
                        } else {
                            divResultados.innerHTML = productos.map(p => `
                                <div class="rrhh-fila-resultado" data-id="${p.id}">
                                    <span>${p.nombre}</span>
                                    <span class="rrhh-fila-stock">Stock: ${p.stock_actual}</span>
                                </div>
                            `).join('');
                            divResultados.querySelectorAll('.rrhh-fila-resultado').forEach(fila => {
                                fila.addEventListener('click', () => {
                                    const p = productos.find(x => x.id == fila.dataset.id);
                                    if (p) seleccionarProducto(p);
                                });
                            });
                        }
                        divResultados.style.display = 'block';
                        divResultados._productos = productos;
                    } catch (e) { /* silencioso */ }
                }, 300);
            });

            inputBuscar.addEventListener('keydown', (e) => {
                const filas = divResultados.querySelectorAll('.rrhh-fila-resultado');
                if (filas.length === 0) return;

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    rrhhIndexResultado = (rrhhIndexResultado + 1) % filas.length;
                    resaltarFila(filas);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    rrhhIndexResultado = (rrhhIndexResultado - 1 + filas.length) % filas.length;
                    resaltarFila(filas);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const indice = rrhhIndexResultado >= 0 ? rrhhIndexResultado : 0;
                    filas[indice].click();
                } else if (e.key === 'Escape') {
                    divResultados.style.display = 'none';
                }
            });

            // El buscador tiene su propia lógica de Enter (elegir la fila resaltada), así que
            // se excluye del atado genérico para no pisarla.
            atarEnterConfirmarSwal(document.querySelector('.swal2-popup'), ['rrhh-buscar']);

            setTimeout(() => inputBuscar.focus(), 300);
        },
        preConfirm: () => {
            const cantidad = parseFloat(document.getElementById('rrhh-cantidad').value);
            const resolucion = document.getElementById('rrhh-resolucion').value;
            const categoriaId = document.getElementById('rrhh-categoria-consumo').value;
            const detalle = document.getElementById('rrhh-detalle').value;
            const pin = document.getElementById('rrhh-pin').value;

            if (!rrhhProductoSeleccionado) { Swal.showValidationMessage('Elegí un producto de la lista de búsqueda'); return false; }
            if (!cantidad || cantidad <= 0) { Swal.showValidationMessage('Ingresá una cantidad válida'); return false; }
            if (cantidad > rrhhProductoSeleccionado.stock_actual) { Swal.showValidationMessage(`Solo hay ${rrhhProductoSeleccionado.stock_actual} unidades en stock`); return false; }
            if (resolucion === 'GASTO_LOCAL' && !categoriaId) { Swal.showValidationMessage('Elegí la categoría de gasto'); return false; }
            if (!pin) { Swal.showValidationMessage('Ingresá tu PIN'); return false; }

            return { productoId: rrhhProductoSeleccionado.id, cantidad, resolucion, categoriaId, detalle, pin };
        }
    });

    if (!formValues) return;

    try {
        Swal.fire({ title: 'Procesando...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });
        const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/cuenta_empleado/consumo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                usuario_id: empleadoActivo.id, producto_id: parseInt(formValues.productoId), cantidad: formValues.cantidad,
                resolucion: formValues.resolucion,
                categoria_gasto_id: formValues.categoriaId ? parseInt(formValues.categoriaId) : null,
                detalle: formValues.detalle, usuario_registro: usuarioIdActual, pin_autorizante: formValues.pin
            })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        Swal.fire('¡Listo!', data.mensaje, 'success');
        cargarCuentaEmpleado();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// =====================================================================
// TAB 4: LIQUIDAR SUELDO
// =====================================================================
let categoriasGastoCache = [];
async function cargarCategoriasGasto() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/gastos/categorias`);
        const data = await res.json();
        // Un sueldo (o un consumo que el local regala) SIEMPRE es un Gasto Operativo real:
        // impacta la rentabilidad. Por eso acá solo mostramos categorías tipo OPERATIVO,
        // nunca RETIRO_SOCIO (esas son retiros de plata del dueño, otra cosa totalmente distinta).
        categoriasGastoCache = (data.categorias || []).filter(c => (c.tipo_categoria || 'OPERATIVO') === 'OPERATIVO');
        const select = document.getElementById('liqCategoriaGasto');
        select.innerHTML = categoriasGastoCache.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
    } catch (e) { console.error('No se pudieron cargar las categorías de gasto', e); }
}

let ultimoPreview = null;
async function calcularPreviewLiquidacion() {
    const desde = document.getElementById('liqDesde').value;
    const hasta = document.getElementById('liqHasta').value;
    if (!desde || !hasta) return Swal.fire('Atención', 'Elegí el período completo.', 'warning');

    try {
        const params = new URLSearchParams({ usuario_id: empleadoActivo.id, periodo_desde: desde, periodo_hasta: hasta });
        const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/liquidar/preview?${params.toString()}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        ultimoPreview = data;
        document.getElementById('previewLiquidacion').style.display = 'block';

        // Detalle itemizado de qué deudas se están cobrando (y si quedan pagadas del todo o
        // solo en parte), para que quede clarísimo por qué el descuento no es "todo o nada".
        let filasDetalle = '';
        if (data.detalle_descuentos && data.detalle_descuentos.length > 0) {
            filasDetalle = data.detalle_descuentos.map(d => `
                <tr>
                    <td class="small ps-4">↳ ${d.detalle || 'Movimiento #' + d.movimiento_id}</td>
                    <td class="text-end small ${d.queda_saldado ? 'text-success' : 'text-warning'}">
                        -$${d.monto_aplicado} ${d.queda_saldado ? '(saldado)' : '(pago parcial)'}
                    </td>
                </tr>
            `).join('');
        }

        document.getElementById('tablaPreviewLiquidacion').innerHTML = `
            <tr><td>Modalidad</td><td class="text-end fw-bold">${data.modalidad}</td></tr>
            <tr><td>Unidades (días/hs/meses)</td><td class="text-end fw-bold">${data.cantidad_unidades}</td></tr>
            <tr><td>Valor unitario</td><td class="text-end">$${data.valor_unitario}</td></tr>
            <tr><td>Bruto</td><td class="text-end fw-bold text-primary">$${data.monto_bruto}</td></tr>
            <tr><td>Descuentos (tope ${data.tope_pct_usado}%)</td><td class="text-end text-danger">-$${data.descuento_aplicado}</td></tr>
            ${filasDetalle}
            <tr class="table-success"><td class="fw-bold">NETO A PAGAR</td><td class="text-end fw-bold fs-5">$${data.monto_neto_estimado}</td></tr>
            <tr><td class="small text-muted">Saldo que queda pendiente</td><td class="text-end small text-muted">$${data.saldo_pendiente_arrastrado}</td></tr>
        `;
    } catch (e) {
        document.getElementById('previewLiquidacion').style.display = 'none';
        Swal.fire('No se puede liquidar', e.message, 'warning');
    }
}

async function confirmarLiquidacion() {
    if (!ultimoPreview) return;
    const categoriaId = document.getElementById('liqCategoriaGasto').value;
    if (!categoriaId) return Swal.fire('Atención', 'Elegí la categoría de gasto.', 'warning');

    const { value: pin } = await Swal.fire({
        title: `Confirmar pago de $${ultimoPreview.monto_neto_estimado}`,
        html: `<p>Empleado: <b>${ultimoPreview.empleado}</b><br>Esta acción impacta la rentabilidad del mes por el monto BRUTO ($${ultimoPreview.monto_bruto}).</p><input id="swal-pin" type="password" class="swal2-input" placeholder="Tu PIN de Administrador">`,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Confirmar y Pagar (Enter)',
        confirmButtonColor: '#dc3545',
        didOpen: (popup) => {
            atarEnterConfirmarSwal(popup);
            setTimeout(() => document.getElementById('swal-pin').focus(), 300);
        },
        preConfirm: () => {
            const pin = document.getElementById('swal-pin').value;
            if (!pin) { Swal.showValidationMessage('Ingresá tu PIN'); return false; }
            return pin;
        }
    });

    if (!pin) return;

    const desde = document.getElementById('liqDesde').value;
    const hasta = document.getElementById('liqHasta').value;

    try {
        Swal.fire({ title: 'Liquidando...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });
        const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/liquidar`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                usuario_id: empleadoActivo.id, periodo_desde: desde, periodo_hasta: hasta,
                categoria_gasto_id: parseInt(categoriaId), liquidado_por: usuarioIdActual, pin_autorizante: pin
            })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        Swal.fire('¡Liquidación generada!', data.resumen.nota, 'success');
        document.getElementById('previewLiquidacion').style.display = 'none';
        ultimoPreview = null;
        cargarCuentaEmpleado();
        cargarAsistencia();
        cargarLiquidaciones();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function cargarLiquidaciones() {
    const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/liquidaciones/${empleadoActivo.id}`);
    const data = await res.json();
    const tbody = document.getElementById('tablaLiquidacionesBody');
    tbody.innerHTML = '';

    if (!data.liquidaciones || data.liquidaciones.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Sin liquidaciones registradas.</td></tr>';
        return;
    }

    data.liquidaciones.forEach(l => {
        const esAnulada = l.estado === 'ANULADO';
        tbody.innerHTML += `
            <tr class="${esAnulada ? 'table-secondary text-decoration-line-through' : ''}">
                <td class="small">${formatoFechaAR(l.periodo_desde)} a ${formatoFechaAR(l.periodo_hasta)}</td>
                <td class="text-end">$${l.monto_bruto}</td>
                <td class="text-end fw-bold">$${l.monto_neto_pagado}</td>
                <td class="text-center"><span class="badge ${esAnulada ? 'bg-secondary' : 'bg-success'}">${l.estado}</span></td>
                <td class="text-center">
                    ${esAnulada ? '' : `<button class="btn btn-sm btn-outline-danger" onclick="anularLiquidacion(${l.id})" title="Anular"><i class="bi bi-x-circle"></i></button>`}
                </td>
            </tr>
        `;
    });
}

async function anularLiquidacion(id) {
    const { value: formValues } = await Swal.fire({
        title: '¿Anular esta liquidación?',
        html: `
            <p class="text-danger small">Los días/adelantos que había cerrado volverán a quedar pendientes.</p>
            <input id="swal-motivo" type="text" class="swal2-input" placeholder="Motivo de la anulación">
            <input id="swal-pin" type="password" class="swal2-input" placeholder="Tu PIN de Administrador">
        `,
        icon: 'warning',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Sí, anular (Enter)',
        confirmButtonColor: '#dc3545',
        didOpen: (popup) => {
            atarEnterConfirmarSwal(popup);
            setTimeout(() => document.getElementById('swal-motivo').focus(), 300);
        },
        preConfirm: () => {
            const motivo = document.getElementById('swal-motivo').value;
            const pin = document.getElementById('swal-pin').value;
            if (!pin) { Swal.showValidationMessage('Ingresá tu PIN'); return false; }
            return { motivo, pin };
        }
    });

    if (!formValues) return;

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/rrhh/liquidaciones/${id}/anular`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin_autorizante: formValues.pin, motivo: formValues.motivo })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        Swal.fire('Anulada', data.mensaje, 'success');
        cargarCuentaEmpleado();
        cargarAsistencia();
        cargarLiquidaciones();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}
