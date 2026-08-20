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
        document.getElementById('confDir').value = config.direccion || '';
        document.getElementById('confImpresora').value = config.impresora_por_defecto || '80mm';
        document.getElementById('confMsj').value = config.mensaje_ticket || '';

        if (config.ruta_logo) {
            document.getElementById('previewLogo').src = `${baseUrl}/static/logos/${config.ruta_logo}?t=${new Date().getTime()}`;
        }
    } catch (e) { console.error("Error al cargar config", e); }
}

async function guardarConfiguracion(event) {
    event.preventDefault();
    Swal.fire({ title: 'Guardando...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });

    const formData = new FormData();
    formData.append('nombre_negocio', document.getElementById('confNombre').value);
    formData.append('cuit', document.getElementById('confCuit').value);
    formData.append('condicion_iva', document.getElementById('confIva').value);
    formData.append('telefono', document.getElementById('confTel').value);
    formData.append('direccion', document.getElementById('confDir').value);
    formData.append('impresora_por_defecto', document.getElementById('confImpresora').value);
    formData.append('mensaje_ticket', document.getElementById('confMsj').value);

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

async function actualizarSistema() {
    Swal.fire({ 
        title: 'Actualizando Sistema...', 
        text: 'Descargando las últimas mejoras de la nube al equipo físico.', 
        allowOutsideClick: false,
        didOpen: () => { Swal.showLoading() }
    });

    try {
        const baseUrl = obtenerBaseUrl(); 
        const res = await fetch(`${baseUrl}/actualizar-sistema`, { method: 'POST' });
        const data = await res.json();

        if (res.ok) {
            Swal.fire('¡Actualizado!', data.mensaje, 'success').then(() => {
                window.location.reload(); 
            });
        } else {
            Swal.fire('Error', data.error || 'Fallo en la actualización', 'error');
        }
    } catch (e) {
        Swal.fire('Error', 'No se pudo contactar al servidor para actualizar.', 'error');
    }
}