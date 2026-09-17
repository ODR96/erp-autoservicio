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
        const previo = selIngreso.value;
        selIngreso.innerHTML = '<option value="">-- Seleccionar Proveedor --</option>';
        proveedoresGlobales.filter(p => p.activo !== 0).forEach(p => {
            selIngreso.innerHTML += `<option value="${p.id}">${p.nombre_comercial}</option>`;
        });
        if (previo) selIngreso.value = previo;
    }
}

// ==========================================
// 2. INGRESO DE FACTURAS (GRILLA EDITABLE)
// ==========================================
const CLAVE_BORRADOR_FACTURA = 'erpetto_borrador_factura_v1';
const CLAVE_BORRADOR_ID = 'erpetto_borrador_factura_id';
let timerBorradorFactura = null;
let restaurandoBorradorFactura = false;
let borradorServidorId = null;
let fotosBorradorActual = [];
let listaBorradoresCache = [];
const blobFotosBorrador = {};

function hoyISOLocal() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function escapeHtmlFactura(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function detalleApi(data) {
    const d = data && data.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d) && d[0] && d[0].msg) return d[0].msg;
    return (data && data.error) || 'No se pudo guardar.';
}

function asegurarFechaFactura() {
    const inp = document.getElementById('inputFechaFactura');
    if (inp && !inp.value) inp.value = hoyISOLocal();
}

function leerCabeceraFactura() {
    return {
        modo: document.getElementById('panelIngresoStock')?.classList.contains('d-none') ? 'deuda' : 'stock',
        proveedor_id: document.getElementById('selectProvIngreso')?.value || '',
        numero: document.getElementById('inputNumFactura')?.value || '',
        condicion: document.getElementById('selectCondicionPago')?.value || 'Cuenta Corriente',
        fecha: document.getElementById('inputFechaFactura')?.value || hoyISOLocal(),
        cargos: document.getElementById('inputCargosExtra')?.value || '0',
        total_papel: document.getElementById('inputTotalPapel')?.value || '',
        total_deuda: document.getElementById('inputTotalDeudaRapida')?.value || '',
        obs_deuda: document.getElementById('inputObsDeudaRapida')?.value || ''
    };
}

function marcarEstadoBorradorFactura(texto) {
    const el = document.getElementById('estadoBorradorFactura');
    if (el) el.textContent = texto;
}

function payloadBorradorActual() {
    return { cab: leerCabeceraFactura(), items: facturaActualItems };
}

function borradorTieneContenido() {
    const cab = leerCabeceraFactura();
    return facturaActualItems.length > 0
        || fotosBorradorActual.length > 0
        || !!(cab.numero || '').trim()
        || !!(cab.total_deuda || '').toString().trim()
        || !!(cab.total_papel || '').toString().trim()
        || parseFloat(cab.cargos) > 0;
}

function revocarBlobsFotosBorrador() {
    Object.keys(blobFotosBorrador).forEach((k) => {
        try { URL.revokeObjectURL(blobFotosBorrador[k]); } catch (e) { /* */ }
        delete blobFotosBorrador[k];
    });
}

function guardarBorradorLocalCache() {
    if (restaurandoBorradorFactura) return;
    if (!borradorTieneContenido() && !borradorServidorId) {
        localStorage.removeItem(CLAVE_BORRADOR_FACTURA);
        localStorage.removeItem(CLAVE_BORRADOR_ID);
        return;
    }
    localStorage.setItem(CLAVE_BORRADOR_FACTURA, JSON.stringify(payloadBorradorActual()));
    if (borradorServidorId) localStorage.setItem(CLAVE_BORRADOR_ID, String(borradorServidorId));
    else localStorage.removeItem(CLAVE_BORRADOR_ID);
}

function aplicarCabeceraFactura(cab) {
    cab = cab || {};
    if (cab.modo) cambiarModoIngreso(cab.modo);
    if (document.getElementById('selectProvIngreso')) {
        document.getElementById('selectProvIngreso').value = cab.proveedor_id || '';
    }
    if (document.getElementById('inputNumFactura')) document.getElementById('inputNumFactura').value = cab.numero || '';
    if (cab.condicion && document.getElementById('selectCondicionPago')) {
        document.getElementById('selectCondicionPago').value = cab.condicion;
    }
    if (document.getElementById('inputFechaFactura')) {
        document.getElementById('inputFechaFactura').value = cab.fecha || hoyISOLocal();
    }
    if (document.getElementById('inputCargosExtra')) document.getElementById('inputCargosExtra').value = cab.cargos || '0';
    if (document.getElementById('inputTotalPapel')) document.getElementById('inputTotalPapel').value = cab.total_papel || '';
    if (document.getElementById('inputTotalDeudaRapida')) document.getElementById('inputTotalDeudaRapida').value = cab.total_deuda || '';
    if (document.getElementById('inputObsDeudaRapida')) document.getElementById('inputObsDeudaRapida').value = cab.obs_deuda || '';
}

function aplicarPayloadBorrador(data) {
    restaurandoBorradorFactura = true;
    aplicarCabeceraFactura(data.cab || {});
    facturaActualItems = Array.isArray(data.items) ? data.items.map(normalizarItemFactura) : [];
    if (facturaActualItems.length) cambiarModoIngreso('stock');
    fotosBorradorActual = Array.isArray(data.fotos) ? data.fotos : [];
    borradorServidorId = data.id || null;
    dibujarTablaFactura();
    dibujarFotosBorrador();
    restaurandoBorradorFactura = false;
    guardarBorradorLocalCache();
}

function dibujarSelectBorradores() {
    const sel = document.getElementById('selectBorradorFactura');
    if (!sel) return;
    sel.dataset.silent = '1';
    const actualEnLista = listaBorradoresCache.some((b) => Number(b.id) === Number(borradorServidorId));
    let html = '<option value="">Nuevo (sin guardar)</option>';
    listaBorradoresCache.forEach((b) => {
        html += `<option value="${b.id}">${escapeHtmlFactura(b.titulo || ('#' + b.id))}</option>`;
    });
    sel.innerHTML = html;
    if (borradorServidorId && actualEnLista) sel.value = String(borradorServidorId);
    else if (borradorServidorId) {
        sel.innerHTML = `<option value="${borradorServidorId}">#${borradorServidorId} (este)</option>` + html;
        sel.value = String(borradorServidorId);
    } else {
        sel.value = '';
    }
    delete sel.dataset.silent;
}

async function urlBlobFotoBorrador(foto) {
    const key = `${borradorServidorId}:${foto.id}`;
    if (blobFotosBorrador[key]) return blobFotosBorrador[key];
    const res = await fetch(`${obtenerBaseUrl()}/proveedores/borradores/${borradorServidorId}/fotos/${foto.id}`);
    if (!res.ok) throw new Error('No se pudo abrir la foto.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    blobFotosBorrador[key] = url;
    return url;
}

function dibujarFotosBorrador() {
    const caja = document.getElementById('galeriaFotosBorrador');
    if (!caja) return;
    if (!fotosBorradorActual.length) {
        caja.innerHTML = '';
        return;
    }
    caja.innerHTML = fotosBorradorActual.map((f) => {
        const esPdf = (f.mime || '').indexOf('pdf') >= 0;
        return `<div class="foto-borrador-thumb" data-foto-id="${escapeHtmlFactura(f.id)}">
            ${esPdf
                ? '<div class="d-flex h-100 align-items-center justify-content-center text-danger"><i class="bi bi-file-earmark-pdf fs-3"></i></div>'
                : '<div class="d-flex h-100 align-items-center justify-content-center text-muted"><i class="bi bi-image"></i></div>'}
            <button type="button" class="btn btn-danger btn-sm btn-del-foto" title="Quitar"
                onclick="quitarFotoBorrador('${escapeHtmlFactura(f.id)}')">&times;</button>
        </div>`;
    }).join('');
    fotosBorradorActual.forEach(async (f) => {
        if ((f.mime || '').indexOf('pdf') >= 0 || !borradorServidorId) return;
        try {
            const url = await urlBlobFotoBorrador(f);
            const nodo = caja.querySelector(`[data-foto-id="${f.id}"]`);
            if (!nodo) return;
            const img = document.createElement('img');
            img.alt = f.filename || 'foto';
            img.src = url;
            const placeholder = nodo.querySelector('.d-flex');
            if (placeholder) placeholder.replaceWith(img);
        } catch (e) { /* miniatura opcional */ }
    });
}

async function refrescarListaBorradores() {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/borradores`);
        const data = await res.json().catch(() => []);
        listaBorradoresCache = Array.isArray(data) ? data : [];
        dibujarSelectBorradores();
        return true;
    } catch (e) {
        return false;
    }
}

async function flushBorradorServidor() {
    if (restaurandoBorradorFactura) return null;
    guardarBorradorLocalCache();
    if (!borradorTieneContenido() && !borradorServidorId) {
        marcarEstadoBorradorFactura('Sin borrador.');
        return null;
    }
    const body = JSON.stringify(payloadBorradorActual());
    try {
        let res;
        if (!borradorServidorId) {
            res = await fetch(`${obtenerBaseUrl()}/proveedores/borradores`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body
            });
        } else {
            res = await fetch(`${obtenerBaseUrl()}/proveedores/borradores/${borradorServidorId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body
            });
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(detalleApi(data));
        borradorServidorId = data.id;
        fotosBorradorActual = Array.isArray(data.fotos) ? data.fotos : fotosBorradorActual;
        guardarBorradorLocalCache();
        await refrescarListaBorradores();
        const nFotos = fotosBorradorActual.length;
        marcarEstadoBorradorFactura(
            `Borrador #${borradorServidorId} en el servidor` + (nFotos ? ` · ${nFotos} foto${nFotos === 1 ? '' : 's'}` : '') + '.'
        );
        return data;
    } catch (e) {
        marcarEstadoBorradorFactura('Sin conexión · guardado en este navegador.');
        return null;
    }
}

function programarBorradorFactura() {
    if (restaurandoBorradorFactura) return;
    guardarBorradorLocalCache();
    clearTimeout(timerBorradorFactura);
    timerBorradorFactura = setTimeout(() => { flushBorradorServidor(); }, 700);
}

function guardarBorradorFactura() {
    programarBorradorFactura();
}

async function cargarBorradorServidor(id) {
    const res = await fetch(`${obtenerBaseUrl()}/proveedores/borradores/${id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(detalleApi(data));
    revocarBlobsFotosBorrador();
    aplicarPayloadBorrador(data);
    await refrescarListaBorradores();
    const nFotos = fotosBorradorActual.length;
    marcarEstadoBorradorFactura(
        `Borrador #${id} en el servidor` + (nFotos ? ` · ${nFotos} foto${nFotos === 1 ? '' : 's'}` : '') + '.'
    );
}

function resetFormularioFacturaLocal() {
    restaurandoBorradorFactura = true;
    facturaActualItems = [];
    fotosBorradorActual = [];
    if (document.getElementById('inputNumFactura')) document.getElementById('inputNumFactura').value = '';
    const extra = document.getElementById('inputCargosExtra');
    if (extra) extra.value = '0';
    const papel = document.getElementById('inputTotalPapel');
    if (papel) papel.value = '';
    const deuda = document.getElementById('inputTotalDeudaRapida');
    if (deuda) deuda.value = '';
    const obs = document.getElementById('inputObsDeudaRapida');
    if (obs) obs.value = '';
    asegurarFechaFactura();
    revocarBlobsFotosBorrador();
    dibujarTablaFactura();
    dibujarFotosBorrador();
    restaurandoBorradorFactura = false;
}

async function iniciarBorradoresFactura() {
    asegurarFechaFactura();
    const online = await refrescarListaBorradores();
    const idGuardado = parseInt(localStorage.getItem(CLAVE_BORRADOR_ID) || '', 10);
    if (online && idGuardado && listaBorradoresCache.some((b) => Number(b.id) === idGuardado)) {
        try {
            await cargarBorradorServidor(idGuardado);
            Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Borrador recuperado del servidor', showConfirmButton: false, timer: 2200 });
            return;
        } catch (e) { /* cae a local */ }
    }
    if (online && listaBorradoresCache.length) {
        try {
            await cargarBorradorServidor(listaBorradoresCache[0].id);
            Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Borrador abierto en el servidor', showConfirmButton: false, timer: 2200 });
            return;
        } catch (e) { /* cae a local */ }
    }
    const raw = localStorage.getItem(CLAVE_BORRADOR_FACTURA);
    if (!raw) {
        marcarEstadoBorradorFactura('Sin borrador.');
        dibujarFotosBorrador();
        return;
    }
    try {
        const data = JSON.parse(raw);
        aplicarPayloadBorrador({ cab: data.cab || {}, items: data.items || [], fotos: [], id: null });
        if (borradorTieneContenido()) {
            await flushBorradorServidor();
            Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Borrador local pasado al servidor', showConfirmButton: false, timer: 2200 });
        }
    } catch (e) {
        restaurandoBorradorFactura = false;
    }
}

async function onChangeSelectBorrador() {
    const sel = document.getElementById('selectBorradorFactura');
    if (!sel || sel.dataset.silent) return;
    const id = parseInt(sel.value, 10);
    if (!id) {
        sel.value = borradorServidorId ? String(borradorServidorId) : '';
        return;
    }
    if (Number(id) === Number(borradorServidorId)) return;
    await flushBorradorServidor();
    try {
        await cargarBorradorServidor(id);
    } catch (e) {
        Swal.fire('Error', e.message || 'No se pudo abrir el borrador.', 'error');
    }
}

async function nuevoBorradorFactura() {
    await flushBorradorServidor();
    borradorServidorId = null;
    localStorage.removeItem(CLAVE_BORRADOR_ID);
    resetFormularioFacturaLocal();
    localStorage.removeItem(CLAVE_BORRADOR_FACTURA);
    await refrescarListaBorradores();
    marcarEstadoBorradorFactura('Nuevo borrador. Se guarda al cargar algo.');
}

async function anularCargaFactura() {
    const ok = await Swal.fire({
        title: '¿Anular esta carga?',
        text: 'El borrador se cierra en el servidor. Las fotos quedan archivadas, el stock no se toca.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Anular',
        cancelButtonText: 'Seguir editando',
        confirmButtonColor: '#d33'
    });
    if (!ok.isConfirmed) return;
    if (borradorServidorId) {
        try {
            await fetch(`${obtenerBaseUrl()}/proveedores/borradores/${borradorServidorId}/anular`, { method: 'POST' });
        } catch (e) { /* si no hay red, igual limpiamos la pantalla */ }
    }
    borradorServidorId = null;
    localStorage.removeItem(CLAVE_BORRADOR_FACTURA);
    localStorage.removeItem(CLAVE_BORRADOR_ID);
    resetFormularioFacturaLocal();
    await refrescarListaBorradores();
    marcarEstadoBorradorFactura('Sin borrador.');
}

async function marcarBorradorConfirmado(compraId) {
    if (!borradorServidorId) {
        resetFormularioFacturaLocal();
        localStorage.removeItem(CLAVE_BORRADOR_FACTURA);
        localStorage.removeItem(CLAVE_BORRADOR_ID);
        return;
    }
    try {
        await fetch(`${obtenerBaseUrl()}/proveedores/borradores/${borradorServidorId}/confirmar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ compra_id: compraId || null })
        });
    } catch (e) { /* la factura ya se grabó */ }
    borradorServidorId = null;
    localStorage.removeItem(CLAVE_BORRADOR_FACTURA);
    localStorage.removeItem(CLAVE_BORRADOR_ID);
    resetFormularioFacturaLocal();
    await refrescarListaBorradores();
    marcarEstadoBorradorFactura('Sin borrador.');
}

async function onInputFotoBorrador(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    let data = await flushBorradorServidor();
    if (!borradorServidorId) {
        const creado = await fetch(`${obtenerBaseUrl()}/proveedores/borradores`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadBorradorActual())
        });
        data = await creado.json().catch(() => ({}));
        if (!creado.ok) return Swal.fire('Error', detalleApi(data), 'error');
        borradorServidorId = data.id;
        guardarBorradorLocalCache();
    }
    for (const file of files) {
        const fd = new FormData();
        fd.append('archivo', file);
        try {
            const res = await fetch(`${obtenerBaseUrl()}/proveedores/borradores/${borradorServidorId}/fotos`, {
                method: 'POST',
                body: fd
            });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(detalleApi(out));
            fotosBorradorActual = (out.borrador && out.borrador.fotos) || fotosBorradorActual;
        } catch (e) {
            Swal.fire('Foto', e.message || 'No se pudo adjuntar.', 'error');
            break;
        }
    }
    dibujarFotosBorrador();
    await refrescarListaBorradores();
    marcarEstadoBorradorFactura(`Borrador #${borradorServidorId} en el servidor · ${fotosBorradorActual.length} foto(s).`);
    if (files.some((f) => String(f.type || '').startsWith('image/'))) {
        await ocrBorradorFactura();
    }
}

async function quitarFotoBorrador(fotoId) {
    if (!borradorServidorId || !fotoId) return;
    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/borradores/${borradorServidorId}/fotos/${fotoId}`, {
            method: 'DELETE'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(detalleApi(data));
        fotosBorradorActual = Array.isArray(data.fotos) ? data.fotos : fotosBorradorActual.filter((f) => f.id !== fotoId);
        const key = `${borradorServidorId}:${fotoId}`;
        if (blobFotosBorrador[key]) {
            try { URL.revokeObjectURL(blobFotosBorrador[key]); } catch (e) { /* */ }
            delete blobFotosBorrador[key];
        }
        dibujarFotosBorrador();
        await refrescarListaBorradores();
    } catch (e) {
        Swal.fire('Error', e.message || 'No se pudo quitar la foto.', 'error');
    }
}

function restaurarBorradorFactura() {
    iniciarBorradoresFactura();
}

function totalCalculadoFactura() {
    const extra = parseFloat(document.getElementById('inputCargosExtra')?.value) || 0;
    const items = facturaActualItems.reduce((acc, it) => acc + (cantidadStockItem(it) * Number(it.costo_unitario)), 0);
    return items + extra;
}

function papelVsCalculado() {
    const raw = document.getElementById('inputTotalPapel')?.value;
    if (raw === undefined || raw === null || String(raw).trim() === '') return { hayPapel: false, delta: 0, papel: 0 };
    const papel = parseFloat(raw);
    if (!Number.isFinite(papel)) return { hayPapel: false, delta: 0, papel: 0 };
    return { hayPapel: true, papel, delta: totalCalculadoFactura() - papel };
}

function uxbItem(item) {
    return Math.max(1, parseInt(item && item.unidades_por_bulto, 10) || 1);
}

function cantidadStockItem(item) {
    const n = Number(item.cantidad_ingresada);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return item.modo_cantidad === 'CAJA' ? n * uxbItem(item) : n;
}

function margenItem(item) {
    if (Number.isFinite(Number(item.margen_pct))) return Number(item.margen_pct);
    const costoBase = Number(item.costo_anterior) || 0;
    const precio = Number(item.precio_gondola_actual) || 0;
    if (costoBase <= 0) return 0;
    return ((precio / costoBase) - 1) * 100;
}

function ivaItem(item) {
    const iva = item.porcentaje_iva;
    return (iva !== undefined && iva !== null && iva !== '') ? Number(iva) : 21;
}

function precioSugeridoItem(item) {
    const costo = Number(item.costo_unitario) || 0;
    return costo * (1 + ivaItem(item) / 100) * (1 + margenItem(item) / 100);
}

function syncDerivadosItem(item) {
    item.cantidad_comprada = cantidadStockItem(item);
    const uxb = uxbItem(item);
    if (item.modo_cantidad === 'CAJA') {
        item.costo_caja = (Number(item.costo_unitario) || 0) * uxb;
    }
}

function normalizarItemFactura(it) {
    const uxb = Math.max(1, parseInt(it.unidades_por_bulto, 10) || 1);
    const modo = it.modo_cantidad === 'CAJA' ? 'CAJA' : 'UN';
    let ingresada = Number(it.cantidad_ingresada);
    if (!Number.isFinite(ingresada) || ingresada <= 0) {
        const stock = Number(it.cantidad_comprada) || 1;
        ingresada = (modo === 'CAJA' && uxb > 1) ? stock / uxb : stock;
    }
    const item = {
        ...it,
        modo_cantidad: modo,
        cantidad_ingresada: ingresada,
        unidades_por_bulto: uxb,
        porcentaje_iva: it.porcentaje_iva ?? 21,
        precio_editado_manual: !!it.precio_editado_manual,
        origen_linea: it.origen_linea || (it.producto_id ? 'MANUAL' : 'OCR'),
        huerfano: !it.producto_id
    };
    if (!Number.isFinite(Number(item.margen_pct))) item.margen_pct = margenItem(item);
    syncDerivadosItem(item);
    return item;
}

let timeoutSugerirCompra = null;
let sugerenciasCompraCache = [];
let indiceSugerenciaActiva = 0;

function ocultarSugerenciasCompra() {
    const box = document.getElementById('sugerenciasCompra');
    if (box) {
        box.classList.remove('mostrar');
        box.innerHTML = '';
    }
    sugerenciasCompraCache = [];
    indiceSugerenciaActiva = 0;
}

function pintarSugerenciaActiva() {
    const box = document.getElementById('sugerenciasCompra');
    if (!box) return;
    const botones = box.querySelectorAll('.list-group-item');
    botones.forEach((btn, i) => {
        btn.classList.toggle('sug-activa', i === indiceSugerenciaActiva);
        btn.classList.toggle('active', i === indiceSugerenciaActiva);
    });
    const actual = botones[indiceSugerenciaActiva];
    if (actual) actual.scrollIntoView({ block: 'nearest' });
}

function moverSugerenciaCompra(delta) {
    if (sugerenciasCompraCache.length === 0) return;
    const n = sugerenciasCompraCache.length;
    indiceSugerenciaActiva = (indiceSugerenciaActiva + delta + n) % n;
    pintarSugerenciaActiva();
}

function mostrarSugerenciasCompra(productos) {
    const box = document.getElementById('sugerenciasCompra');
    if (!box) return;
    sugerenciasCompraCache = productos || [];
    if (sugerenciasCompraCache.length === 0) {
        ocultarSugerenciasCompra();
        return;
    }
    indiceSugerenciaActiva = 0;
    box.innerHTML = sugerenciasCompraCache.map((p, i) => {
        const uxb = Math.max(1, parseInt(p.unidades_por_bulto, 10) || 1);
        const extra = uxb > 1 ? ` · caja x${uxb}` : '';
        return `<button type="button" class="list-group-item list-group-item-action py-2 text-start" onclick="elegirSugerenciaCompra(${i})">
            <div class="fw-bold">${escapeHtmlFactura(p.nombre)}</div>
            <small class="text-muted">${escapeHtmlFactura(p.codigo_barras || 'S/C')} · Costo $${Number(p.costo_sin_iva || 0).toFixed(2)}${extra}</small>
        </button>`;
    }).join('');
    box.classList.add('mostrar');
    pintarSugerenciaActiva();
}

window.elegirSugerenciaCompra = function(i) {
    const prod = sugerenciasCompraCache[i];
    if (!prod) return;
    agregarProductoAFactura(prod);
    const inp = document.getElementById('inputScanCompra');
    if (inp) {
        inp.value = '';
        inp.focus();
    }
    ocultarSugerenciasCompra();
};

document.getElementById('inputScanCompra')?.addEventListener('input', function () {
    const query = this.value.trim();
    clearTimeout(timeoutSugerirCompra);
    if (query.length < 2) {
        ocultarSugerenciasCompra();
        return;
    }
    timeoutSugerirCompra = setTimeout(async () => {
        try {
            const res = await fetch(`${obtenerBaseUrl()}/productos/buscar?termino=${encodeURIComponent(query)}`);
            const data = await res.json();
            const productos = Array.isArray(data) ? data : (data.productos || []);
            mostrarSugerenciasCompra(productos.slice(0, 12));
        } catch (e) {
            ocultarSugerenciasCompra();
        }
    }, 220);
});

document.getElementById('inputScanCompra')?.addEventListener('keydown', async function (e) {
    const listaAbierta = sugerenciasCompraCache.length > 0;

    if (e.key === 'ArrowDown') {
        if (!listaAbierta) return;
        e.preventDefault();
        moverSugerenciaCompra(1);
        return;
    }
    if (e.key === 'ArrowUp') {
        if (!listaAbierta) return;
        e.preventDefault();
        moverSugerenciaCompra(-1);
        return;
    }
    if (e.key === 'Escape') {
        if (!listaAbierta) return;
        e.preventDefault();
        ocultarSugerenciasCompra();
        return;
    }
    if (e.key !== 'Enter') return;

    e.preventDefault();
    clearTimeout(timeoutSugerirCompra);
    const query = this.value.trim();
    const pareceCodigo = /^\d{6,}$/.test(query);
    if (!pareceCodigo && listaAbierta) {
        elegirSugerenciaCompra(indiceSugerenciaActiva);
        return;
    }
    if (query.length > 0) await buscarParaCompra(query);
    this.value = '';
    this.focus();
    ocultarSugerenciasCompra();
});

document.addEventListener('click', (e) => {
    const caja = document.getElementById('cajaSugerenciasCompra');
    if (caja && !caja.contains(e.target)) ocultarSugerenciasCompra();
});

['selectProvIngreso', 'inputNumFactura', 'selectCondicionPago', 'inputFechaFactura',
    'inputCargosExtra', 'inputTotalPapel', 'inputTotalDeudaRapida', 'inputObsDeudaRapida'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', programarBorradorFactura);
    document.getElementById(id)?.addEventListener('change', programarBorradorFactura);
});

async function buscarParaCompra(query) {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/buscar?termino=${encodeURIComponent(query)}`);
        const data = await res.json();
        const productos = Array.isArray(data) ? data : (data.productos || []);

        if (productos.length === 0) {
            const alta = await Swal.fire({
                title: 'No está en el catálogo',
                text: '¿Alta rápida desde esta factura? El stock entra al Guardar ingreso, no ahora.',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Alta rápida',
                cancelButtonText: 'Volver',
                confirmButtonColor: '#1b365d'
            });
            if (alta.isConfirmed) await altaRapidaProducto({ nombre: query, codigo_barras: /^\d{6,}$/.test(query) ? query : '' });
            return;
        }

        if (productos.length === 1) {
            agregarProductoAFactura(productos[0]);
            ocultarSugerenciasCompra();
            return;
        }

        mostrarSugerenciasCompra(productos.slice(0, 12));
    } catch (e) {
        console.error(e);
        Swal.fire('Error', 'Fallo de conexión al buscar.', 'error');
    }
}

window.seleccionarOpcionCompra = function(prodObjString) {
    Swal.close();
    let prod = JSON.parse(decodeURIComponent(prodObjString));
    agregarProductoAFactura(prod);
};

function agregarProductoAFactura(producto) {
    const uxb = Math.max(1, parseInt(producto.unidades_por_bulto, 10) || 1);
    const vencDefault = '2099-12-31';
    const existente = facturaActualItems.find(it => Number(it.producto_id) === Number(producto.id)
        && (it.fecha_vencimiento || vencDefault) === vencDefault);
    if (existente) {
        existente.cantidad_ingresada = (parseFloat(existente.cantidad_ingresada) || 0) + 1;
        syncDerivadosItem(existente);
        const idx = facturaActualItems.indexOf(existente);
        const cantInp = document.querySelector(`[data-idx-factura="${idx}"] .inp-cant-factura`);
        if (cantInp) cantInp.value = existente.cantidad_ingresada;
        refrescarLabelsFila(idx);
        actualizarTotalVista();
        programarBorradorFactura();
        document.getElementById('inputScanCompra')?.focus();
        return;
    }
    const costo = parseFloat(producto.costo_sin_iva) || 0;
    const precio = parseFloat(producto.precio_venta_final) || 0;
    const item = {
        producto_id: producto.id,
        nombre: producto.nombre,
        codigo_barras: producto.codigo_barras || '',
        cantidad_ingresada: 1,
        modo_cantidad: 'UN',
        cantidad_comprada: 1,
        costo_unitario: costo,
        costo_anterior: costo,
        costo_caja: costo * uxb,
        fecha_vencimiento: vencDefault,
        nuevo_precio_venta: null,
        precio_gondola_actual: precio,
        actualizar_gondola: false,
        precio_editado_manual: false,
        unidades_por_bulto: uxb,
        porcentaje_iva: (producto.porcentaje_iva !== undefined && producto.porcentaje_iva !== null) ? producto.porcentaje_iva : 21,
        margen_pct: costo > 0 ? ((precio / costo) - 1) * 100 : 0,
        numero_lote_proveedor: 'LOTE-' + Date.now().toString().slice(-4),
        origen_linea: 'MANUAL',
        huerfano: false
    };
    syncDerivadosItem(item);
    facturaActualItems.push(item);
    const tbody = document.getElementById('tablaIngresoBody');
    if (tbody && tbody.querySelector('td[colspan]')) {
        dibujarTablaFactura();
    } else if (tbody && facturaActualItems.length > 1) {
        tbody.insertAdjacentHTML('beforeend', htmlFilaFactura(item, facturaActualItems.length - 1));
        actualizarTotalVista();
        programarBorradorFactura();
    } else {
        dibujarTablaFactura();
    }
    document.getElementById('inputScanCompra')?.focus();
}

function enfocarCantidadItem(idx) {
    setTimeout(() => {
        const inp = document.querySelector(`[data-idx-factura="${idx}"] .inp-cant-factura`);
        if (inp) {
            inp.focus();
            inp.select();
        }
    }, 30);
}

function refrescarLabelsFila(idx) {
    const item = facturaActualItems[idx];
    if (!item) return;
    const stock = cantidadStockItem(item);
    const subCel = document.getElementById(`subtotal-fila-${idx}`);
    if (subCel) subCel.textContent = '$' + (stock * (Number(item.costo_unitario) || 0)).toFixed(2);
    const equiv = document.getElementById(`equiv-fila-${idx}`);
    if (equiv) {
        const uxb = uxbItem(item);
        equiv.textContent = item.modo_cantidad === 'CAJA'
            ? `= ${stock} un. (x${uxb})`
            : (uxb > 1 ? `Caja x${uxb}` : '');
    }
    const sug = document.getElementById(`sugerido-fila-${idx}`);
    if (sug) {
        sug.innerHTML = `Margen ${margenItem(item).toFixed(1)}% · Sugerido <b>$${precioSugeridoItem(item).toFixed(2)}</b>`;
    }
    const costoUn = document.querySelector(`[data-idx-factura="${idx}"] .inp-costo-factura`);
    if (costoUn && document.activeElement !== costoUn) costoUn.value = Number(item.costo_unitario) || 0;
    const costoCaja = document.querySelector(`[data-idx-factura="${idx}"] .inp-costo-caja`);
    if (costoCaja && document.activeElement !== costoCaja) costoCaja.value = (Number(item.costo_caja) || 0).toFixed(2);
    const precioInp = document.querySelector(`[data-idx-factura="${idx}"] .inp-precio-gondola`);
    if (precioInp && item.actualizar_gondola && !item.precio_editado_manual && document.activeElement !== precioInp) {
        precioInp.value = precioSugeridoItem(item).toFixed(2);
    }
}

function onInputFilaFactura(idx, campo, valor) {
    const item = facturaActualItems[idx];
    if (!item) return;
    if (campo === 'cantidad_ingresada') {
        const n = parseFloat(valor);
        item.cantidad_ingresada = Number.isFinite(n) ? n : 0;
        syncDerivadosItem(item);
    } else if (campo === 'costo_unitario') {
        const n = parseFloat(valor);
        item.costo_unitario = Number.isFinite(n) ? n : 0;
        syncDerivadosItem(item);
        if (item.actualizar_gondola && !item.precio_editado_manual) {
            item.nuevo_precio_venta = Math.round(precioSugeridoItem(item) * 100) / 100;
        }
    } else if (campo === 'costo_caja') {
        const n = parseFloat(valor);
        const uxb = uxbItem(item);
        item.costo_caja = Number.isFinite(n) ? n : 0;
        item.costo_unitario = uxb > 0 ? item.costo_caja / uxb : 0;
        if (item.actualizar_gondola && !item.precio_editado_manual) {
            item.nuevo_precio_venta = Math.round(precioSugeridoItem(item) * 100) / 100;
        }
    } else if (campo === 'fecha_vencimiento') {
        item.fecha_vencimiento = valor || '2099-12-31';
    } else if (campo === 'nuevo_precio_venta') {
        const n = parseFloat(valor);
        item.precio_editado_manual = true;
        item.nuevo_precio_venta = Number.isFinite(n) ? n : item.precio_gondola_actual;
    }
    refrescarLabelsFila(idx);
    actualizarTotalVista();
    programarBorradorFactura();
}

function cambiarModoCantidadFila(idx, modo) {
    const item = facturaActualItems[idx];
    if (!item) return;
    const stock = cantidadStockItem(item);
    const uxb = uxbItem(item);
    item.modo_cantidad = modo === 'CAJA' ? 'CAJA' : 'UN';
    if (item.modo_cantidad === 'CAJA') {
        if (uxb <= 1) {
            Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Este producto no tiene unidades por bulto. Cargalo en Productos.', showConfirmButton: false, timer: 2500 });
            item.modo_cantidad = 'UN';
        } else {
            item.cantidad_ingresada = stock / uxb;
        }
    } else {
        item.cantidad_ingresada = stock;
    }
    syncDerivadosItem(item);
    reemplazarFilaFactura(idx);
}

function toggleGondolaFila(idx, tildado) {
    const item = facturaActualItems[idx];
    if (!item) return;
    item.actualizar_gondola = !!tildado;
    if (item.actualizar_gondola) {
        item.precio_editado_manual = false;
        item.nuevo_precio_venta = Math.round(precioSugeridoItem(item) * 100) / 100;
    } else {
        item.nuevo_precio_venta = null;
        item.precio_editado_manual = false;
    }
    reemplazarFilaFactura(idx);
}

function usarSugeridoGondola(idx) {
    const item = facturaActualItems[idx];
    if (!item || !item.actualizar_gondola) return;
    item.precio_editado_manual = false;
    item.nuevo_precio_venta = Math.round(precioSugeridoItem(item) * 100) / 100;
    const precioInp = document.querySelector(`[data-idx-factura="${idx}"] .inp-precio-gondola`);
    if (precioInp) precioInp.value = Number(item.nuevo_precio_venta).toFixed(2);
    programarBorradorFactura();
}

function quitarItemFactura(idx) {
    facturaActualItems.splice(idx, 1);
    dibujarTablaFactura();
}

function scrollTablaFactura() {
    return document.querySelector('.wrap-tabla-factura');
}

function htmlFilaFactura(item, idx) {
    syncDerivadosItem(item);
    const stock = cantidadStockItem(item);
    const subtotal = stock * (Number(item.costo_unitario) || 0);
    const vencVal = item.fecha_vencimiento && item.fecha_vencimiento !== '2099-12-31' ? item.fecha_vencimiento : '';
    const uxb = uxbItem(item);
    const esCaja = item.modo_cantidad === 'CAJA';
    const meta = [];
    if (item.codigo_barras) meta.push(escapeHtmlFactura(item.codigo_barras));
    meta.push(`Último costo $${Number(item.costo_anterior || item.costo_unitario || 0).toFixed(2)}`);
    if (uxb > 1) meta.push(`Caja x${uxb}`);

    const gondolaOn = !!item.actualizar_gondola;
    const sugerido = precioSugeridoItem(item);
    const precioG = Number(item.nuevo_precio_venta != null ? item.nuevo_precio_venta : (gondolaOn ? sugerido : item.precio_gondola_actual || 0));

    return `
            <tr data-idx-factura="${idx}" class="${item.producto_id ? '' : 'fila-huerfana'}">
                <td data-label="Cantidad">
                    <div class="d-flex gap-1">
                        <input type="number" class="form-control form-control-sm inp-fila-factura inp-cant-factura" min="0.01" step="0.01"
                            value="${item.cantidad_ingresada}"
                            oninput="onInputFilaFactura(${idx}, 'cantidad_ingresada', this.value)">
                        <select class="form-select form-select-sm sel-modo-cant" onchange="cambiarModoCantidadFila(${idx}, this.value)" title="Unidad o caja">
                            <option value="UN" ${!esCaja ? 'selected' : ''}>Un</option>
                            <option value="CAJA" ${esCaja ? 'selected' : ''}>Caja</option>
                        </select>
                    </div>
                    <small class="text-muted" id="equiv-fila-${idx}">${esCaja ? `= ${stock} un. (x${uxb})` : (uxb > 1 ? `Caja x${uxb}` : '')}</small>
                </td>
                <td class="text-start" data-label="Producto">
                    ${item.producto_id
                        ? `<div class="fw-bold">${escapeHtmlFactura(item.nombre)}</div>
                    <small class="text-muted">${meta.join(' · ')}</small>`
                        : `<div class="fw-bold text-warning">Sin catálogo</div>
                    <div>${escapeHtmlFactura(item.nombre || item.nombre_ocr || '')}</div>
                    <small class="text-muted">${escapeHtmlFactura(item.codigo_ocr || item.codigo_barras || 'sin código')} · del papel</small>
                    <div class="d-flex flex-wrap gap-1 mt-1">
                        <button type="button" class="btn btn-outline-primary btn-sm py-0" onclick="vincularProductoFila(${idx})">Vincular</button>
                        <button type="button" class="btn btn-primary btn-sm py-0" onclick="altaRapidaFila(${idx})">Alta rápida</button>
                    </div>`}
                </td>
                <td data-label="Vencimiento">
                    <input type="date" class="form-control form-control-sm" value="${vencVal}"
                        onchange="onInputFilaFactura(${idx}, 'fecha_vencimiento', this.value)">
                </td>
                <td class="celda-costo-factura" data-label="Costo">
                    <input type="number" class="form-control form-control-sm inp-fila-factura inp-costo-factura" min="0" step="0.01"
                        value="${item.costo_unitario}"
                        oninput="onInputFilaFactura(${idx}, 'costo_unitario', this.value)" title="Costo por unidad">
                    <input type="number" class="form-control form-control-sm mt-1 inp-fila-factura inp-costo-caja" min="0" step="0.01"
                        value="${Number(item.costo_caja || 0).toFixed(2)}"
                        ${esCaja ? '' : 'disabled'}
                        oninput="onInputFilaFactura(${idx}, 'costo_caja', this.value)" placeholder="Costo caja" title="Costo de la caja">
                    <small class="text-muted d-block">${esCaja ? 'Arriba un. · abajo caja' : 'Por unidad · caja desactivada'}</small>
                </td>
                <td class="fw-bold" data-label="Subtotal" id="subtotal-fila-${idx}">$${subtotal.toFixed(2)}</td>
                <td class="text-start celda-gondola-factura" data-label="Góndola">
                    <div class="hint-margen-fila text-muted mb-1" id="sugerido-fila-${idx}">Margen ${margenItem(item).toFixed(1)}% · Sugerido <b>$${sugerido.toFixed(2)}</b></div>
                    <label class="small mb-0 d-flex align-items-center gap-1">
                        <input type="checkbox" class="form-check-input chk-gondola-fila" ${gondolaOn ? 'checked' : ''}
                            onchange="toggleGondolaFila(${idx}, this.checked)">
                        Actualizar
                    </label>
                    <input type="number" class="form-control form-control-sm mt-1 inp-costo-factura inp-precio-gondola" min="0" step="0.01"
                        value="${Number(precioG).toFixed(2)}" ${gondolaOn ? '' : 'disabled'}
                        oninput="onInputFilaFactura(${idx}, 'nuevo_precio_venta', this.value)">
                    <button type="button" class="btn btn-link btn-sm p-0 mt-1" ${gondolaOn ? '' : 'disabled'} onclick="usarSugeridoGondola(${idx})">Usar sugerido</button>
                    <small class="text-muted d-block">Hoy $${Number(item.precio_gondola_actual || 0).toFixed(2)}</small>
                </td>
                <td class="td-borrar-factura"><button type="button" class="btn btn-sm text-danger border-0" onclick="quitarItemFactura(${idx})"><i class="bi bi-trash"></i></button></td>
            </tr>
        `;
}

function aplicarProductoAFila(idx, producto) {
    const item = facturaActualItems[idx];
    if (!item || !producto) return;
    const uxb = Math.max(1, parseInt(producto.unidades_por_bulto, 10) || item.unidades_por_bulto || 1);
    const costoPapel = Number(item.costo_unitario);
    const costo = Number.isFinite(costoPapel) && costoPapel > 0 ? costoPapel : (parseFloat(producto.costo_sin_iva) || 0);
    const precio = parseFloat(producto.precio_venta_final) || 0;
    item.producto_id = producto.id;
    item.nombre = producto.nombre;
    item.codigo_barras = producto.codigo_barras || item.codigo_ocr || '';
    item.unidades_por_bulto = uxb;
    item.costo_unitario = costo;
    item.costo_anterior = parseFloat(producto.costo_sin_iva) || costo;
    item.costo_caja = costo * uxb;
    item.precio_gondola_actual = precio;
    item.porcentaje_iva = (producto.porcentaje_iva !== undefined && producto.porcentaje_iva !== null) ? producto.porcentaje_iva : 21;
    item.huerfano = false;
    item.origen_linea = 'MANUAL';
    if (costo > 0) item.margen_pct = ((precio / costo) - 1) * 100;
    syncDerivadosItem(item);
    reemplazarFilaFactura(idx);
    programarBorradorFactura();
}

async function vincularProductoFila(idx) {
    const item = facturaActualItems[idx];
    if (!item) return;
    const previa = (item.codigo_ocr || item.nombre_ocr || item.nombre || '').trim();
    const busqueda = await Swal.fire({
        title: 'Vincular al catálogo',
        input: 'text',
        inputValue: previa,
        inputPlaceholder: 'Nombre o código',
        showCancelButton: true,
        confirmButtonText: 'Buscar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#1b365d'
    });
    if (!busqueda.isConfirmed || !(busqueda.value || '').trim()) return;
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/buscar?termino=${encodeURIComponent(busqueda.value.trim())}`);
        const data = await res.json().catch(() => ({}));
        const productos = Array.isArray(data) ? data : (data.productos || []);
        if (!productos.length) {
            const alta = await Swal.fire({
                title: 'No está',
                text: '¿Alta rápida con ese nombre?',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Alta rápida',
                cancelButtonText: 'Volver',
                confirmButtonColor: '#1b365d'
            });
            if (alta.isConfirmed) await altaRapidaFila(idx, busqueda.value.trim());
            return;
        }
        const inputOptions = {};
        productos.slice(0, 12).forEach((p, i) => {
            inputOptions[String(i)] = `${p.nombre} (${p.codigo_barras || 'S/C'})`;
        });
        const eleccion = await Swal.fire({
            title: 'Elegí el producto',
            input: 'select',
            inputOptions,
            showCancelButton: true,
            confirmButtonText: 'Vincular',
            cancelButtonText: 'Cancelar',
            confirmButtonColor: '#1b365d'
        });
        if (!eleccion.isConfirmed) return;
        aplicarProductoAFila(idx, productos[parseInt(eleccion.value, 10)]);
    } catch (e) {
        Swal.fire('Error', e.message || 'No se pudo buscar.', 'error');
    }
}

async function altaRapidaProducto(prefill, idxFila) {
    prefill = prefill || {};
    const provId = document.getElementById('selectProvIngreso')?.value || '0';
    const html = `
        <input id="altaFacNombre" class="swal2-input" placeholder="Nombre" value="${escapeHtmlFactura(prefill.nombre || '')}">
        <input id="altaFacCodigo" class="swal2-input" placeholder="Código (opcional)" value="${escapeHtmlFactura(prefill.codigo_barras || '')}">
        <input id="altaFacCosto" class="swal2-input" type="number" step="0.01" placeholder="Costo unitario" value="${prefill.costo_unitario || ''}">
        <input id="altaFacIva" class="swal2-input" type="number" step="0.01" placeholder="IVA %" value="${prefill.porcentaje_iva || 21}">
        <input id="altaFacUxb" class="swal2-input" type="number" step="1" min="1" placeholder="Unidades por caja" value="${prefill.unidades_por_bulto || 1}">
        <p class="small text-muted mb-0">No entra stock ahora. El lote se crea al Guardar ingreso.</p>`;
    const dlg = await Swal.fire({
        title: 'Alta rápida',
        html,
        showCancelButton: true,
        confirmButtonText: 'Crear y usar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#1b365d',
        preConfirm: () => {
            const nombre = document.getElementById('altaFacNombre').value.trim();
            if (!nombre) {
                Swal.showValidationMessage('Falta el nombre');
                return false;
            }
            return {
                nombre,
                codigo_barras: document.getElementById('altaFacCodigo').value.trim(),
                costo_sin_iva: parseFloat(document.getElementById('altaFacCosto').value) || 0,
                porcentaje_iva: parseFloat(document.getElementById('altaFacIva').value) || 21,
                unidades_por_bulto: parseInt(document.getElementById('altaFacUxb').value, 10) || 1,
                proveedor_habitual_id: parseInt(provId, 10) || 0
            };
        }
    });
    if (!dlg.isConfirmed) return null;
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/alta_desde_factura`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dlg.value)
        });
        const data = await res.json().catch(() => ({}));
        if (data.existente && data.id) {
            const bus = await fetch(`${obtenerBaseUrl()}/productos/buscar?termino=${encodeURIComponent(dlg.value.codigo_barras || dlg.value.nombre)}`);
            const lista = await bus.json().catch(() => ({}));
            const productos = Array.isArray(lista) ? lista : (lista.productos || []);
            const prod = productos.find(p => Number(p.id) === Number(data.id)) || { id: data.id, nombre: dlg.value.nombre, codigo_barras: dlg.value.codigo_barras, costo_sin_iva: dlg.value.costo_sin_iva, unidades_por_bulto: dlg.value.unidades_por_bulto, porcentaje_iva: dlg.value.porcentaje_iva, precio_venta_final: 0 };
            if (idxFila != null) aplicarProductoAFila(idxFila, prod);
            else agregarProductoAFactura(prod);
            Swal.fire('Ya existía', data.error || 'Se vinculó al código existente.', 'info');
            return prod;
        }
        if (!res.ok || data.error) throw new Error(detalleApi(data));
        const prod = data.producto || { id: data.id, ...dlg.value, precio_venta_final: 0 };
        if (idxFila != null) aplicarProductoAFila(idxFila, prod);
        else agregarProductoAFactura(prod);
        return prod;
    } catch (e) {
        Swal.fire('Error', e.message || 'No se pudo crear.', 'error');
        return null;
    }
}

async function altaRapidaFila(idx, nombreForzado) {
    const item = facturaActualItems[idx];
    if (!item) return;
    await altaRapidaProducto({
        nombre: nombreForzado || item.nombre_ocr || item.nombre || '',
        codigo_barras: item.codigo_ocr || item.codigo_barras || '',
        costo_unitario: item.costo_unitario,
        porcentaje_iva: item.porcentaje_iva,
        unidades_por_bulto: item.unidades_por_bulto
    }, idx);
}

async function ocrBorradorFactura() {
    if (!borradorServidorId) {
        await flushBorradorServidor();
    }
    if (!borradorServidorId) return Swal.fire('Fotos', 'Adjuntá una foto o esperá la del bot.', 'info');
    Swal.fire({ title: 'Leyendo el papel...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/borradores/${borradorServidorId}/ocr`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(detalleApi(data));
        aplicarPayloadBorrador(data);
        await refrescarListaBorradores();
        const ocr = data.ocr || {};
        if (ocr.estado === 'mano') {
            Swal.fire('Manuscrita', 'No precargo ítems. Cargalos a mano; la foto queda en el borrador.', 'info');
            return;
        }
        if (ocr.estado === 'omitido_edicion') {
            Swal.fire('Sin pisar', 'Ya había ítems cargados a mano. No reescribí la grilla.', 'info');
            return;
        }
        if (ocr.estado === 'sin_clave') {
            Swal.fire('OCR', 'Falta OPENAI_API_KEY en el servidor.', 'warning');
            return;
        }
        const h = ocr.n_huerfanos || 0;
        Swal.fire(
            'Papel leído',
            `${ocr.n_items || facturaActualItems.length} ítems. ${h ? h + ' sin catálogo: vinculá o alta rápida. ' : ''}No se tocó stock.`,
            'success'
        );
    } catch (e) {
        Swal.fire('OCR', e.message || 'No se pudo leer.', 'error');
    }
}

function reemplazarFilaFactura(idx) {
    const wrap = scrollTablaFactura();
    const y = wrap ? wrap.scrollTop : 0;
    const vieja = document.querySelector(`#tablaIngresoBody tr[data-idx-factura="${idx}"]`);
    const item = facturaActualItems[idx];
    if (!vieja || !item) {
        dibujarTablaFactura();
        return;
    }
    vieja.outerHTML = htmlFilaFactura(item, idx);
    if (wrap) wrap.scrollTop = y;
    actualizarTotalVista();
    programarBorradorFactura();
}

function dibujarTablaFactura() {
    const tbody = document.getElementById('tablaIngresoBody');
    if (!tbody) return;
    const wrap = scrollTablaFactura();
    const y = wrap ? wrap.scrollTop : 0;

    if (facturaActualItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-muted py-4">La factura está vacía. Escribí o escaneá un producto.</td></tr>';
        actualizarTotalVista();
        programarBorradorFactura();
        return;
    }

    tbody.innerHTML = facturaActualItems.map((item, idx) => htmlFilaFactura(item, idx)).join('');
    if (wrap) wrap.scrollTop = y;
    actualizarTotalVista();
    programarBorradorFactura();
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
            : 'Escribí o escaneá. Unidad o Caja por fila. Góndola solo si la tildás.';
    }
    programarBorradorFactura();
}

function limpiarFactura() {
    anularCargaFactura();
}

async function confirmarDuplicadoSiExiste(provId, numero) {
    if (!provId || !numero) return { cancel: false, forzar: false };
    try {
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/comprobar_factura?proveedor_id=${provId}&numero=${encodeURIComponent(numero)}`);
        const data = await res.json().catch(() => ({}));
        if (!data.duplicada) return { cancel: false, forzar: false };
        const ok = await Swal.fire({
            title: 'Factura repetida',
            html: `El N° <b>${escapeHtmlFactura(numero)}</b> ya está cargado (${escapeHtmlFactura(data.fecha_compra || '-')}, $${Number(data.total_factura || 0).toFixed(2)}).`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Cargar igual',
            cancelButtonText: 'Volver',
            confirmButtonColor: '#1b365d'
        });
        if (!ok.isConfirmed) return { cancel: true, forzar: false };
        return { cancel: false, forzar: true };
    } catch (e) {
        return { cancel: false, forzar: false };
    }
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
    const fechaCompra = document.getElementById('inputFechaFactura')?.value || hoyISOLocal();

    if (!provId) return Swal.fire('Atención', 'Seleccioná un proveedor.', 'warning');
    if (!numFactura) return Swal.fire('Atención', 'Ingresá el N° de factura o remito.', 'warning');
    if (!Number.isFinite(total) || total <= 0) return Swal.fire('Atención', 'Ingresá un total mayor a cero.', 'warning');

    const dup = await confirmarDuplicadoSiExiste(provId, numFactura);
    if (dup.cancel) return;

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
                fecha_compra: fechaCompra,
                forzar_duplicado: dup.forzar,
                pago_inmediato: pagoAhora.pago
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(detalleApi(data));
        if (data.error) throw new Error(data.error);

        await marcarBorradorConfirmado(data.id);
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
    const fechaCompra = document.getElementById('inputFechaFactura')?.value || hoyISOLocal();

    if (!provId) return Swal.fire('Error', 'Debe seleccionar un proveedor.', 'warning');
    if (facturaActualItems.length === 0) return Swal.fire('Error', 'No hay productos en la factura.', 'warning');
    const huerfano = facturaActualItems.find(it => !it.producto_id);
    if (huerfano) {
        return Swal.fire('Sin catálogo', `Vinculá o dales alta a «${huerfano.nombre || 'la línea'}» antes de guardar. El OCR no crea productos solo.`, 'warning');
    }
    const itemMalo = facturaActualItems.find(it => !(cantidadStockItem(it) > 0));
    if (itemMalo) return Swal.fire('Atención', `Revisá la cantidad de ${itemMalo.nombre}.`, 'warning');

    const cargosExtraIngresados = parseFloat(document.getElementById('inputCargosExtra').value) || 0;
    const totalEstimado = totalCalculadoFactura();
    const vsPapel = papelVsCalculado();
    if (vsPapel.hayPapel && Math.abs(vsPapel.delta) > 0.05) {
        const seguir = await Swal.fire({
            title: 'No cierra con el papel',
            html: `Papel <b>$${vsPapel.papel.toFixed(2)}</b><br>Sistema <b>$${totalEstimado.toFixed(2)}</b><br>Diferencia <b>$${vsPapel.delta.toFixed(2)}</b>`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Guardar igual',
            cancelButtonText: 'Revisar',
            confirmButtonColor: '#1b365d'
        });
        if (!seguir.isConfirmed) return;
    }

    const dup = await confirmarDuplicadoSiExiste(provId, numFactura);
    if (dup.cancel) return;

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
            cargos_extra: cargosExtraIngresados,
            fecha_compra: fechaCompra,
            forzar_duplicado: dup.forzar,
            items: facturaActualItems.map(it => ({
                producto_id: it.producto_id,
                cantidad_comprada: cantidadStockItem(it),
                costo_unitario: Number(it.costo_unitario),
                fecha_vencimiento: it.fecha_vencimiento || '2099-12-31',
                numero_lote_proveedor: it.numero_lote_proveedor || 'S/L',
                nuevo_precio_venta: it.actualizar_gondola
                    ? (Number.isFinite(Number(it.nuevo_precio_venta))
                        ? Number(it.nuevo_precio_venta)
                        : Number(precioSugeridoItem(it).toFixed(2)))
                    : null
            })),
            pago_inmediato: pagoAhora.pago
        };

        const res = await fetch(`${obtenerBaseUrl()}/proveedores/cargar_factura`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(detalleApi(data));
        if (data.error) throw new Error(data.error);

        const extraPago = pagoAhora.pago
            ? (pagoAhora.pago.metodo_pago === 'EFECTIVO CAJA'
                ? ' Pago de caja registrado (no es gasto).'
                : ' Pago bolsillo / transferencia registrado.')
            : '';
        Swal.fire('¡Mercadería Ingresada!', 'El stock y los costos se actualizaron. La góndola solo si la tildaste.' + extraPago, 'success');
        await marcarBorradorConfirmado(data.id);
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
    const vistaTotal = document.getElementById('totalFacturaVista');
    const aviso = document.getElementById('avisoDescuadreFactura');
    const totalReal = totalCalculadoFactura();
    if (vistaTotal) vistaTotal.innerText = '$ ' + totalReal.toFixed(2);
    if (aviso) {
        const vs = papelVsCalculado();
        if (!vs.hayPapel) {
            aviso.textContent = '';
            aviso.className = 'd-block small fw-bold';
        } else if (Math.abs(vs.delta) <= 0.05) {
            aviso.textContent = 'Cierra con el papel';
            aviso.className = 'd-block small fw-bold text-success';
        } else {
            aviso.textContent = `No cierra: ${vs.delta > 0 ? '+' : ''}$${vs.delta.toFixed(2)} vs papel`;
            aviso.className = 'd-block small fw-bold text-danger';
        }
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
                    usuario_nombre: 'Sistema (stock mínimo)',
                    origen: 'COMPRAS'
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
                usuario_nombre: localStorage.getItem('usuario_nombre') || 'Oficina',
                origen: 'COMPRAS'
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
document.addEventListener("DOMContentLoaded", async () => {
    asegurarFechaFactura();
    await cargarProveedores();
    await iniciarBorradoresFactura();
});