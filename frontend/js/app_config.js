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

document.addEventListener('DOMContentLoaded', () => {
    cargarConfiguracionActual();

    // Formateador automático de CUIT
    const inputCuit = document.getElementById('confCuit');
    if (inputCuit) {
        inputCuit.addEventListener('input', function (e) {
            let valorLimpio = e.target.value.replace(/\D/g, '');
            let pedazos = valorLimpio.match(/(\d{0,2})(\d{0,8})(\d{0,1})/);
            if (!pedazos[2]) {
                e.target.value = pedazos[1];
            } else {
                e.target.value = pedazos[1] + '-' + pedazos[2] + (pedazos[3] ? '-' + pedazos[3] : '');
            }
        });
    }
});

async function cargarConfiguracionActual() {
    try {
        const baseUrl = obtenerBaseUrl();
        const res = await fetch(`${baseUrl}/config/leer`);
        const config = await res.json();
        if (config.error) throw new Error(config.error);

        document.getElementById('confNombre').value = config.nombre_negocio || '';
        document.getElementById('confCuit').value = config.cuit || '';
        document.getElementById('confIva').value = config.condicion_iva || 'Responsable Inscripto';
        document.getElementById('confTel').value = config.telefono || '';
        document.getElementById('confGrupoCompras').value = config.whatsapp_grupo_compras || '';
        document.getElementById('confDir').value = config.direccion || '';
        document.getElementById('confImpresora').value = config.impresora_por_defecto || '80mm';
        document.getElementById('confMsj').value = config.mensaje_ticket || '';
        document.getElementById('confTopeDescuento').value = config.tope_maximo_descuento_sueldo_pct ?? 50;
        document.getElementById('confUmbralDescuentoPct').value = config.umbral_descuento_pct ?? 5;
        document.getElementById('confUmbralDescuentoPesos').value = config.umbral_descuento_pesos ?? 0;

        if (config.ruta_logo) {
            document.getElementById('previewLogo').src = `${baseUrl}/static/logos/${config.ruta_logo}?t=${new Date().getTime()}`;
        }
        await cargarComisiones();
    } catch (e) { console.error("Error al cargar config", e); }
}

async function cargarComisiones() {
    const caja = document.getElementById('tablaComisiones');
    if (!caja) return;
    const res = await fetch(`${obtenerBaseUrl()}/config/comisiones`);
    const medios = await res.json();
    if (!Array.isArray(medios)) return;
    caja.innerHTML = medios.map((m) => `
        <div class="row g-2 align-items-end border-bottom pb-3">
            <div class="col-md-4">
                <label class="form-label fw-bold small mb-1">${m.nombre}</label>
                <input type="hidden" class="comision-codigo" value="${m.codigo}">
            </div>
            <div class="col-md-4">
                <label class="form-label small mb-1">Costo del banco (%)</label>
                <input type="number" class="form-control comision-pct" min="0" max="99.99" step="0.01" value="${Number(m.pct_costo || 0)}">
            </div>
            <div class="col-md-4">
                <div class="form-check mt-4">
                    <input class="form-check-input comision-recargo" type="checkbox" ${m.recargo_activo ? 'checked' : ''}>
                    <label class="form-check-label">Cobrar recargo al cliente</label>
                </div>
            </div>
        </div>
    `).join('');
}

async function guardarComisiones() {
    const filas = [...document.querySelectorAll('#tablaComisiones .row')];
    const medios = filas.map((fila) => ({
        codigo: fila.querySelector('.comision-codigo').value,
        pct_costo: Number(fila.querySelector('.comision-pct').value || 0),
        recargo_activo: fila.querySelector('.comision-recargo').checked
    }));
    Swal.fire({ title: 'Guardando...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });
    try {
        const res = await fetch(`${obtenerBaseUrl()}/config/comisiones`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(medios)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : 'No se pudieron guardar las comisiones.');
        }
        Swal.fire('Listo', 'Comisiones guardadas.', 'success');
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function guardarConfiguracion(event) {
    event.preventDefault();
    Swal.fire({ title: 'Guardando...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });

    const formData = new FormData();
    formData.append('nombre_negocio', document.getElementById('confNombre').value);
    formData.append('cuit', document.getElementById('confCuit').value);
    formData.append('condicion_iva', document.getElementById('confIva').value);
    formData.append('telefono', document.getElementById('confTel').value);
    formData.append('whatsapp_grupo_compras', document.getElementById('confGrupoCompras').value);
    formData.append('direccion', document.getElementById('confDir').value);
    formData.append('impresora_por_defecto', document.getElementById('confImpresora').value);
    formData.append('mensaje_ticket', document.getElementById('confMsj').value);
    formData.append('tope_maximo_descuento_sueldo_pct', document.getElementById('confTopeDescuento').value || 50);
    formData.append('umbral_descuento_pct', document.getElementById('confUmbralDescuentoPct').value || 0);
    formData.append('umbral_descuento_pesos', document.getElementById('confUmbralDescuentoPesos').value || 0);

    try {
        const baseUrl = obtenerBaseUrl();
        const res = await fetch(`${baseUrl}/config/actualizar_datos`, { method: 'PUT', body: formData });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        localStorage.setItem('config_negocio', JSON.stringify({
            nombre_negocio: document.getElementById('confNombre').value,
            direccion: document.getElementById('confDir').value,
            cuit: document.getElementById('confCuit').value,
            mensaje_ticket: document.getElementById('confMsj').value
        }));
        
        Swal.fire('¡Éxito!', 'Configuración guardada.', 'success').then(() => window.location.reload());
    } catch (e) { Swal.fire('Error', e.message, 'error'); }
}

async function subirLogo() {
    const input = document.getElementById('inputLogo');
    if (!input.files[0]) return Swal.fire('Aviso', 'Seleccioná una imagen.', 'warning');
    const formData = new FormData(); formData.append("archivo", input.files[0]);
    Swal.fire({ title: 'Subiendo...', didOpen: () => Swal.showLoading() });
    try {
        const baseUrl = obtenerBaseUrl();
        const res = await fetch(`${baseUrl}/config/subir_logo`, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        Swal.fire('¡Logo Actualizado!', '', 'success');
        cargarConfiguracionActual();
    } catch (e) { Swal.fire('Error', e.message, 'error'); }
}

function descargarBackup() {
    Swal.fire({
        title: 'Empaquetando...',
        text: 'Preparando tu base de datos',
        timer: 1500,
        showConfirmButton: false
    }).then(() => {
        const baseUrl = obtenerBaseUrl();
        window.open(`${baseUrl}/config/descargar_backup`, '_blank');
    });
}

async function probarWhatsapp() {
    Swal.fire({ title: 'Contactando al puente...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const res = await fetch(`${obtenerBaseUrl()}/config/probar_whatsapp`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.detalle || 'No se pudo probar.'));
        }
        if (data.ok) {
            Swal.fire('Pedido enviado', data.detalle || 'El puente Node aceptó el aviso.', 'success');
        } else {
            Swal.fire('No salió', data.detalle || 'Node no respondió. Revisá el servicio en el puerto 3000 y el teléfono guardado.', 'warning');
        }
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function probarWhatsappGrupo() {
    Swal.fire({ title: 'Contactando al grupo...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const res = await fetch(`${obtenerBaseUrl()}/config/probar_whatsapp_grupo`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detalle = data.detail;
            throw new Error(typeof detalle === 'string' ? detalle : (data.detalle || 'No se pudo probar el grupo.'));
        }
        if (data.ok) {
            Swal.fire('Pedido enviado', data.detalle || 'El puente Node aceptó el aviso al grupo.', 'success');
        } else {
            Swal.fire('No salió', data.detalle || 'Guardá el ID del grupo (...@g.us) y el puente en el 3000.', 'warning');
        }
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}