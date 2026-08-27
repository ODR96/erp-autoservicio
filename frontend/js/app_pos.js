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

function normalizarTexto(texto) {
    if (!texto) return "";
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

setInterval(() => {
    const d = new Date();
    // Le agregamos el hour12: false para forzar el formato militar/24hs
    document.getElementById('reloj').innerText = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    document.getElementById('fecha').innerText = d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}, 1000);

// ===== VARIABLES GLOBALES Y SEGURIDAD =====
let carrito = []; let subtotalVenta = 0; let totalVenta = 0; let porcentajeDescuento = 0; let porcentajeRecargo = 0; let mult = 1; let ventasEnEspera = []; let cajaAbierta = false; let turnoActualId = null;
let terminal_id = localStorage.getItem('caja_fisica_id') || null;
let empleadoLogueado = JSON.parse(localStorage.getItem('empleado_pos')) || null;
let token = localStorage.getItem('token_pos') || null;

const inputScan = document.getElementById("inputScan");
const modalApertura = new bootstrap.Modal(document.getElementById('modalApertura'));
const modalGestion = new bootstrap.Modal(document.getElementById('modalGestionCaja'));
const modalDeuda = new bootstrap.Modal(document.getElementById('modalCobrarDeuda'));
const modalBuscador = new bootstrap.Modal(document.getElementById('modalBuscador'));
const modalNuevoCliente = new bootstrap.Modal(document.getElementById('modalNuevoCliente'));
const modalCobroEfectivo = new bootstrap.Modal(document.getElementById('modalCobroEfectivo'));
const modalSeleccionCliente = new bootstrap.Modal(document.getElementById('modalSeleccionCliente'));

document.addEventListener("DOMContentLoaded", () => {
    cargarCategoriasRapidas();

    const token = localStorage.getItem('token');
    const rol = localStorage.getItem('usuario_rol');
    const nombre = localStorage.getItem('usuario_nombre');

    if (!token || !nombre) {
        window.location.href = 'index.html';
        return;
    }

    // Leemos el usuario real (Si no está, sacamos el del localStorage global)
    const idUsuario = localStorage.getItem('usuario_id') || 1;
    let empleadoGuardado = JSON.parse(localStorage.getItem('empleado_pos'));

    if (empleadoGuardado) {
        empleadoLogueado = empleadoGuardado; // Mantiene los datos exactos del cajero
    } else {
        empleadoLogueado = { nombre: nombre, rol: rol, id: parseInt(idUsuario) };
    }
    iniciarInterfazPOS();
});

// --- MOTOR DE AUTORIZACIONES REALES ---
async function solicitarAutorizacion(mensaje) {
    const { value: pin } = await Swal.fire({
        title: '⚠️ Autorización Requerida',
        html: `${mensaje}<br><br>Ingrese PIN de Encargado o Admin:`,
        input: 'password',
        inputAttributes: { autocomplete: 'off' },
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Autorizar'
    });

    if (!pin) return false;

    try {
        Swal.fire({ title: 'Verificando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        const res = await apiFetch(`${obtenerBaseUrl()}/usuarios/autorizar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin_secreto: pin, roles_permitidos: ['ENCARGADO', 'ADMIN'] })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `Autorizado por ${data.usuario}`, showConfirmButton: false, timer: 1500 });
        return data.usuario;
    } catch (e) {
        Swal.fire('Denegado', 'PIN incorrecto o sin privilegios.', 'error');
        return false;
    }
}

async function procesarLoginPOS() {
    const cred = document.getElementById('loginCredencial').value.trim();
    const pin = document.getElementById('loginPin').value.trim();
    if (!cred || !pin) return Swal.fire('Error', 'Ingrese credencial y PIN', 'warning');

    Swal.fire({ title: 'Verificando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/usuarios/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo_credencial: cred, pin_secreto: pin })
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.detail || 'Login fallido');

        // Guardamos en memoria permanente
        empleadoLogueado = data.usuario;
        token = data.token_acceso;
        localStorage.setItem('empleado_pos', JSON.stringify(empleadoLogueado));
        localStorage.setItem('token_pos', token);

        Swal.close();
        document.getElementById('loginCredencial').value = '';
        document.getElementById('loginPin').value = '';

        iniciarInterfazPOS();
    } catch (e) {
        Swal.fire('Acceso Denegado', 'Credencial o PIN incorrectos.', 'error');
    }
}

// Función nueva para cambiar de empleado
async function cerrarSesionCajero() {
    const result = await Swal.fire({
        title: '¿Cerrar sesión?',
        text: `Saldrás del usuario ${empleadoLogueado.nombre}.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '<i class="bi bi-box-arrow-right"></i> Sí, salir',
        cancelButtonText: 'Cancelar',
        customClass: { confirmButton: 'btn btn-danger me-2 px-4 fw-bold', cancelButton: 'btn btn-secondary px-4 fw-bold', popup: 'rounded-4 shadow-lg border-0' },
        buttonsStyling: false
    });

    if (result.isConfirmed) {
        localStorage.clear(); // Borramos toda la memoria
        window.location.href = 'index.html'; // Volvemos a la puerta principal
    }
}

async function iniciarInterfazPOS() {
    const nombre = localStorage.getItem('usuario_nombre');
    const rol = localStorage.getItem('usuario_rol');

    document.getElementById('nombreCajeroLogueado').innerText = nombre;
    const configLocal = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: "Mi Negocio" };
    document.getElementById('uiNombreNegocio').innerText = configLocal.nombre_negocio.toUpperCase();

    if (!nombre) {
        window.location.href = 'index.html';
        return;
    }

    const flechaAdmin = document.querySelector('a[href="admin_productos.html"]');
    if (flechaAdmin) {
        flechaAdmin.style.display = (rol === 'ADMIN' || rol === 'ENCARGADO') ? 'block' : 'none';
    }

    if (!terminal_id) {
        try {
            // 1. Vamos a buscar las cajas activas a tu servidor Python
            const resCajas = await apiFetch(`${obtenerBaseUrl()}/caja/cajas_fisicas`);
            const dataCajas = await resCajas.json();

            // 2. Transformamos la respuesta en un diccionario para SweetAlert
            let opcionesCajas = {};
            dataCajas.cajas.forEach(c => {
                opcionesCajas[c.id.toString()] = c.nombre; // Ej: "1": "Caja 1 (Mostrador)"
            });

            // 3. Mostramos el cartel 100% dinámico
            const { value: cajaSeleccionada } = await Swal.fire({
                title: '🖥️ Configurar Terminal',
                text: 'Asigne esta computadora a una de las cajas habilitadas:',
                input: 'select',
                inputOptions: opcionesCajas,
                inputPlaceholder: 'Seleccione una caja...',
                showCancelButton: false,
                allowOutsideClick: false,
                confirmButtonText: 'Guardar Configuración',
                confirmButtonColor: '#1b365d',
                inputValidator: (value) => {
                    return new Promise((resolve) => {
                        if (value) resolve();
                        else resolve('Debe seleccionar una caja para continuar');
                    });
                }
            });

            if (cajaSeleccionada) {
                terminal_id = parseInt(cajaSeleccionada);
                localStorage.setItem('caja_fisica_id', terminal_id);
                await Swal.fire('Configurada', `Terminal asignada correctamente.`, 'success');
            }
        } catch (error) {
            Swal.fire('Error', 'No se pudieron cargar las cajas. Verifique la conexión al servidor.', 'error');
            return; // Frena la carga del POS si no puede bajar la lista
        }
    }

    const cargarCarritoSobreviviente = () => {
        try {
            let carritoGuardado = localStorage.getItem('carrito_pos_recupero');
            if (carritoGuardado) {
                carrito = JSON.parse(carritoGuardado);
                if (carrito.length > 0) {
                    actualizarTabla();
                    Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Ticket recuperado', showConfirmButton: false, timer: 2000 });
                }
            }
            let esperaGuardada = localStorage.getItem('ventas_espera_pos');
            if (esperaGuardada) {
                ventasEnEspera = JSON.parse(esperaGuardada);
                document.getElementById('badgeEspera').innerText = `${ventasEnEspera.length} en espera`;
            }
        } catch (e) { }
    };

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/caja/estado?caja_id=${terminal_id}`);
        const data = await res.json();

        if (data.estado === 'ABIERTO') {
            cajaAbierta = true;
            turnoActualId = data.turno_id;
            localStorage.setItem('turno_actual_offline', data.turno_id);
            actualizarInfoCabecera(data.turno_id);

            cargarCarritoSobreviviente();
            setTimeout(() => inputScan.focus(), 500);
        } else {
            modalApertura.show();
            setTimeout(() => document.getElementById("montoApertura").focus(), 500);
        }
    } catch (error) {
        let turnoGuardado = localStorage.getItem('turno_actual_offline');
        if (turnoGuardado) {
            cajaAbierta = true;
            turnoActualId = turnoGuardado;
            actualizarInfoCabecera(turnoGuardado);
            cargarCarritoSobreviviente();
            setTimeout(() => inputScan.focus(), 500);
        } else {
            modalApertura.show();
        }
    }
}

function actualizarInfoCabecera(turnoId) {
    setTimeout(() => {
        const infoBar = document.querySelector(".ticket-info-bar span");
        if (infoBar) {
            const displayTurno = turnoId ? `#${turnoId}` : "---";
            const numCaja = terminal_id ? terminal_id : "?";
            infoBar.innerHTML = `<strong>Caja:</strong> ${numCaja} | <strong>Turno:</strong> ${displayTurno} | <strong>Cajero:</strong> ${empleadoLogueado.nombre}`;
        }
    }, 100);
}

// ==========================================
// MÓDULO: HISTORIAL Y ANULACIONES
// ==========================================
const modalHistorial = new bootstrap.Modal(document.getElementById('modalHistorialVentas'));

async function abrirHistorialTurno() {
    if (!turnoActualId) return Swal.fire('Error', 'No hay turno abierto.', 'error');

    modalGestion.hide();

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/ventas/historial/${turnoActualId}`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        const tbody = document.getElementById('tablaHistorialVentas');
        tbody.innerHTML = '';

        if (data.ventas.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Aún no hay ventas en este turno.</td></tr>';
        } else {
            data.ventas.forEach(v => {
                const esAnulada = v.estado === 'ANULADA';
                const colorFila = esAnulada ? 'text-muted text-decoration-line-through' : '';
                const badge = esAnulada ? '<span class="badge bg-danger">Anulada</span>' : '<span class="badge bg-success">Ok</span>';

                const btnVer = `<button class="btn btn-sm btn-outline-info me-1" onclick="verDetalleTicketGlobal(${v.id})" title="Ver Detalle"><i class="bi bi-eye"></i></button>`;

                // EL PARCHE: Agregamos el botón de imprimir que llama a tu propia función
                const btnImprimir = `<button class="btn btn-sm btn-outline-primary me-1" onclick="imprimirTicket80mm(${v.id})" title="Reimprimir Ticket"><i class="bi bi-printer"></i></button>`;

                const btnAnular = esAnulada
                    ? '<button class="btn btn-sm btn-secondary" disabled><i class="bi bi-x-circle"></i></button>'
                    : `<button class="btn btn-sm btn-outline-danger" onclick="confirmarAnulacion(${v.id}, '${v.numero_ticket}')" title="Anular Venta"><i class="bi bi-trash"></i></button>`;

                const hora = new Date(v.fecha_hora).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

                tbody.innerHTML += `
    <tr class="${colorFila}">
        <td class="align-middle">${hora}</td>
        <td class="align-middle fw-bold">${v.numero_ticket}</td>
        <td class="align-middle">${v.metodo_pago}</td>
        <td class="align-middle text-end fw-bold">$${v.total_venta.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
        <td class="align-middle text-center">${badge}</td>
        <td class="align-middle text-center">
        <div class="d-flex justify-content-center">
            ${btnVer}
            ${btnImprimir}
            ${btnAnular}
        </div>
    </tr>
`;
            });
        }
        modalHistorial.show();
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el historial: ' + e.message, 'error');
    }
}

async function verDetalleTicketGlobal(ventaId) {
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
                 <div class="text-end fw-bold fs-5 mt-2 text-primary">Total: $${data.totales.total_a_pagar.toFixed(2)}</div>
                 <div class="text-start text-muted small mt-2">Método: ${data.totales.metodo_pago}</div>`;

        Swal.fire({
            title: `<i class="bi bi-receipt text-primary"></i> Ticket #${ventaId}`,
            html: html, width: '500px', showCloseButton: true, confirmButtonText: 'Cerrar', confirmButtonColor: '#6c757d'
        });
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el detalle del ticket.', 'error');
    }
}

async function confirmarAnulacion(ventaId, ticket) {
    // EL TRUCO: Escondemos el historial de Bootstrap para que no nos congele el input del PIN
    modalHistorial.hide();

    // EL PATOVICA DIGITAL: Pedir PIN si no es Admin o Encargado
    if (!empleadoLogueado || (empleadoLogueado.rol !== 'ADMIN' && empleadoLogueado.rol !== 'ENCARGADO')) {
        const autorizadoPor = await solicitarAutorizacion(`Anular el Ticket ${ticket} descontará plata de la caja. Requiere autorización de Supervisor.`);
        if (!autorizadoPor) {
            modalHistorial.show(); // Si cancela o erra el PIN, le devolvemos el historial
            return;
        }
    }

    // Alerta de seguridad antes de anular
    const confirm = await Swal.fire({
        title: '¿Anular Ticket ' + ticket + '?',
        text: 'El stock de los productos regresará a la estantería y la plata se descontará de la caja. Esta acción quedará registrada.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'Sí, anular venta',
        cancelButtonText: 'Cancelar'
    });

    if (confirm.isConfirmed) {
        try {
            // LLamada a tu backend para anular (CON TOKEN Y USUARIO)
            const res = await apiFetch(`${obtenerBaseUrl()}/ventas/anular/${ventaId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    usuario_id: empleadoLogueado.id,
                    turno_id: turnoActualId
                })
            });
            const data = await res.json();

            if (data.error) throw new Error(data.error);

            Swal.fire('¡Anulada!', 'La venta ha sido anulada y el stock restaurado.', 'success');

            // Recargamos la tabla para que se vea tachada y volvemos a abrir el historial
            abrirHistorialTurno();
        } catch (e) {
            // ... sigue igual ...
            Swal.fire('Error', e.message, 'error');
            modalHistorial.show();
        }
    } else {
        modalHistorial.show(); // Si canceló la anulación final, vuelve al historial
    }
}

function filtrarHistorialVentas() {
    // Tomamos lo que escribís y lo pasamos a minúsculas
    const textoBuscado = document.getElementById('inputBuscarHistorial').value.toLowerCase();

    // Agarramos todas las filas de la tabla
    const filas = document.querySelectorAll('#tablaHistorialVentas tr');

    filas.forEach(fila => {
        // Leemos todo el texto de la fila (Ticket, Hora, Método, Plata)
        const contenidoFila = fila.textContent.toLowerCase();

        // Si el texto que escribiste está en la fila, la mostramos. Si no, la ocultamos.
        if (contenidoFila.includes(textoBuscado)) {
            fila.style.display = '';
        } else {
            fila.style.display = 'none';
        }
    });
}

async function iniciarTurno() {
    const monto = parseFloat(document.getElementById("montoApertura").value);
    if (isNaN(monto) || monto < 0) return Swal.fire('Atención', 'Ingrese un monto inicial.', 'warning');
    Swal.fire({ title: 'Abriendo...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        const payload = { caja_id: terminal_id, usuario_id: empleadoLogueado.id, monto_inicial: monto };
        const response = await apiFetch(`${obtenerBaseUrl()}/caja/abrir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await response.json();
        if (data.error) throw new Error(data.error);

        cajaAbierta = true; turnoActualId = data.turno_id;
        modalApertura.hide(); actualizarInfoCabecera(data.turno_id);
        Swal.fire({ title: '¡Caja Abierta!', icon: 'success', timer: 1500, showConfirmButton: false });
        setTimeout(() => inputScan.focus(), 1500);
    } catch (error) { Swal.fire('Error', error.message, 'error'); }
}

async function anularVentaConAviso() {
    if (carrito.length === 0) return inputScan.focus();

    const result = await Swal.fire({
        title: '¿Anular venta?',
        text: "Se borrarán todos los artículos del ticket.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'Sí, anular'
    });

    if (result.isConfirmed) {
        limpiarMostrador();
    } else {
        inputScan.focus();
    }
}

function pressNumpad(n) { inputScan.value += n; inputScan.focus(); }
async function setModo(m) {
    if (m === 'CANT' && inputScan.value) {
        mult = parseFloat(inputScan.value);
        inputScan.value = "";
        inputScan.placeholder = `Cant: ${mult} x (Pase producto)`;
        inputScan.focus();
    } else if (m === 'PRECIO' && inputScan.value) {
        const precioVarios = parseFloat(inputScan.value);
        inputScan.value = "";

        // El cuadro súper rápido (podes escribir y darle a Enter sin usar el mouse)
        const { value: nombreVarios } = await Swal.fire({
            title: 'Artículo Varios',
            input: 'text',
            inputLabel: `Precio: $${precioVarios.toFixed(2)}`,
            inputPlaceholder: 'Ej: Caramelos, Escoba... (Enter para omitir)',
            showCancelButton: true,
            confirmButtonText: 'Agregar (Enter)',
            cancelButtonText: 'Cancelar (Esc)',
            didOpen: () => {
                const input = Swal.getInput();
                input.focus();
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') Swal.clickConfirm();
                });
            }
        });

        // Si el cajero le dio a Aceptar o apretó Enter
        if (nombreVarios !== undefined) {
            // Si lo dejó en blanco por apuro, le ponemos "Varios" por defecto
            const nombreFinal = nombreVarios.trim() === '' ? 'Varios' : nombreVarios.trim();

            // MAGIA: Le generamos un ID único con Date.now() para que no se agrupen
            agregarAlCarrito({
                id: Date.now(),
                nombre: nombreFinal,
                precio_venta_final: precioVarios
            });
        }
        inputScan.focus();
    } else {
        inputScan.focus();
    }
}
function borrarUltimo() { if (carrito.length > 0) { carrito.pop(); actualizarTabla(); } inputScan.focus(); }

inputScan.addEventListener("keyup", (e) => {
    if (e.key === "Enter") {
        let valorLimpio = inputScan.value.trim().toLowerCase();

        // Si detecta un asterisco (Ej: "5*77912345" o "5 * 77912345")
        if (valorLimpio.includes('*')) {
            let partes = valorLimpio.split('*');
            let cantidadIngresada = parseFloat(partes[0].trim());

            if (!isNaN(cantidadIngresada) && cantidadIngresada > 0) {
                mult = cantidadIngresada; // Seteamos el multiplicador global
                valorLimpio = partes[1].trim(); // Nos quedamos solo con el código
            }
        }

        if (valorLimpio !== "") buscarProducto(valorLimpio);
    }
});

// ===== NUEVO: INTEGRACIÓN REAL CON TU BACKEND PYTHON (Swagger) =====
async function buscarProducto(q) {
    if (!cajaAbierta) return Swal.fire('Caja Cerrada', 'Debe abrir la caja primero.', 'warning');

    let query = q.trim().toLowerCase();

    try {
        if (!navigator.onLine) throw new Error("OFFLINE");

        const response = await apiFetch(`${obtenerBaseUrl()}/productos/buscar?termino=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error("Error servidor");

        const data = await response.json();
        procesarResultadosBusqueda(data.productos, query);

    } catch (error) {
        // GUARDAVIDAS NIVEL 2: Búsqueda Offline
        if (error.message === "OFFLINE" || error.message === "Failed to apiFetch" || error.message.includes("NetworkError")) {

            let catalogoOffline = JSON.parse(localStorage.getItem('catalogo_productos_offline')) || [];
            if (catalogoOffline.length === 0) return Swal.fire('Sin Internet', 'Sin conexión y el catálogo offline está vacío.', 'error');

            // 1. Buscamos por código de barras exacto o ID
            let exactos = catalogoOffline.filter(p => p.codigo_barras === query || p.id.toString() === query);

            if (exactos.length > 0) {
                procesarResultadosBusqueda(exactos, query);
            } else {
                // 2. Si no, buscamos por nombre aproximado
                let palabras = query.split(" ");
                let aproximados = catalogoOffline.filter(p => {
                    let textoProd = (p.nombre + " " + (p.codigo_barras || "")).toLowerCase();
                    return palabras.every(pal => textoProd.includes(pal));
                });
                procesarResultadosBusqueda(aproximados, query);
            }
        } else {
            Swal.fire('Error', 'Fallo interno al buscar producto.', 'error');
        }
    }

    inputScan.value = ""; inputScan.placeholder = "[F2] Lector o texto..."; inputScan.focus();
}

// Sub-rutina inteligente para no repetir código (PEGAR ABAJO DE buscarProducto)
function procesarResultadosBusqueda(productos, queryOriginal) {
    if (productos && productos.length === 1) {
        agregarAlCarrito({ ...productos[0] });
    } else if (productos && productos.length > 1) {
        // Modo silencioso para avisar que entró el F3 Offline
        if (!navigator.onLine) Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Resultados múltiples (Modo Offline)', showConfirmButton: false, timer: 1500 });

        document.getElementById('inputBusquedaAvanzada').value = queryOriginal;
        abrirBuscadorAvanzado();
    } else {
        Swal.fire({ title: 'No encontrado', text: 'El producto no existe o está inactivo', icon: 'error', timer: 1500, showConfirmButton: false });
    }
}

function agregarAlCarrito(p) {
    // 1. Detectamos si el producto se vende por peso
    // (Ajustá 'PESO' o 'Kg' según cómo lo hayas escrito en tu base de datos)
    const esPesable = (p.tipo_venta === 'PESO' || p.tipo_venta === 'Peso' || p.unidad_medida === 'Kg' || p.unidad_medida === 'KG');

    if (esPesable) {
        // 2. Si es pesable, frenamos todo y abrimos la balanza bidireccional
        Swal.fire({
            title: '⚖️ Producto por Peso',
            html: `
                <h5 class="text-primary fw-bold">${p.nombre}</h5>
                <p class="mb-3 text-muted">Precio por Kg: $${p.precio_venta_final.toFixed(2)}</p>
                <div class="row g-2 text-start px-2">
                    <div class="col-6">
                        <label class="form-label fw-bold small text-secondary">Peso (KG)</label>
                        <input type="number" id="swal-peso" class="form-control border-primary form-control-lg text-center fw-bold" step="0.005" min="0" placeholder="Ej: 0.250" autocomplete="off">
                    </div>
                    <div class="col-6">
                        <label class="form-label fw-bold small text-success">Por Monto ($)</label>
                        <input type="number" id="swal-monto" class="form-control border-success form-control-lg text-center fw-bold" step="10" min="0" placeholder="Ej: 2000" autocomplete="off">
                    </div>
                </div>
            `,
            showCancelButton: true,
            confirmButtonColor: '#198754',
            confirmButtonText: '<i class="bi bi-check-lg"></i> Pesar (Enter)',
            cancelButtonText: 'Cancelar (Esc)',
            didOpen: () => {
                const inputPeso = document.getElementById('swal-peso');
                const inputMonto = document.getElementById('swal-monto');
                inputPeso.focus();
                mult = 1; // Anulamos el multiplicador manual si lo usó por error

                // MAGIA: Si escribe Kilos, calcula la Plata
                inputPeso.addEventListener('input', () => {
                    let kilos = parseFloat(inputPeso.value) || 0;
                    inputMonto.value = (kilos * p.precio_venta_final).toFixed(2);
                });

                // MAGIA INVERSA: Si escribe Plata, calcula los Kilos
                inputMonto.addEventListener('input', () => {
                    let plata = parseFloat(inputMonto.value) || 0;
                    inputPeso.value = (plata / p.precio_venta_final).toFixed(3);
                });

                // Escuchamos el Enter en cualquiera de los dos cuadros
                inputPeso.addEventListener('keypress', (e) => { if (e.key === 'Enter') Swal.clickConfirm(); });
                inputMonto.addEventListener('keypress', (e) => { if (e.key === 'Enter') Swal.clickConfirm(); });
            },
            preConfirm: () => {
                const kilosFinales = parseFloat(document.getElementById('swal-peso').value);
                if (!kilosFinales || kilosFinales <= 0) {
                    Swal.showValidationMessage('Ingrese un peso o monto mayor a 0');
                    return false;
                }
                return kilosFinales;
            }
        }).then((result) => {
            if (result.isConfirmed && result.value > 0) {
                let kilos = result.value;

                // Agregamos al carrito con la cantidad en Kilos
                const existe = carrito.find(x => x.id === p.id);
                if (existe) {
                    existe.cantidad += kilos;
                } else {
                    carrito.push({ ...p, cantidad: kilos });
                }
                actualizarTabla();
            } else {
                inputScan.focus(); // Si cancela, volvemos el foco al lector
            }
        });

    } else {
        // 3. LÓGICA NORMAL (Para productos por unidad como galletitas o latas)
        const existe = carrito.find(x => x.id === p.id);
        if (existe) {
            existe.cantidad += mult;
        } else {
            carrito.push({ ...p, cantidad: mult });
        }
        mult = 1;
        actualizarTabla();
    }
}

// MOTOR PARA EDITAR PRECIOS EN MOSTRADOR
async function cambiarPrecioManual(index) {
    const prod = carrito[index];
    const { value: nuevoPrecioStr } = await Swal.fire({
        title: 'Modificar Precio',
        html: `Producto: <b>${prod.nombre}</b><br>Precio actual: $${prod.precio_venta_final.toFixed(2)}`,
        input: 'number',
        inputValue: prod.precio_venta_final,
        showCancelButton: true,
        confirmButtonText: '<i class="bi bi-check-circle"></i> Aplicar',
        confirmButtonColor: '#198754'
    });

    if (nuevoPrecioStr) {
        const nuevoPrecio = parseFloat(nuevoPrecioStr);
        if (nuevoPrecio >= 0 && nuevoPrecio !== prod.precio_venta_final) {
            // REGLA DE SEGURIDAD
            if (empleadoLogueado && (empleadoLogueado.rol === 'ADMIN' || empleadoLogueado.rol === 'ENCARGADO')) {
                aplicarPrecioCambiado(index, nuevoPrecio);
            } else {
                const autorizadoPor = await solicitarAutorizacion(`Bajar el precio a $${nuevoPrecio.toFixed(2)} requiere permiso de Supervisor.`);
                if (autorizadoPor) aplicarPrecioCambiado(index, nuevoPrecio);
            }
        }
    }
}

function aplicarPrecioCambiado(index, nuevoPrecio) {
    carrito[index].precio_venta_final = nuevoPrecio;
    carrito[index].precio_modificado_manual = true; // El escudo anti-promos
    actualizarTabla();
    inputScan.focus();
}

function cambiarCantidad(i, delta) {
    carrito[i].cantidad += delta;
    if (carrito[i].cantidad <= 0) carrito.splice(i, 1);
    actualizarTabla(); inputScan.focus();
}

async function aplicarModificador(tipo) {
    if (carrito.length === 0) return Swal.fire('Ticket vacío', 'Cargue productos primero.', 'warning');

    let titulo = tipo === 'descuento' ? 'Aplicar Descuento Global (%)' : 'Aplicar Recargo Global (%)';
    let valorActual = tipo === 'descuento' ? porcentajeDescuento : porcentajeRecargo;

    const { value: val, isDenied } = await Swal.fire({
        title: titulo,
        input: 'number',
        inputValue: valorActual > 0 ? valorActual : '',
        inputPlaceholder: 'Ej: 10',
        showCancelButton: true,
        showDenyButton: valorActual > 0, // Solo aparece si ya hay un descuento/recargo activo
        denyButtonText: '<i class="bi bi-trash"></i> Eliminar',
        confirmButtonText: 'Aplicar',
        cancelButtonText: 'Cancelar',
        denyButtonColor: '#dc3545'
    });

    if (isDenied) {
        // El usuario tocó el botón rojo de Eliminar
        porcentajeDescuento = 0;
        porcentajeRecargo = 0;
        actualizarTabla();
    } else if (val !== undefined && val !== "") {
        let num = parseFloat(val);
        if (num < 0) num = 0;

        if (num === 0) {
            porcentajeDescuento = 0;
            porcentajeRecargo = 0;
        } else if (tipo === 'descuento') {
            porcentajeDescuento = num;
            porcentajeRecargo = 0;
        } else {
            porcentajeRecargo = num;
            porcentajeDescuento = 0;
        }
        actualizarTabla();
    }
    inputScan.focus();
}

function actualizarTabla() {
    // PARCHE: Si vaciaron el carrito, borramos los recargos/descuentos fantasmas
    if (carrito.length === 0) {
        porcentajeDescuento = 0;
        porcentajeRecargo = 0;
    }

    const tbody = document.getElementById("listaTicket");
    tbody.innerHTML = ""; subtotalVenta = 0;
    // Adentro de tu función que actualiza los totales:
    let cantidadTotalArticulos = carrito.reduce((acumulador, item) => {
            const esPesable = (item.unidad_medida || "un").toLowerCase().includes("kg") || item.tipo_venta === 'PESO';
            return acumulador + (esPesable ? 1 : parseFloat(item.cantidad));
        }, 0);
    document.getElementById('visorCantidadArticulos').innerText = `(${cantidadTotalArticulos} Artículos)`;

    carrito.forEach((p, i) => {
        let precioF = p.precio_venta_final;
        let badgePromo = "";

        if (p.reglas_mayoristas && p.reglas_mayoristas.length > 0 && !p.precio_modificado_manual) {
            let reglas = p.reglas_mayoristas.sort((a, b) => b.cantidad_minima - a.cantidad_minima);
            let regla = reglas.find(r => p.cantidad >= r.cantidad_minima);
            if (regla) {
                precioF = regla.precio_oferta_unitario;
                badgePromo = `<br><span class="badge bg-warning text-dark mt-1" style="font-size:0.65rem;">Promo x${regla.cantidad_minima} aplicada</span>`;
            }
        }

        const sub = precioF * p.cantidad; subtotalVenta += sub;
        const unidad = (p.unidad_medida || "Un").toLowerCase().includes("kg") || p.tipo_venta === 'PESO' ? "Kg" : "un.";

        tbody.innerHTML += `
            <div class="ticket-item">
                <div class="d-flex align-items-center justify-content-center gap-1">
                    <button class="btn btn-sm btn-light border py-0 px-1 text-danger fw-bold" onclick="cambiarCantidad(${i}, -1)">-</button>
                    <span class="fw-bold px-1" style="font-size: 0.95rem;">${p.cantidad} <small class="text-muted">${unidad}</small></span>
                    <button class="btn btn-sm btn-light border py-0 px-1 text-success fw-bold" onclick="cambiarCantidad(${i}, 1)">+</button>
                </div>
                <div class="text-start fw-bold" style="line-height:1.1;">${p.nombre}${badgePromo}</div>
                <div class="text-primary text-decoration-underline" style="cursor:pointer;" ondblclick="cambiarPrecioManual(${i})" title="Doble clic para editar">$${precioF.toFixed(2)}</div>
                <div class="fw-bold">$${sub.toFixed(2)}</div>
                <button class="btn btn-outline-danger border-0 btn-sm" onclick="carrito.splice(${i},1); actualizarTabla();"><i class="bi bi-trash"></i></button>
            </div>`;
    });

    document.getElementById("visorSubtotal").innerText = `$ ${subtotalVenta.toFixed(2)}`;
    const cajaModificador = document.getElementById("visorModificador");
    totalVenta = subtotalVenta;

    if (porcentajeDescuento > 0 && subtotalVenta > 0) {
        let desc = subtotalVenta * (porcentajeDescuento / 100); totalVenta -= desc;
        cajaModificador.innerText = `Descuento ${porcentajeDescuento}% (-$${desc.toFixed(2)})`;
        cajaModificador.classList.remove("d-none", "text-danger"); cajaModificador.classList.add("text-success");
    } else if (porcentajeRecargo > 0 && subtotalVenta > 0) {
        let rec = subtotalVenta * (porcentajeRecargo / 100); totalVenta += rec;
        cajaModificador.innerText = `Recargo ${porcentajeRecargo}% (+$${rec.toFixed(2)})`;
        cajaModificador.classList.remove("d-none", "text-success"); cajaModificador.classList.add("text-danger");
    } else {
        cajaModificador.classList.add("d-none");
    }

    document.getElementById("visorTotal").innerText = `$ ${totalVenta.toFixed(2)}`;

    const containerTicket = document.querySelector('.ticket-body');
    if (containerTicket) containerTicket.scrollTop = containerTicket.scrollHeight;

    // MAGIA ANTI-F5: Guardamos el carrito acá al final de todo
    localStorage.setItem('carrito_pos_recupero', JSON.stringify(carrito));
}

// ===== FUNCIONES DE LIMPIEZA Y COBRO ======

let clienteSeleccionadoId = null; // Guardamos el ID real del cliente

function limpiarMostrador() {
    carrito = [];
    porcentajeDescuento = 0;
    porcentajeRecargo = 0;
    mult = 1;
    document.getElementById("nombreClienteTicket").innerText = "Consumidor Final";
    clienteSeleccionadoId = null;
    document.getElementById("visorModificador").classList.add("d-none");

    // MAGIA ANTI-F5: Destruimos la memoria del ticket anterior
    localStorage.removeItem('carrito_pos_recupero');

    actualizarTabla();
    inputScan.value = ""; inputScan.focus();
}

async function anularVentaConAviso() {
    if (carrito.length > 0) {
        const result = await Swal.fire({ title: '¿Anular venta?', text: "Se borrarán todos los artículos del ticket.", icon: 'warning', showCancelButton: true, confirmButtonColor: '#d33', cancelButtonColor: '#6c757d', confirmButtonText: 'Sí, anular' });
        if (result.isConfirmed) { limpiarMostrador(); } else { inputScan.focus(); }
    } else { inputScan.focus(); }
}

function prepararCobroEfectivo() {
    if (carrito.length === 0) return Swal.fire('Error', 'El ticket está vacío.', 'error');
    document.getElementById("cobroTotalEfectivo").innerText = `$ ${totalVenta.toFixed(2)}`;
    document.getElementById("inputPagaCon").value = "";
    document.getElementById("cobroVuelto").innerText = "$ 0.00";
    modalCobroEfectivo.show();
    setTimeout(() => document.getElementById("inputPagaCon").focus(), 500);
}


// =========================================================
// RESUMEN DETALLADO DE CUENTA CORRIENTE
// =========================================================
async function verResumenDetalladoFiado() {
    if (!clienteFiadoActual) return;

    Swal.fire({ title: 'Calculando deuda...', text: 'Consultando al servidor...', didOpen: () => Swal.showLoading() });

    try {
        // Le pegamos directo a nuestro nuevo misil en Python
        const res = await apiFetch(`${obtenerBaseUrl()}/clientes/resumen_pendientes/${clienteFiadoActual.id}`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);
        if (!data.articulos || data.articulos.length === 0) {
            return Swal.fire('Cuenta al día', 'No se registran artículos impagos para este cliente.', 'info');
        }

        let html = `<div class="table-responsive border rounded shadow-sm" style="max-height: 40vh; overflow-y: auto;">
            <table class="table table-sm text-start align-middle table-hover mb-0">
            <thead class="table-light sticky-top"><tr><th>Cant.</th><th>Producto</th><th class="text-end">Subtotal</th></tr></thead><tbody>`;

        data.articulos.forEach(a => {
            let unidad = (a.unidad || 'un.').toLowerCase().includes('kg') ? 'Kg' : 'un.';
            html += `<tr>
                <td class="fw-bold text-primary">${a.cantidad} <span style="font-size:0.75rem" class="text-muted">${unidad}</span></td>
                <td class="small fw-bold">${a.nombre}</td>
                <td class="text-end fw-bold">$${a.subtotal.toFixed(2)}</td>
            </tr>`;
        });

        html += `</tbody></table></div>
                <div class="alert alert-warning mt-3 text-start small border-warning pb-2">
                    <i class="bi bi-info-circle-fill"></i> El saldo total adeudado del cliente es de <b>$${data.saldo_total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</b>.
                </div>`;

        const result = await Swal.fire({
            title: `<div class="d-flex align-items-center justify-content-center gap-2"><i class="bi bi-list-check text-primary"></i> Resumen de Cuenta</div><span class="fs-6 text-muted">${clienteFiadoActual.nombre_completo}</span>`,
            html: html,
            width: '600px',
            showCancelButton: true,
            confirmButtonColor: '#198754',
            cancelButtonColor: '#6c757d',
            confirmButtonText: '<i class="bi bi-printer"></i> Imprimir Reporte',
            cancelButtonText: 'Cerrar'
        });

        // La función imprimirResumenFiado() queda igual, esa estaba perfecta
        if (result.isConfirmed) {
            imprimirResumenFiado(clienteFiadoActual.nombre_completo, data.saldo_total, data.articulos);
        }

    } catch (e) {
        Swal.fire('Error', 'No se pudo generar el resumen. ¿Agregaste el endpoint en Python?', 'error');
        console.error(e);
    }
}

// MOTOR DE IMPRESIÓN DEL RESUMEN
function imprimirResumenFiado(cliente, deudaTotal, articulos) {
    const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: "Mi Negocio", direccion: "" };
    let fechaActual = `${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;

    let html = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Resumen de Cuenta</title>
    <style>
        @page { margin: 0; }
        body { font-family: Arial, sans-serif; font-size: 11px; margin: 0; padding: 2mm 4mm; width: 72mm; color: #000; -webkit-font-smoothing: none; text-rendering: crispEdges;}
        .center { text-align: center; } .left { text-align: left; } .right { text-align: right; } .bold { font-weight: bold; }
        .divisor { border-top: 1px dashed #000; margin: 4px 0; }
        .divisor-doble { border-top: 2px solid #000; border-bottom: 2px solid #000; height: 2px; margin: 4px 0; }
        table { width: 100%; border-collapse: collapse; margin: 5px 0; }
        th, td { text-align: left; padding: 2px 0; vertical-align: top; }
    </style>
    </head><body>
        <div class="center bold" style="font-size: 15px;">${config.nombre_negocio.toUpperCase()}</div>
        <div class="center bold" style="font-size: 13px; margin-top: 4px;">RESUMEN DE ARTÍCULOS PENDIENTES</div>
        <div class="divisor"></div>
        <div class="left">Fecha: ${fechaActual}</div>
        <div class="left bold">Cliente: ${cliente}</div>
        <div class="divisor-doble"></div>
        <table>
            <tr><th style="width:15%">CANT</th><th>DETALLE</th><th class="right">SUBT</th></tr>
            <tr><td colspan="3"><div class="divisor"></div></td></tr>`;

    articulos.forEach(a => {
        html += `<tr>
            <td class="left">${a.cantidad} <span style="font-size:9px">${a.unidad}</span></td>
            <td class="left">${a.nombre}</td>
            <td class="right">$${a.subtotal.toFixed(2)}</td>
        </tr>`;
    });

    html += `
            <tr><td colspan="3"><div class="divisor-doble"></div></td></tr>
        </table>
        <div style="font-size: 14px; display: flex; justify-content: space-between;" class="bold">
            <span>SALDO TOTAL:</span>
            <span>$ ${deudaTotal.toFixed(2)}</span>
        </div>
        <div class="center" style="margin-top: 15px; font-size: 10px;">Documento informativo detallado.<br>No válido como factura.</div>
        <div style="margin-bottom: 25mm;"></div>
    </body></html>`;

    let vent = window.open('', '_blank', 'width=300,height=500');
    vent.document.write(html); vent.document.close(); vent.focus();
    setTimeout(() => { vent.print(); vent.close(); }, 500);
}

function calcularVuelto() {
    let inputPaga = document.getElementById("inputPagaCon").value;
    let pagaCon = parseFloat(inputPaga);
    let visor = document.getElementById("cobroVuelto");

    if (!inputPaga || isNaN(pagaCon) || pagaCon === 0) {
        visor.innerText = `$ 0.00`; visor.classList.remove("text-danger"); visor.classList.add("text-success");
        return;
    }

    let vuelto = pagaCon - totalVenta;
    if (vuelto >= 0) { visor.innerText = `$ ${vuelto.toFixed(2)}`; visor.classList.remove("text-danger"); visor.classList.add("text-success"); }
    else { visor.innerText = "Falta dinero"; visor.classList.remove("text-success"); visor.classList.add("text-danger"); }
}

// ===== NUEVO MOTOR: ENVIAR VENTA A PYTHON =====
// 1. ADAPTAMOS EL MOTOR PRINCIPAL PARA RECIBIR LA LISTA MIXTA
async function procesarVentaBackend(metodoPago, montoEntregado, arrayPagosMixtos = null, autorizadoPor = null) {
    const itemsVenta = carrito.map(p => {
        let precioCalculado = p.precio_venta_final;
        if (p.reglas_mayoristas && p.reglas_mayoristas.length > 0) {
            let reglas = [...p.reglas_mayoristas].sort((a, b) => b.cantidad_minima - a.cantidad_minima);
            let regla = reglas.find(r => p.cantidad >= r.cantidad_minima);
            if (regla) precioCalculado = regla.precio_oferta_unitario;
        }

        let idLimpio = parseInt(p.id);
        if (isNaN(idLimpio) || idLimpio > 999999999) {
            idLimpio = 0;
        }

        return {
            producto_id: idLimpio, // <-- MANDAMOS EL NÚMERO LIMPIO
            cantidad: p.cantidad,
            precio_unitario: precioCalculado,
            nombre_fantasma: p.nombre
        };
    });

    let descuentoRecargoTotal = 0;
    if (porcentajeDescuento > 0) descuentoRecargoTotal = -(subtotalVenta * (porcentajeDescuento / 100));
    else if (porcentajeRecargo > 0) descuentoRecargoTotal = (subtotalVenta * (porcentajeRecargo / 100));

    const payloadVenta = {
        metodo_pago: metodoPago,
        monto_entregado: montoEntregado,
        cliente_id: clienteSeleccionadoId,
        tipo_comprobante: "TICKET NO FISCAL",
        nombre_cliente_factura: document.getElementById("nombreClienteTicket").innerText.trim(),
        documento_cliente: "",
        condicion_iva_cliente: "Consumidor Final",
        descuento_recargo_global: descuentoRecargoTotal,
        facturar_afip: false,
        cajero_nombre: empleadoLogueado ? empleadoLogueado.nombre : "Caja Principal",
        items: itemsVenta,
        pagos_mixtos: arrayPagosMixtos,
        autorizado_por: autorizadoPor,
        turno_id: turnoActualId
    };

    try {
        if (!navigator.onLine) {
            throw new Error("OFFLINE");
        }

        const response = await apiFetch(`${obtenerBaseUrl()}/ventas/cobrar`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadVenta)
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Error en el servidor");
        if (data.error) throw new Error(data.detalle || data.error);

        return data;

    } catch (error) {
        if (error.message === "OFFLINE" || error.message === "Failed to apiFetch" || error.message.includes("NetworkError")) {

            Swal.close(); // Cerramos el "Procesando..."

            // Creamos un ticket temporal falso para que el cajero pueda imprimir el papel
            const ticketTemporalId = "OFF-" + Date.now().toString().slice(-6);

            // Guardamos la venta en la mochila (localStorage)
            let ventasPendientes = JSON.parse(localStorage.getItem('ventas_offline')) || [];

            // Le agregamos el ID temporal al payload para saber cuál es
            payloadVenta.ticket_temporal = ticketTemporalId;
            ventasPendientes.push(payloadVenta);

            localStorage.setItem('ventas_offline', JSON.stringify(ventasPendientes));

            // Le avisamos al cajero que se cobró pero en modo sin conexión
            Swal.fire({
                toast: true, position: 'top-end', icon: 'warning',
                title: 'Venta guardada (Sin Internet)', showConfirmButton: false, timer: 3000
            });

            // Devolvemos una respuesta simulada para que el código del POS siga su curso e imprima
            return {
                numero_ticket: ticketTemporalId,
                total_cobrado: montoEntregado,
                vuelto: montoEntregado - (subtotalVenta + descuentoRecargoTotal),
                ahorro_total: 0
            };
        }

        // Si es un error real de validación (ej: PIN incorrecto), lo mostramos normal
        Swal.close();
        Swal.fire('Venta Rechazada', error.message, 'error');
        return null;
    }
}

// --- MOTOR OFFLINE-FIRST: EL CARTERO ---
async function sincronizarVentasOffline() {
    let ventasPendientes = JSON.parse(localStorage.getItem('ventas_offline')) || [];

    if (ventasPendientes.length === 0) return; // No hay nada que subir

    console.log(`Subiendo ${ventasPendientes.length} ventas offline a la nube...`);

    let ventasAprobadas = [];

    for (let i = 0; i < ventasPendientes.length; i++) {
        let venta = ventasPendientes[i];
        try {
            // Intentamos mandar la venta al servidor
            const response = await apiFetch(`${obtenerBaseUrl()}/ventas/cobrar`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(venta)
            });

            if (response.ok) {
                // Si subió bien, la marcamos para borrarla de la memoria local
                ventasAprobadas.push(venta.ticket_temporal);
            }
        } catch (e) {
            console.warn("Fallo al sincronizar ticket:", venta.ticket_temporal);
            // Si falla, cortamos el bucle, internet sigue inestable. Se intentará en la próxima.
            break;
        }
    }

    // Limpiamos de la memoria solo las ventas que subieron con éxito
    if (ventasAprobadas.length > 0) {
        ventasPendientes = ventasPendientes.filter(v => !ventasAprobadas.includes(v.ticket_temporal));
        localStorage.setItem('ventas_offline', JSON.stringify(ventasPendientes));

        Swal.fire({
            toast: true, position: 'top-end', icon: 'success',
            title: `${ventasAprobadas.length} ventas offline subidas a la nube`,
            showConfirmButton: false, timer: 3000
        });
    }
}

// Disparadores automáticos:
// 1. Cuando el navegador detecta que volvió la red
window.addEventListener('online', sincronizarVentasOffline);

// 2. Cada 1 minuto revisa por las dudas si quedó algo trabado
setInterval(sincronizarVentasOffline, 60000);

// 3. Cuando se abre el POS por primera vez
document.addEventListener("DOMContentLoaded", () => {
    sincronizarVentasOffline();
});

// ===== BOTÓN COBRO EFECTIVO CONECTADO =====
async function confirmarCobroEfectivo() {
    let inputPaga = document.getElementById("inputPagaCon").value;
    let pagaCon = parseFloat(inputPaga);
    if (!inputPaga || isNaN(pagaCon) || pagaCon === 0) pagaCon = totalVenta;

    let vuelto = pagaCon - totalVenta;
    if (vuelto < 0) return Swal.fire('Falta dinero', 'El monto ingresado no cubre el total.', 'error');

    // 1. Cerramos el modal
    modalCobroEfectivo.hide();

    // 2. Ponemos a girar la rueda
    Swal.fire({ title: 'Procesando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    // 3. Mandamos a cobrar
    const resultado = await procesarVentaBackend('EFECTIVO', pagaCon);

    // 4. Si todo salió bien, mostramos el cartel de Venta Exitosa
    if (resultado) {
        let msjHTML = `Abonó con: $${pagaCon.toFixed(2)}<br><b>Entregar vuelto: $${resultado.vuelto.toFixed(2)}</b><br><br>Ticket N°: <b>${resultado.numero_ticket}</b><br><br><small class="text-muted">Presione <b>Enter</b> para Imprimir o <b>Esc</b> para Siguiente</small>`;
        const result = await Swal.fire({ title: '✅ Venta Exitosa', html: msjHTML, icon: 'success', showCancelButton: true, confirmButtonColor: '#198754', cancelButtonColor: '#6c757d', confirmButtonText: '<i class="bi bi-printer"></i> Imprimir (Enter)', cancelButtonText: 'Siguiente Cliente (Esc)' });

        if (result.isConfirmed) { imprimirTicket80mm(resultado.numero_ticket, pagaCon, resultado.vuelto, resultado.ahorro_total); }
        limpiarMostrador();
    }
}

// ===== BOTONES TARJETA / BILLETERA CONECTADOS =====
// ===== BOTONES TARJETA / BILLETERA CONECTADOS =====
async function cerrarVentaBasica(metodo) {
    if (carrito.length === 0) return Swal.fire('Error', 'El ticket está vacío.', 'error');

    // EL ESCUDO: Mini confirmación para evitar cobros accidentales por el lector láser
    const confirm = await Swal.fire({
        title: `¿Cobrar con ${metodo}?`,
        text: `Total a cobrar: $${totalVenta.toFixed(2)}`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#198754',
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'Sí, cobrar (Enter)',
        cancelButtonText: 'Cancelar (Esc)'
    });

    // Si cancela, devolvemos el cursor a la barra de búsqueda
    if (!confirm.isConfirmed) {
        inputScan.focus();
        return;
    }

    Swal.fire({ title: 'Procesando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    const resultado = await procesarVentaBackend(metodo, totalVenta);

    if (resultado) {
        const result = await Swal.fire({ title: `✅ Cobrado con ${metodo}`, html: `Ticket N°: <b>${resultado.numero_ticket}</b><br><br><small class="text-muted">Presione <b>Enter</b> para Imprimir o <b>Esc</b> para Siguiente</small>`, icon: 'success', showCancelButton: true, confirmButtonColor: '#198754', cancelButtonColor: '#6c757d', confirmButtonText: '<i class="bi bi-printer"></i> Imprimir (Enter)', cancelButtonText: 'Siguiente Cliente (Esc)' });
        if (result.isConfirmed) { imprimirTicket80mm(resultado.numero_ticket, totalVenta, 0, resultado.ahorro_total); }
        limpiarMostrador();
    }
}

// =========================================================
// GESTIÓN DE CLIENTES / FIADOS / HISTORIAL (BLOQUE UNIFICADO Y LIMPIO)
// =========================================================

let clientesGlobalesPOS = [];
let clienteFiadoActual = null;

// --- 1. SECCIÓN: COBRAR DEUDA (BOTÓN AMARILLO Y MODAL) ---

async function abrirModalCobroFiado() {
    document.getElementById("inputBuscarFiado").value = "";
    document.getElementById("cajaInfoFiado").classList.add("d-none");
    document.getElementById("dropdownFiado").classList.add("d-none");
    document.getElementById("tablaDetalleFiado").innerHTML = '<tr><td colspan="5" class="text-muted py-5 text-center">Busque un cliente para ver su historial.</td></tr>';

    modalDeuda.show();

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/clientes/listado`);
        const data = await res.json();
        clientesGlobalesPOS = data.clientes || data; // Soporta ambos formatos
        setTimeout(() => document.getElementById("inputBuscarFiado").focus(), 500);
    } catch (e) {
        console.error("Error al cargar clientes", e);
    }
}

function seleccionarClienteDeuda(id) {
    document.getElementById("dropdownFiado").classList.add("d-none");
    const cliente = clientesGlobalesPOS.find(c => c.id === id);
    if (!cliente) return;

    clienteFiadoActual = cliente;
    document.getElementById("inputBuscarFiado").value = cliente.nombre_completo;

    document.getElementById("cajaInfoFiado").classList.remove("d-none");
    document.getElementById("nombreClienteFiado").innerText = cliente.nombre_completo;
    document.getElementById("limiteClienteFiado").innerText = (cliente.limite_credito || 0).toLocaleString();
    document.getElementById("deudaClienteFiado").innerText = `$ ${cliente.saldo_actual_deudor.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;

    cargarHistorialTabla(cliente.id);
}

// Variables globales para controlar la paginación del historial
let movimientosHistorialGlobal = [];
let limiteMostrarHistorial = 15;

async function cargarHistorialTabla(clienteId) {
    const tbody = document.getElementById("tablaDetalleFiado");
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/clientes/historial/${clienteId}`);
        const data = await res.json();
        tbody.innerHTML = "";

        if (!data.movimientos || data.movimientos.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-success fw-bold">Cuenta al día.</td></tr>`;
            return;
        }

        // Guardamos todos los movimientos en la memoria del navegador
        movimientosHistorialGlobal = data.movimientos;
        limiteMostrarHistorial = 15; // Reiniciamos el límite a 15 cada vez que buscamos un cliente

        dibujarFilasHistorial();

    } catch (e) {
        tbody.innerHTML = "<tr><td colspan='5'>Error al cargar historial.</td></tr>";
    }
}

function dibujarFilasHistorial() {
    const tbody = document.getElementById("tablaDetalleFiado");
    tbody.innerHTML = "";

    // Cortamos la lista para mostrar solo la cantidad permitida (los primeros 15)
    const listaVisible = movimientosHistorialGlobal.slice(0, limiteMostrarHistorial);

    listaVisible.forEach(m => {
        let esPago = m.tipo_movimiento === 'PAGO';
        let numTicket = m.detalle.includes('#') ? m.detalle.split('#')[1] : '-';

        tbody.innerHTML += `
        <tr>
            <td class="text-muted small align-middle">${m.fecha_hora.split(' ')[0]}</td>
            <td class="align-middle"><span class="badge ${esPago ? 'bg-success' : 'bg-danger'}">${m.tipo_movimiento}</span></td>
            <td class="text-start small align-middle">${m.detalle}</td>
            <td class="fw-bold ${esPago ? 'text-success' : 'text-danger'} align-middle">${esPago ? '-' : ''}$${m.monto.toFixed(2)}</td>
            <td class="text-end align-middle">
                ${!esPago && numTicket !== '-' ? `
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-info py-0" onclick="verDetalleTicketFiado(${numTicket})" title="Ver Detalle"><i class="bi bi-eye"></i></button>
                    <button class="btn btn-sm btn-outline-secondary py-0" onclick="imprimirTicket80mm(${numTicket})" title="Imprimir"><i class="bi bi-printer"></i></button>
                </div>` : ''}
            </td>
        </tr>`;
    });

    // Si quedaron movimientos afuera de los 15, mostramos el botón "Ver más" al final
    if (movimientosHistorialGlobal.length > limiteMostrarHistorial) {
        tbody.innerHTML += `
        <tr>
            <td colspan="5" class="text-center py-2 bg-light border-0">
                <button class="btn btn-sm btn-outline-secondary fw-bold shadow-sm" onclick="mostrarMasHistorial()">
                    <i class="bi bi-arrow-down-circle"></i> Cargar más movimientos antiguos
                </button>
            </td>
        </tr>`;
    }
}

function mostrarMasHistorial() {
    limiteMostrarHistorial += 15; // Sumamos 15 registros más al límite
    dibujarFilasHistorial(); // Volvemos a dibujar la tabla instantáneamente
}

async function verDetalleTicketFiado(ventaId) {
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
                 <div class="text-end fw-bold fs-5 mt-2 text-danger">Total Llevado: $${data.totales.total_a_pagar.toFixed(2)}</div>`;

        Swal.fire({
            title: `<i class="bi bi-receipt text-primary"></i> Detalle del Ticket #${ventaId}`,
            html: html, width: '500px', showCloseButton: true, confirmButtonText: 'Cerrar', confirmButtonColor: '#6c757d'
        });
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el detalle del ticket.', 'error');
    }
}

function buscarClienteFiado() {
    const query = normalizarTexto(document.getElementById("inputBuscarFiado").value);
    const dropdown = document.getElementById("dropdownFiado");

    if (query.length < 2) {
        dropdown.classList.add("d-none");
        return;
    }

    const palabras = query.split(" ").filter(p => p !== "");
    const resultados = clientesGlobalesPOS.filter(c => {
        const fuente = normalizarTexto(`${c.nombre_completo} ${c.cuit || ''}`);
        return palabras.every(p => fuente.includes(p));
    });

    dropdown.innerHTML = "";
    if (resultados.length === 0) {
        dropdown.innerHTML = '<div class="list-group-item text-muted">No se encontraron clientes</div>';
    } else {
        resultados.forEach(c => {
            // EL ARREGLO 1: Le agregamos la clase 'span-nombre' para poder ubicarlo después
            dropdown.innerHTML += `
            <button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="seleccionarClienteDeuda(${c.id})">
                <span class="fw-bold span-nombre text-primary">${c.nombre_completo}</span>
                <span class="badge bg-light text-dark border">DNI: ${c.cuit || '-'}</span>
            </button>`;
        });
    }
    dropdown.classList.remove("d-none");
}

let indiceDropdownFiado = -1;

function navegarDropdownFiado(e) {
    const dropdown = document.getElementById("dropdownFiado");
    const items = dropdown.querySelectorAll("button");

    if (items.length === 0 || dropdown.classList.contains("d-none")) return;

    if (e.key === "ArrowDown") {
        e.preventDefault();
        indiceDropdownFiado++;
        if (indiceDropdownFiado >= items.length) indiceDropdownFiado = 0;
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        indiceDropdownFiado--;
        if (indiceDropdownFiado < 0) indiceDropdownFiado = items.length - 1;
    } else if (e.key === "Enter") {
        e.preventDefault();
        if (indiceDropdownFiado >= 0 && indiceDropdownFiado < items.length) {
            items[indiceDropdownFiado].click();
        } else if (items.length > 0) {
            items[0].click();
        }
        return;
    } else {
        indiceDropdownFiado = -1;
        return;
    }

    // EL ARREGLO 2: Hacemos que el texto se vuelva blanco al seleccionarlo
    items.forEach(btn => {
        btn.classList.remove("active", "bg-primary");
        let span = btn.querySelector('.span-nombre');
        if (span) { span.classList.add("text-primary"); span.classList.remove("text-white"); }
    });

    if (indiceDropdownFiado >= 0) {
        let activeBtn = items[indiceDropdownFiado];
        activeBtn.classList.add("active", "bg-primary");
        let span = activeBtn.querySelector('.span-nombre');
        if (span) { span.classList.remove("text-primary"); span.classList.add("text-white"); }
        activeBtn.scrollIntoView({ block: "nearest" });
    }
}

async function registrarPagoFiado() {
    const pago = parseFloat(document.getElementById("montoPagoFiado").value);
    const metodo = document.getElementById("metodoPagoFiado").value; // <-- CAPTURAMOS EL MÉTODO ELEGIDO

    if (isNaN(pago) || pago <= 0) return Swal.fire('Error', 'Ingrese un monto válido.', 'error');

    if (pago > clienteFiadoActual.saldo_actual_deudor && clienteFiadoActual.saldo_actual_deudor > 0) {
        const confirm = await Swal.fire({ title: 'Pago Superior a la Deuda', text: 'El cliente está entregando más plata de la que debe. ¿Aceptar igual?', icon: 'warning', showCancelButton: true, confirmButtonText: 'Sí, cobrar' });
        if (!confirm.isConfirmed) return;
    }

    Swal.fire({ title: 'Acreditando pago...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/clientes/pagar_deuda/${clienteFiadoActual.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                monto_pago: pago,
                metodo_pago: metodo, // <-- SE LO MANDAMOS A PYTHON
                usuario_id: empleadoLogueado ? empleadoLogueado.id : 1
            })
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        clienteFiadoActual.saldo_actual_deudor -= pago;
        document.getElementById("montoPagoFiado").value = "";
        document.getElementById("deudaClienteFiado").innerText = `$ ${clienteFiadoActual.saldo_actual_deudor.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;

        await Swal.fire({ title: 'PAGO REGISTRADO', text: `Acreditado mediante ${metodo}`, icon: 'success', timer: 2000, showConfirmButton: false });

        cargarHistorialTabla(clienteFiadoActual.id);
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// --- 2. SECCIÓN: DAR FIADO (ASIGNAR CLIENTE Y BOTÓN NARANJA) ---

// VARIABLES GLOBALES AMPLIADAS PARA MEMORIA DE LA CAJA
let limiteClienteGlobal = 0;
let deudaClienteGlobal = 0;

async function abrirSeleccionCliente() {
    modalSeleccionCliente.show();
    document.getElementById('listaClientesAsignacion').innerHTML = '<div class="text-center p-3 text-muted">Cargando clientes...</div>';
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/clientes/listado`);
        const data = await res.json();
        clientesGlobalesPOS = data.clientes || data;
        filtrarClientesAsignacion();
        setTimeout(() => document.getElementById('inputBuscarAsignarCliente').focus(), 500);
    } catch (e) {
        document.getElementById('listaClientesAsignacion').innerHTML = '<div class="text-danger p-3">Error conectando con la base de datos.</div>';
    }
}

function filtrarClientesAsignacion() {
    const query = normalizarTexto(document.getElementById('inputBuscarAsignarCliente').value);
    const contenedor = document.getElementById('listaClientesAsignacion');
    contenedor.innerHTML = `<button class="list-group-item list-group-item-action fw-bold text-primary" onclick="asignarClienteAlTicket('Consumidor Final', null, 0, 0)"><i class="bi bi-person"></i> Consumidor Final (Quitar cliente)</button>`;

    if (!Array.isArray(clientesGlobalesPOS)) return;

    const palabras = query.split(" ").filter(p => p !== "");
    const resultados = clientesGlobalesPOS.filter(c => {
        const nombreLimpio = normalizarTexto(c.nombre_completo);
        const cuitLimpio = normalizarTexto(c.cuit || '');
        return palabras.every(pal => nombreLimpio.includes(pal) || cuitLimpio.includes(pal));
    });

    resultados.forEach(c => {
        const deuda = c.saldo_actual_deudor || 0;
        const limite = c.limite_credito || 0;

        let badgeDeuda = `<span class="badge bg-success rounded-pill">A Favor: $${Math.abs(deuda).toFixed(2)}</span>`;
        if (deuda > 0) badgeDeuda = `<span class="badge bg-danger rounded-pill">Debe: $${deuda.toFixed(2)}</span>`;
        else if (deuda === 0) badgeDeuda = `<span class="badge bg-secondary rounded-pill">$0.00</span>`;

        contenedor.innerHTML += `
        <button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="asignarClienteAlTicket('${c.nombre_completo}', ${c.id}, ${limite}, ${deuda})">
            <span><i class="bi bi-person-check"></i> ${c.nombre_completo}</span>
            ${badgeDeuda}
        </button>`;
    });
}

function asignarClienteAlTicket(nombre, id, limite, deuda) {
    clienteSeleccionadoId = id;
    limiteClienteGlobal = limite;
    deudaClienteGlobal = deuda;

    let extra = "";
    if (id && deuda > 0) extra = ` <span class="badge bg-danger ms-1 px-1 py-0">Debe: $${deuda.toFixed(0)}</span>`;
    else if (id && deuda < 0) extra = ` <span class="badge bg-success ms-1 px-1 py-0">A favor: $${Math.abs(deuda).toFixed(0)}</span>`;

    document.getElementById("nombreClienteTicket").innerHTML = `${nombre} ${extra}`;
    modalSeleccionCliente.hide();
    inputScan.focus();
}

async function mandarACtaCte() {
    if (carrito.length === 0) return Swal.fire('Error', 'El ticket está vacío.', 'error');

    if (!clienteSeleccionadoId) {
        Swal.fire({ title: 'Cliente Requerido', text: "Seleccione un cliente para anotarle la cuenta.", icon: 'warning' }).then(() => { abrirSeleccionCliente(); });
        return;
    }

    let firmaAutorizacion = null;

    const proximaDeuda = deudaClienteGlobal + totalVenta;
    if (proximaDeuda > limiteClienteGlobal) {
        if (empleadoLogueado && (empleadoLogueado.rol === 'ADMIN' || empleadoLogueado.rol === 'ENCARGADO')) {
            const confirmar = await Swal.fire({ title: 'Límite Excedido', text: `La deuda llegará a $${proximaDeuda.toFixed(2)}. Como sos ${empleadoLogueado.rol}, podés autorizarlo. ¿Avanzar?`, icon: 'warning', showCancelButton: true, confirmButtonText: 'Sí, forzar fiado' });
            if (!confirmar.isConfirmed) return;

            // PARCHE BLINDADO: Buscamos tu nombre de todas las formas posibles
            firmaAutorizacion = empleadoLogueado.nombre_completo || empleadoLogueado.usuario || empleadoLogueado.nombre || "Administrador Autorizado";
        } else {
            const autorizadoPor = await solicitarAutorizacion(`La deuda superará el límite permitido de $${limiteClienteGlobal.toFixed(2)}.`);
            if (!autorizadoPor) return;

            firmaAutorizacion = autorizadoPor;
        }
    }

    Swal.fire({ title: 'Procesando Fiado...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    // LE ENVIAMOS LA FIRMA A PYTHON COMO 4TO PARÁMETRO
    const resultado = await procesarVentaBackend('CUENTA CORRIENTE', totalVenta, null, firmaAutorizacion);

    if (resultado) {
        const nombreLimpio = document.getElementById("nombreClienteTicket").innerText.split(' Debe')[0].split(' A favor')[0].trim();
        const result = await Swal.fire({ title: '✅ Cuenta Corriente Actualizada', html: `Se cargaron <b>$${totalVenta.toFixed(2)}</b> a la cuenta de ${nombreLimpio}.<br><br>¿Imprimir remito para firma?`, icon: 'success', showCancelButton: true, confirmButtonColor: '#198754', cancelButtonColor: '#6c757d', confirmButtonText: '<i class="bi bi-printer"></i> Imprimir', cancelButtonText: 'Cerrar' });
        if (result.isConfirmed) { imprimirRemitoFiado(nombreLimpio, totalVenta, [...carrito]); }
        limpiarMostrador();
    }
}

// --- 3. CREAR CLIENTE NUEVO DESDE EL POS ---
async function guardarNuevoCliente() {
    const dni = document.getElementById("nuevoClienteDni").value;
    const nombre = document.getElementById("nuevoClienteNombre").value;
    const pin = document.getElementById("pinAutorizacion").value;
    const limite = parseFloat(document.getElementById("nuevoClienteLimite").value) || 50000;

    if (!nombre || !dni) return Swal.fire('Error', 'El nombre y el DNI son obligatorios.', 'error');

    // VERIFICACIÓN CON EL BACKEND EN VEZ DE 1234
    Swal.fire({ title: 'Autorizando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const resAuth = await apiFetch(`${obtenerBaseUrl()}/usuarios/autorizar`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin_secreto: pin, roles_permitidos: ['ENCARGADO', 'ADMIN'] })
        });
        if (!resAuth.ok) throw new Error("PIN Incorrecto");
    } catch (e) {
        return Swal.fire('Denegado', 'PIN de Encargado incorrecto o sin privilegios.', 'error');
    }

    Swal.fire({ title: 'Guardando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/clientes/registrar`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre_completo: nombre, cuit: dni, telefono_whatsapp: "", limite_credito: limite })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        Swal.fire({ title: '¡Cliente Creado!', text: data.mensaje, icon: 'success', timer: 1500, showConfirmButton: false });

        document.getElementById("nuevoClienteDni").value = ""; document.getElementById("nuevoClienteNombre").value = "";
        document.getElementById("pinAutorizacion").value = ""; document.getElementById("nuevoClienteLimite").value = "50000";
        modalNuevoCliente.hide(); abrirSeleccionCliente();
    } catch (e) { Swal.fire('Error', e.message, 'error'); }
}

function ponerEnEspera() {
    if (carrito.length === 0) return;

    ventasEnEspera.push({
        carro: [...carrito], dto: porcentajeDescuento, rec: porcentajeRecargo,
        cliente: document.getElementById("nombreClienteTicket").innerText,
        totalEstimado: totalVenta
    });

    // MAGIA: Guardamos la lista de espera en la mochila
    localStorage.setItem('ventas_espera_pos', JSON.stringify(ventasEnEspera));

    limpiarMostrador();
    document.getElementById('badgeEspera').innerText = `${ventasEnEspera.length} en espera`;
}

function recuperarVenta() {
    if (ventasEnEspera.length === 0) return Swal.fire('Aviso', 'No hay ventas en espera.', 'info');
    if (carrito.length > 0) return Swal.fire('Error', 'Deje el ticket actual en espera o anúlelo antes de recuperar otro.', 'warning');

    // Armamos una lista visual con los tickets en espera
    let opcionesHTML = '<div class="list-group text-start mt-3">';
    ventasEnEspera.forEach((v, index) => {
        let cantArticulos = v.carro.reduce((acc, curr) => acc + curr.cantidad, 0);
        opcionesHTML += `
            <button type="button" class="list-group-item list-group-item-action shadow-sm mb-2 border rounded" onclick="cargarVentaEspera(${index})">
                <div class="d-flex w-100 justify-content-between">
                    <h5 class="mb-1 fw-bold text-primary"><i class="bi bi-person-fill"></i> ${v.cliente}</h5>
                    <span class="fs-5 fw-bold text-success">$${v.totalEstimado.toFixed(2)}</span>
                </div>
                <small class="text-muted fw-bold">${cantArticulos} artículos guardados en el carrito.</small>
            </button>`;
    });
    opcionesHTML += '</div>';

    Swal.fire({
        title: '<i class="bi bi-pause-circle"></i> Ventas en Espera',
        html: opcionesHTML,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: 'Cerrar ventana'
    });
}

// Función que el botón de la lista llama para cargar los datos a la caja
function cargarVentaEspera(index) {
    Swal.close();
    let recuperado = ventasEnEspera.splice(index, 1)[0];

    // MAGIA: Actualizamos la mochila (ahora tiene uno menos)
    localStorage.setItem('ventas_espera_pos', JSON.stringify(ventasEnEspera));

    carrito = recuperado.carro; porcentajeDescuento = recuperado.dto; porcentajeRecargo = recuperado.rec;
    document.getElementById("nombreClienteTicket").innerText = recuperado.cliente;
    document.getElementById('badgeEspera').innerText = `${ventasEnEspera.length} en espera`;
    actualizarTabla(); inputScan.focus();
}

// --- MÓDULO INGRESO Y RETIRO DE CAJA (F10) (SIN HARDCODEO) ---
async function registrarMovimientoCaja(tipo) {
    modalGestion.hide();

    const titulo = tipo === 'ingreso' ? 'Ingreso de Dinero' : 'Retiro de Dinero';
    const colorBtn = tipo === 'ingreso' ? '#198754' : '#dc3545';

    let inputsHtml = '<input id="swal-monto" type="number" class="swal2-input" placeholder="Monto ($)" style="max-width: 80%;">' +
        '<input id="swal-motivo" type="text" class="swal2-input" placeholder="Motivo / Concepto" style="max-width: 80%;">';

    if (tipo === 'retiro') {
        inputsHtml += '<hr><input id="swal-pin" type="password" class="swal2-input" placeholder="PIN Encargado" style="max-width: 80%; border-color: #ffc107;">';
    }

    const { value: formValues } = await Swal.fire({
        title: titulo,
        html: inputsHtml,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Registrar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: colorBtn,
        didOpen: () => {
            const popup = Swal.getPopup();
            const inputs = popup.querySelectorAll('input');
            inputs.forEach(input => {
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') Swal.clickConfirm();
                });
            });
            setTimeout(() => document.getElementById('swal-monto').focus(), 300);
        },
        preConfirm: async () => {
            const monto = document.getElementById('swal-monto').value;
            const motivo = document.getElementById('swal-motivo').value;
            const pinEl = document.getElementById('swal-pin');

            if (!monto || monto <= 0) { Swal.showValidationMessage('Ingrese un monto mayor a 0'); return false; }
            if (!motivo) { Swal.showValidationMessage('Debe especificar el motivo'); return false; }

            if (tipo === 'retiro') {
                if (!pinEl || !pinEl.value) { Swal.showValidationMessage('Ingrese su PIN secreto'); return false; }
                try {
                    const resAuth = await apiFetch(`${obtenerBaseUrl()}/usuarios/autorizar`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pin_secreto: pinEl.value, roles_permitidos: ['ENCARGADO', 'ADMIN'] })
                    });
                    if (!resAuth.ok) throw new Error("Inválido");
                } catch (e) {
                    Swal.showValidationMessage('PIN incorrecto o sin permisos');
                    return false;
                }
            }

            return { monto: parseFloat(monto), motivo: motivo };
        }
    });

    if (formValues) {
        try {
            // INYECTAMOS LA CABALLERÍA PESADA
            const payloadMovimiento = {
                tipo_movimiento: tipo,
                monto: formValues.monto,
                observaciones: formValues.motivo,
                turno_id: turnoActualId,
                caja_id: terminal_id, // Para que la plata afecte a ESTA caja
                usuario_id: empleadoLogueado.id // Para que sepamos qué cajero la tocó
            };

            const response = await apiFetch(`${obtenerBaseUrl()}/caja/movimiento`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}` // Usamos la llave maestra
                },
                body: JSON.stringify(payloadMovimiento)
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || "Fallo en el servidor");
            }

            Swal.fire({ title: '✅ Registrado', text: `Se guardó un ${tipo} de $${formValues.monto} en el sistema.`, icon: 'success', timer: 2000, showConfirmButton: false });
        } catch (e) {
            Swal.fire('Error', e.message, 'error');
        }
        setTimeout(() => inputScan.focus(), 2000);
    } else {
        inputScan.focus();
    }
}

// --- BÚSQUEDA AVANZADA (F3) CONECTADA AL BACKEND ---
function abrirBuscadorAvanzado() {
    modalBuscador.show();
    setTimeout(() => { document.getElementById('inputBusquedaAvanzada').focus(); filtrarAvanzado(); }, 500);
}

// Variable global para controlar en qué fila estamos parados con el teclado
let indexFilaF3 = -1;
let temporizadorF3 = null; // <-- LA MEMORIA DEL AMORTIGUADOR

async function filtrarAvanzado(event) {
    if (event && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')) return;

    const query = document.getElementById('inputBusquedaAvanzada').value.trim().toLowerCase();
    const tbody = document.getElementById('tablaResultadosF3');

    if (query.length < 2) {
        tbody.innerHTML = '';
        indexFilaF3 = -1;
        return;
    }

    clearTimeout(temporizadorF3);

    temporizadorF3 = setTimeout(async () => {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3"><div class="spinner-border spinner-border-sm text-primary" role="status"></div> Buscando...</td></tr>';

        let resultados = [];

        try {
            if (!navigator.onLine) throw new Error("OFFLINE");
            const response = await apiFetch(`${obtenerBaseUrl()}/productos/buscar?termino=${encodeURIComponent(query)}`);
            if (!response.ok) throw new Error("Fallo");

            const data = await response.json();
            resultados = data.productos;
        } catch (error) {
            // GUARDAVIDAS F3 OFFLINE
            if (error.message === "OFFLINE" || error.message === "Failed to apiFetch" || error.message.includes("NetworkError")) {
                let catalogoOffline = JSON.parse(localStorage.getItem('catalogo_productos_offline')) || [];
                let palabras = query.split(" ");

                resultados = catalogoOffline.filter(p => {
                    let textoProd = (p.nombre + " " + (p.codigo_barras || "")).toLowerCase();
                    return palabras.every(pal => textoProd.includes(pal));
                }).slice(0, 50); // Cortamos en 50 para que no se trabe la pantalla sin internet
            } else {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger py-3">Error interno al cargar la lista</td></tr>`;
                return;
            }
        }

        // Renderizamos (Sea de Python o de la mochila)
        tbody.innerHTML = '';
        if (resultados && resultados.length > 0) {
            resultados.forEach((p) => {
                let categoriaTexto = p.categoria_id ? `Cat ID ${p.categoria_id}` : "Sin Rubro";
                let codigoMostrar = p.codigo_barras || p.id;
                let precioMostrar = p.precio_venta_final || 0;

                tbody.innerHTML += `
                    <tr class="fila-busqueda" onclick="agregarDesdeF3('${p.id}')">
                        <td class="text-muted fw-bold">${codigoMostrar}</td>
                        <td class="fw-bold">${p.nombre}</td>
                        <td><span class="badge bg-secondary">${categoriaTexto}</span></td>
                        <td class="text-end fw-bold text-success">$${precioMostrar.toFixed(2)}</td>
                    </tr>
                `;
            });
            indexFilaF3 = -1;
        } else {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-3">No se encontraron resultados</td></tr>`;
        }
    }, 300);
}

// --- NAVEGACIÓN POR TECLADO EN BUSCADOR (F3) ---
document.getElementById('inputBusquedaAvanzada').addEventListener('keydown', function (e) {
    const filas = document.querySelectorAll('#tablaResultadosF3 tr.fila-busqueda');
    if (filas.length === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        indexFilaF3++;
        if (indexFilaF3 >= filas.length) indexFilaF3 = 0;
        resaltarFilaF3(filas);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        indexFilaF3--;
        if (indexFilaF3 < 0) indexFilaF3 = filas.length - 1;
        resaltarFilaF3(filas);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (indexFilaF3 >= 0 && indexFilaF3 < filas.length) {
            filas[indexFilaF3].click(); // Simula el click en la fila seleccionada
        }
    }
});

function resaltarFilaF3(filas) {
    filas.forEach(f => f.classList.remove('table-primary'));
    if (indexFilaF3 >= 0) {
        const filaSeleccionada = filas[indexFilaF3];
        filaSeleccionada.classList.add('table-primary');
        // Mueve el scroll suavemente para que la fila siempre se vea
        filaSeleccionada.scrollIntoView({ behavior: "instant", block: "nearest" });
    }
}

async function agregarDesdeF3(id_producto) {
    modalBuscador.hide();
    try {
        if (!navigator.onLine) throw new Error("OFFLINE");

        const res = await apiFetch(`${obtenerBaseUrl()}/productos/codigo/${id_producto}`);
        const prod = await res.json();
        if (!prod.error) agregarAlCarrito(prod);

    } catch (e) {
        if (e.message === "OFFLINE" || e.message === "Failed to apiFetch" || e.message.includes("NetworkError")) {
            let catalogo = JSON.parse(localStorage.getItem('catalogo_productos_offline')) || [];
            let prod = catalogo.find(p => p.id.toString() === id_producto.toString());
            if (prod) agregarAlCarrito(prod);
        }
    }
    inputScan.focus();
}

// Atajos de teclado blindados contra modales abiertos
document.addEventListener('keydown', (e) => {
    if (!cajaAbierta) return;
    if (document.querySelector('.modal.show')) return;
    if (Swal.isVisible()) return;

    if (e.key === "F2") { e.preventDefault(); inputScan.focus(); }
    if (e.key === "F3") { e.preventDefault(); abrirBuscadorAvanzado(); }
    if (e.key === "F4") { e.preventDefault(); borrarUltimo(); }
    if (e.key === "F5") { e.preventDefault(); anularVentaConAviso(); }
    if (e.key === "F8") { e.preventDefault(); recuperarVenta(); }
    if (e.key === "F9") { e.preventDefault(); ponerEnEspera(); }
    if (e.key === "F10") { e.preventDefault(); modalGestion.show(); }
    if (e.key === "F12") { e.preventDefault(); prepararCobroEfectivo(); }
});


function imprimirTicketCaja(tipo, payload, montoDeclaradoManual = 0) {
    console.log("DATOS CAJA:", payload);
    const d = payload.resumen_parcial || payload.resumen || payload || {};

    const esCierreZ = (tipo === 'Z' || tipo === 'z');
    const tituloReporte = esCierreZ ? "CIERRE Z (FINAL)" : "ARQUEO X (PARCIAL)";

    const nombreCajero = (typeof empleadoLogueado !== 'undefined' && empleadoLogueado && empleadoLogueado.nombre)
        ? empleadoLogueado.nombre
        : (localStorage.getItem('usuario_nombre') || "Caja Principal");
    // Mapeo ampliado (agregamos más opciones para atrapar los fiados)
    const fondoIni = d.fondo_inicial ?? 0;
    const vEfectivo = d.ventas_en_efectivo ?? d.efectivo ?? 0;
    const vTransf = d.ventas_virtual ?? d.transferencias ?? 0;
    const vTarjetas = d.ventas_tarjeta ?? d.tarjetas ?? 0;
    const vFiados = d.ventas_fiados ?? d.fiados ?? d.ventas_cta_cte ?? d.cta_cte ?? 0;

    const vTotales = vEfectivo + vTransf + vTarjetas + vFiados;
    const ingresos = d.ingresos_extras ?? 0;
    const retiros = d.retiros_y_gastos ?? 0;

    const esperado = d.plata_que_deberia_haber_ahora ?? (fondoIni + vEfectivo + ingresos - retiros);

    // EL PARCHE DEL CERO: Si Python no lo manda, usamos el que el cajero tipeó recién
    const declarado = d.monto_final_declarado ?? montoDeclaradoManual;
    const diferencia = declarado - esperado;

    let html = `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
    @page { margin: 0; } 
    body { font-family: Arial, sans-serif; font-size: 12px; font-weight: 600; width: 76mm; padding: 2mm 6mm 2mm 0mm; margin: 0; color: #000; -webkit-font-smoothing: none; box-sizing: border-box; }
    .center { text-align: center; } .left { text-align: left; } .bold { font-weight: bold; }
    .divisor { border-top: 1px dashed #000; margin: 5px 0; }
    .divisor-doble { border-top: 2px solid #000; border-bottom: 2px solid #000; height: 2px; margin: 5px 0; }
    .fila { display: flex; justify-content: space-between; margin-bottom: 3px; }
    .fila span:last-child { text-align: right; padding-left: 5px; word-break: break-all; }
</style></head>
<body>
    <div class="center bold" style="font-size: 16px;">AUTOSERVICIO 20 DE JUNIO</div>
    <div class="center bold" style="font-size: 14px; margin-top: 5px;">${tituloReporte}</div>
    <div class="divisor"></div>
    <div class="fila"><span>Fecha:</span> <span>${new Date().toLocaleString('es-AR')}</span></div>
    <div class="fila"><span>Cajero:</span> <span>${nombreCajero}</span></div>
    <div class="divisor-doble"></div>

    <div class="center bold" style="margin-bottom: 6px;">--- VENTAS DEL TURNO ---</div>
    <div class="fila"><span>Efectivo:</span> <span>$${vEfectivo.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
    <div class="fila"><span>Virtual / Billeteras:</span> <span>$${vTransf.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
    <div class="fila"><span>Tarjetas (POS):</span> <span>$${vTarjetas.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
    <div class="fila"><span>Fiados (Cta. Cte.):</span> <span>$${vFiados.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
    <div class="divisor"></div>
    <div class="fila bold" style="font-size: 14px;"><span>TOTAL VENDIDO:</span> <span>$${vTotales.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
`;

    if (esCierreZ) {
        html += `
    <div class="divisor-doble"></div>
    <div class="center bold" style="margin-bottom: 6px;">--- MOVIMIENTOS DE CAJA ---</div>
    <div class="fila"><span>Fondo Inicial:</span> <span>$${fondoIni.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
    <div class="fila"><span>Ingresos Manuales:</span> <span>$${ingresos.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
    <div class="fila"><span>Retiros / Gastos:</span> <span>-$${retiros.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
    
    <div class="divisor"></div>
    <div class="fila bold"><span>SISTEMA ESPERABA:</span> <span>$${esperado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
    
    <div class="fila mt-2 bold" style="border: 1px solid #000; padding: 2px;">
        <span>CAJERO DECLARÓ:</span> <span>$${declarado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
    </div>
    
    <div class="fila bold mt-1">
        <span>${diferencia < 0 ? 'FALTANTE:' : 'SOBRANTE:'}</span> 
        <span>$${Math.abs(diferencia).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
    </div>
`;
    } else {
        html += `<div class="center mt-2 small">Datos de fondo de caja ocultos por seguridad.</div>`;
    }

    html += `
    <div class="divisor"></div>
    <div class="center" style="margin-top: 10px;">${esCierreZ ? '*** FIN DE TURNO ***' : '*** FIN DEL ARQUEO ***'}</div>
    <div style="margin-bottom: 10mm;"></div>
</body></html>
`;

    if (typeof require !== 'undefined') {
        // MODO ESCRITORIO (NATIVO)
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('imprimir-silencioso', html);
    } else {
        // MODO WEB (DE EMERGENCIA)
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.srcdoc = html;
        document.body.appendChild(iframe);
        iframe.onload = () => {
            iframe.contentWindow.print();
            setTimeout(() => { document.body.removeChild(iframe); }, 1000);
        };
    }
}

// ==============================================================
// 2. LA FUNCIÓN DEL ARQUEO X (REEMPLAZAR COMPLETA)
// ==============================================================
async function ejecutarArqueoX() {
    if (!turnoActualId) return Swal.fire('Error', 'No hay turno abierto.', 'error');
    modalGestion.hide();
    const res = await apiFetch(`${obtenerBaseUrl()}/caja/informe_x/${turnoActualId}`);
    const data = await res.json();
    if (data.error) return Swal.fire('Error', data.error, 'error');

    // Le pasamos la data entera para que nuestro nuevo blindaje la revise
    imprimirTicketCaja('X', data);
}

// ==============================================================
// 3. LA FUNCIÓN DEL CIERRE Z (REEMPLAZAR COMPLETA)
// ==============================================================
async function cierreZ() {
    if (carrito.length > 0) return Swal.fire('Error', 'Anule la venta en curso antes de cerrar la caja.', 'error');
    modalGestion.hide();

    const { value: montoDeclarado } = await Swal.fire({
        title: 'CIERRE Z (Finalizar Turno)',
        text: 'Ingrese el dinero físico (billetes) que hay en el cajón ahora mismo:',
        input: 'number',
        inputPlaceholder: 'Ej: 56000',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Cerrar Turno',
        preConfirm: (val) => {
            if (!val || val < 0) Swal.showValidationMessage('Ingrese un monto válido');
            return parseFloat(val);
        }
    });

    if (montoDeclarado !== undefined) {
        Swal.fire({ title: 'Cerrando caja...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        try {
            const res = await apiFetch(`${obtenerBaseUrl()}/caja/cerrar`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ turno_id: turnoActualId, monto_final_declarado: montoDeclarado })
            });

            const data = await res.json();

            if (!res.ok) {
                let msjError = "Fallo de comunicación con Python";
                if (data.detail && Array.isArray(data.detail)) msjError = "Datos incorrectos: " + data.detail[0].loc.join(" -> ");
                throw new Error(msjError);
            }
            if (data.error) throw new Error(data.detalle || data.error);

            imprimirTicketCaja('Z', data, montoDeclarado);

            cajaAbierta = false;
            turnoActualId = null;

            await Swal.fire({
                title: '¡Caja Cerrada!',
                text: 'El turno se cerró correctamente. Esperá que termine de imprimir el comprobante antes de salir.',
                icon: 'success',
                confirmButtonText: '<i class="bi bi-box-arrow-right"></i> Salir del POS',
                allowOutsideClick: false
            });

            // Rescatamos el número de terminal antes de la explosión
            let terminalGuardada = localStorage.getItem('caja_fisica_id');

            localStorage.clear(); // Detona la sesión

            // Volvemos a guardar la terminal para que no pierda la memoria
            if (terminalGuardada) {
                localStorage.setItem('caja_fisica_id', terminalGuardada);
            }

            window.location.href = "index.html";

        } catch (e) {
            Swal.fire('Error al cerrar caja', e.message, 'error');
        }
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

// ===== NUEVO MOTOR: IMPRESIÓN DE TICKET 80mm (Diseño Real) =====
// ===== NUEVO MOTOR: IMPRESIÓN DE TICKET 80mm (Blindado para Offline) =====
async function imprimirTicket80mm(ticketId, pagoReal = null, vueltoReal = null, ahorroReal = 0) {
    try {
        // 1. Configuracion siempre desde la mochila (es más rápido y no requiere internet)
        const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: "Mi Negocio", direccion: "", cuit: "00-00000000-0", mensaje_ticket: "¡Gracias por su compra!" };
        // Adentro de tu función que actualiza los totales:
        let cantidadTotalArticulos = carrito.reduce((acumulador, item) => {
            const esPesable = (item.unidad_medida || "un").toLowerCase().includes("kg") || item.tipo_venta === 'PESO';
            return acumulador + (esPesable ? 1 : parseFloat(item.cantidad));
        }, 0);
        document.getElementById('visorCantidadArticulos').innerText = `(${cantidadTotalArticulos} Artículos)`;
        let ticket;

        // 2. ¿Es un ticket normal o un ticket del bote salvavidas (Offline)?
        if (ticketId.toString().startsWith('OFF-')) {
            // Modo Offline: Lo armamos a mano leyendo la mochila
            let ventasPendientes = JSON.parse(localStorage.getItem('ventas_offline')) || [];
            let ventaOffline = ventasPendientes.find(v => v.ticket_temporal === ticketId);

            if (!ventaOffline) return Swal.fire('Error', 'Ticket offline no encontrado en la memoria.', 'error');

            let subtotalArticulos = ventaOffline.items.reduce((acc, i) => acc + (i.cantidad * i.precio_unitario), 0);
            let totalCobrado = subtotalArticulos + (ventaOffline.descuento_recargo_global || 0);

            // Fabricamos el "sobre" falso para que la impresora lo entienda
            ticket = {
                encabezado: {
                    numero_ticket: ticketId,
                    fecha: new Date().toLocaleDateString('es-AR') + ' ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
                    cliente: ventaOffline.nombre_cliente_factura
                },
                detalle_compra: ventaOffline.items.map(item => ({
                    cantidad: item.cantidad,
                    nombre: item.nombre_fantasma,
                    unidad_medida: "un",
                    precio_unitario: item.precio_unitario,
                    subtotal: item.cantidad * item.precio_unitario
                })),
                totales: {
                    subtotal_articulos: subtotalArticulos,
                    descuentos_o_recargos: ventaOffline.descuento_recargo_global || 0,
                    total_a_pagar: totalCobrado,
                    metodo_pago: ventaOffline.metodo_pago
                }
            };
        } else {
            // Modo Normal (Online): Le preguntamos a Python
            const res = await apiFetch(`${obtenerBaseUrl()}/ventas/ticket/${ticketId}`);
            ticket = await res.json();
            if (ticket.error) return Swal.fire('Error', ticket.error, 'error');
        }

        // --- LÓGICA DE DEUDA PENDIENTE ---
        let bloqueDeuda = "";
        if (ticket.encabezado.cliente && ticket.encabezado.cliente !== 'Consumidor Final') {
            let saldoActual = 0;
            if (typeof clienteSeleccionadoId !== 'undefined' && typeof clientesGlobalesPOS !== 'undefined') {
                const clienteObj = clientesGlobalesPOS.find(c => c.id === clienteSeleccionadoId);
                if (clienteObj) saldoActual = clienteObj.saldo_actual_deudor;
            }

            if (saldoActual > 0) {
                bloqueDeuda = `
                    <div class="divisor"></div>
                    <div style="display: flex; justify-content: space-between; font-size: 11px;">
                        <span>SALDO PENDIENTE ANTERIOR:</span>
                        <span class="bold text-danger">$ ${saldoActual.toFixed(2)}</span>
                    </div>
                `;
            }
        }

        let html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Ticket ${ticket.encabezado.numero_ticket}</title>
                <style>
                    @page { margin: 0; }
                    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 600; color: #000; margin: 0; padding: 2mm 6mm 2mm 0mm; width: 76mm; box-sizing: border-box; -webkit-font-smoothing: none; text-rendering: crispEdges; }
                    .center { text-align: center; } .right { text-align: right; } .left { text-align: left; } .bold { font-weight: bold; }
                    .divisor { border-top: 1px dashed #000; margin: 4px 0; }
                    .divisor-doble { border-top: 2px solid #000; border-bottom: 2px solid #000; height: 2px; margin: 4px 0; }
                    table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 5px 0; table-layout: fixed; }
                    th, td { text-align: left; padding: 2px 1px; vertical-align: top; word-wrap: break-word; }
                </style>
            </head>
            <body>
                <div class="center bold" style="font-size: 16px; margin-bottom: 4px; border-bottom: 0.5px solid #000;">${config.nombre_negocio.toUpperCase()}</div>
                <div class="center bold" style="font-size: 11px; margin-bottom: 8px; border: 1px solid #000; padding: 2px;">DOCUMENTO NO VÁLIDO COMO FACTURA</div>
                <div class="center small" style="margin-bottom: 8px;">${config.direccion} | CUIT: ${config.cuit}</div>
                <div class="divisor-doble"></div>
                
                <div class="left">Ticket N°: ${ticket.encabezado.numero_ticket}</div>
                <div class="left">Fecha: ${ticket.encabezado.fecha}</div>
                <div class="left">Cajero: ${typeof empleadoLogueado !== 'undefined' && empleadoLogueado ? empleadoLogueado.nombre : 'Caja Principal'}</div>
                <div class="left">Cliente: ${ticket.encabezado.cliente || 'Consumidor Final'}</div>
                <div class="divisor-doble"></div>
                
                <table>
                    <tr><th style="width: 15%;">CANT</th><th style="width: 45%;">DESC</th><th class="right" style="width: 20%;">P.UNI</th><th class="right" style="width: 20%;">TOT</th></tr>
                    <tr><td colspan="4"><div class="divisor"></div></td></tr>
        `;

        ticket.detalle_compra.forEach(item => {
            let unidad = (item.unidad_medida || "un").toLowerCase().includes("kg") ? "Kg" : "un.";
            html += `
                <tr>
                    <td class="left">${item.cantidad} <span style="font-size: 10px;">${unidad}</span></td>
                    <td>${item.nombre}</td>
                    <td class="right">$${item.precio_unitario.toFixed(2)}</td>
                    <td class="right">$${item.subtotal.toFixed(2)}</td>
                </tr>
            `;
        });

        html += `
                    <tr><td colspan="4"><div class="divisor"></div></td></tr>
                </table>
                <div style="display: flex; justify-content: space-between;"><span>SUBTOTAL (${cantidadTotalArticulos} art.):</span><span>$ ${(ticket.totales.subtotal_articulos).toFixed(2)}</span></div>
        `;

        let ahorro = 0;
        if (ticket.totales.descuentos_o_recargos < 0) {
            let descGlobal = Math.abs(ticket.totales.descuentos_o_recargos);
            html += `<div style="display: flex; justify-content: space-between;"><span>DESC. MANUAL:</span><span>-$ ${descGlobal.toFixed(2)}</span></div>`;
        }

        html += `
                <div class="divisor"></div>
                <div style="display: flex; justify-content: space-between; font-size: 14px;" class="bold"><span>TOTAL A PAGAR:</span><span>$ ${ticket.totales.total_a_pagar.toFixed(2)}</span></div>
                <div class="divisor-doble"></div>
                <div class="left">Forma de Pago: ${ticket.totales.metodo_pago}</div>
        `;

        const abonoCon = pagoReal !== null ? pagoReal : ticket.totales.total_a_pagar;
        const vuelto = vueltoReal !== null ? vueltoReal : 0;

        html += `
                <div style="display: flex; justify-content: space-between;"><span>Abonó con:</span><span>$ ${abonoCon.toFixed(2)}</span></div>
                <div style="display: flex; justify-content: space-between;"><span>Vuelto:</span><span>$ ${vuelto.toFixed(2)}</span></div>
        `;

        if (ahorroReal > 0) html += `<div class="center bold" style="margin-top: 10px; font-size: 14px;">*** TU AHORRO HOY FUE: $ ${ahorroReal.toFixed(2)} ***</div>`;

        html += bloqueDeuda;

        html += `
                <div class="divisor-doble"></div>
                <div class="center bold" style="margin-top: 10px; font-size: 11px; white-space: pre-wrap;">${config.mensaje_ticket || '¡Gracias por su compra!'}</div>
                <div class="center bold" style="font-size: 9px; margin-top: 15px; border-top: 1px dashed #000; padding-top: 5px;">SISTEMA DE GESTIÓN ERP - 20 DE JUNIO</div>
                <div style="margin-bottom: 25mm;"></div> 
            </body>
            </html>
        `;

        if (typeof require !== 'undefined') {
            const { ipcRenderer } = require('electron');
            // Disparo silencioso por Electron
            ipcRenderer.send('imprimir-silencioso', html);
        } else {
            // Plan B: Por si estás en Google Chrome normal
            let ventanaPrint = window.open('', '_blank', 'width=300,height=500');
            ventanaPrint.document.write(html);
            ventanaPrint.document.close();
            ventanaPrint.focus();
            setTimeout(() => { ventanaPrint.print(); ventanaPrint.close(); }, 500);
        }

        // Limpiamos el mostrador para el siguiente cliente
        limpiarMostrador();

    } catch (e) {
        console.error(e);
        Swal.fire('Error', 'No se pudo generar el ticket para imprimir.', 'error');
    }
}

function imprimirRemitoFiado(cliente, total, articulos) {
    let fechaActual = `${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
    const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: "Mi Negocio", direccion: "Dirección", cuit: "00-00000000-0", mensaje_ticket: "¡Gracias por su compra!" };

    // Armamos un "molde" inteligente
    const generarCuerpo = (esCopia) => {
        let htmlCuerpo = `
                <div class="center bold" style="font-size: 16px; margin-bottom: 4px; border-bottom: 0.5px solid #ccc;">${config.nombre_negocio.toUpperCase()}</div>
                <div class="center small" style="margin-bottom: 0px;">${config.direccion} | CUIT: ${config.cuit}</div>
                
                <div class="center bold" style="font-size: 14px;">REMITO DE CTA. CTE.</div>
                ${esCopia ? '<div class="center bold" style="margin-top:4px; border: 1px solid #000; padding: 2px;">*** COPIA CLIENTE ***</div>' : '<div class="center bold" style="margin-top:0px; color: #fff;"></div>'}
                <div class="divisor"></div>
                <div class="left">Fecha: ${fechaActual}</div>
                <div class="left">Cajero: ${empleadoLogueado ? empleadoLogueado.nombre : 'Caja Principal'}</div>
                <div class="left">Cliente: ${cliente}</div>
                <div class="divisor"></div>
                <table>
                    <tr><th style="width:15%">CANT</th><th>DETALLE</th><th class="right">SUBT</th></tr>
                    <tr><td colspan="3"><div class="divisor"></div></td></tr>
            `;
        // Bucle de productos con la unidad (Kg / un.)
        articulos.forEach(p => {
            let precioF = p.precio_venta_final;
            if (p.cant_promo && p.cantidad >= p.cant_promo) precioF = p.precio_promo;

            let unidad = (p.unidad_medida || "un").toLowerCase().includes("kg") || p.tipo_venta === 'PESO' ? "Kg" : "un.";

            htmlCuerpo += `
                    <tr>
                        <td class="left">${p.cantidad} <span style="font-size:10px;">${unidad}</span></td>
                        <td class="left">${p.nombre}</td>
                        <td class="right">$${(precioF * p.cantidad).toFixed(2)}</td>
                    </tr>`;
        });

        // El Total y la Leyenda Legal
        htmlCuerpo += `
                <tr><td colspan="3"><div class="divisor"></div></td></tr>
                </table>
                <div style="font-size: 14px; display: flex; justify-content: space-between;" class="bold">
                    <span>CARGO A CTA:</span>
                    <span>$ ${total.toFixed(2)}</span>
                </div>
                
                <div style="border: 1px solid #000; padding: 4px; text-align: center; font-size: 10px; margin-top: 10px; font-weight: bold;">
                    NOTA: Los precios detallados son referenciales. El saldo total de la deuda será actualizado a los precios vigentes en caja al momento de su cancelación efectiva.
                </div>
            `;

        // La firma SOLO va en el original, no en la copia del cliente
        if (!esCopia) {
            htmlCuerpo += `
                    <br><br><br><br>
                    <div class="center divisor" style="width: 80%; margin: 0 auto;"></div>
                    <div class="center">Firma del Cliente</div>
                    <br><br>
                    <div class="center divisor" style="width: 80%; margin: 0 auto;"></div>
                    <div class="center small">Aclaración y DNI</div>
                `;
        }

        htmlCuerpo += `
                <div class="center bold" style="font-size: 11px; margin-top: 15px;">
                    ${config.mensaje_ticket || ''}
                </div>
                <div class="center" style="font-size: 9px; color: #555; margin-top: 15px; border-top: 0.5px solid #ccc; padding-top: 5px;"">
                    DESARROLLO DE SOFTWARE ERP - 20 DE JUNIO
                </div>
            `;
        return htmlCuerpo;
    };

    let html = `
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Remito Fiado</title>
        <style>
            @page { margin: 0; }
            body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 600; color: #000; margin: 0; padding: 2mm 4mm; width: 72mm; -webkit-font-smoothing: none; text-rendering: crispEdges; }
            .center { text-align: center; } .right { text-align: right; } .left { text-align: left; } .bold { font-weight: bold; }
            .divisor { border-top: 1px dashed #000; margin: 4px 0; }
            table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 5px 0; }
            th, td { text-align: left; padding: 2px 0; vertical-align: top; }
        </style>
        </head><body>
            ${generarCuerpo(false)}
            
            <div style="margin-top: 20px; margin-bottom: 20px; border-top: 2px dashed #000;"></div>
            
            ${generarCuerpo(true)}
            
            <div style="margin-bottom: 25mm;"></div>
        </body></html>
        `;

    let vent = window.open('', '_blank', 'width=300,height=500');
    vent.document.write(html); vent.document.close(); vent.focus();
    setTimeout(() => { vent.print(); vent.close(); }, 500);
}

// ===== CARGAR CATEGORÍAS RÁPIDAS DESDE PYTHON =====
async function cargarCategoriasRapidas() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/categorias_pos`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        const contenedor = document.getElementById('contenedorCategoriasRapidas');
        contenedor.innerHTML = '';

        data.categorias.forEach(cat => {
            // Le inyectamos el color oscuro a la letra y un formato más ajustado
            contenedor.innerHTML += `
                <button class="btn-cat shadow-sm" 
                        style="background-color: ${cat.color_fondo}; color: #1e293b !important; border: 1px solid rgba(0,0,0,0.1);" 
                        onclick="buscarProducto('${cat.palabra_clave}')">
                    <i class="bi ${cat.icono} fs-3"></i>
                    <span class="mt-1 fw-bold lh-1" style="font-size: 0.85rem;">${cat.nombre}</span>
                </button>
            `;
        });
    } catch (error) {
        console.error("Error cargando categorías POS:", error);
    }
}

// =========================================================
// MOTOR DE PAGO MÚLTIPLE (MIXTO)
// =========================================================
const modalPagoMixto = new bootstrap.Modal(document.getElementById('modalPagoMixto'));

function abrirPagoMixto() {
    if (carrito.length === 0) return Swal.fire('Error', 'El mostrador está vacío.', 'error');

    // Cargamos el total a cobrar
    document.getElementById('totalMixtoCobrar').innerText = `$${totalVenta.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;

    // Limpiamos las cajas
    document.getElementById('mixtoEfectivo').value = '';
    document.getElementById('mixtoTarjeta').value = '';
    document.getElementById('mixtoTransferencia').value = '';

    calcularMixto();
    modalPagoMixto.show();
    setTimeout(() => document.getElementById('mixtoEfectivo').focus(), 500);
}

function calcularMixto() {
    const ef = parseFloat(document.getElementById('mixtoEfectivo').value) || 0;
    const ta = parseFloat(document.getElementById('mixtoTarjeta').value) || 0;
    const tr = parseFloat(document.getElementById('mixtoTransferencia').value) || 0;

    const suma = ef + ta + tr;
    const diferencia = totalVenta - suma;

    const estadoTexto = document.getElementById('estadoMixtoTexto');
    const btnConfirmar = document.getElementById('btnConfirmarMixto');

    if (diferencia > 0.01) { // Le damos un margen de centavos por si acaso
        estadoTexto.innerText = `Falta cobrar: $${diferencia.toFixed(2)}`;
        estadoTexto.className = "mb-0 text-danger fw-bold";
        btnConfirmar.disabled = true;
    } else if (diferencia < -0.01) {
        // Si sobra plata, asumimos que el cajero le da vuelto en efectivo
        estadoTexto.innerText = `Vuelto a entregar: $${Math.abs(diferencia).toFixed(2)}`;
        estadoTexto.className = "mb-0 text-success fw-bold";
        btnConfirmar.disabled = false;
    } else {
        estadoTexto.innerText = `¡Monto exacto!`;
        estadoTexto.className = "mb-0 text-primary fw-bold";
        btnConfirmar.disabled = false;
    }
}

async function procesarPagoMixto() {
    const efOriginal = parseFloat(document.getElementById('mixtoEfectivo').value) || 0;
    const ta = parseFloat(document.getElementById('mixtoTarjeta').value) || 0;
    const tr = parseFloat(document.getElementById('mixtoTransferencia').value) || 0;

    const suma = efOriginal + ta + tr;
    if (suma < totalVenta) return Swal.fire('Falta dinero', 'La suma de los pagos no cubre el total de la venta.', 'warning');

    // Calculamos el vuelto (siempre sale del efectivo)
    const vuelto = suma > totalVenta ? (suma - totalVenta) : 0;
    const efectivoRealCaja = efOriginal - vuelto;

    // Creamos la lista para Python
    const desglosePagos = [];
    if (efectivoRealCaja > 0) desglosePagos.push({ metodo: "EFECTIVO", monto: efectivoRealCaja });
    if (ta > 0) desglosePagos.push({ metodo: "TARJETA", monto: ta });
    if (tr > 0) desglosePagos.push({ metodo: "TRANSFERENCIA", monto: tr });

    modalPagoMixto.hide();
    Swal.fire({ title: 'Procesando Venta Mixta...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    // Disparamos la venta mandando "MIXTO" como método
    const resultado = await procesarVentaBackend('MIXTO', suma, desglosePagos);

    if (resultado) {
        let msjHTML = `Venta dividida cobrada con éxito.<br><b>Entregar vuelto en Efectivo: $${vuelto.toFixed(2)}</b><br><br>Ticket N°: <b>${resultado.numero_ticket}</b><br><br><small class="text-muted">Presione <b>Enter</b> para Imprimir o <b>Esc</b> para Siguiente</small>`;
        const result = await Swal.fire({ title: '✅ Venta Exitosa', html: msjHTML, icon: 'success', showCancelButton: true, confirmButtonColor: '#198754', cancelButtonColor: '#6c757d', confirmButtonText: '<i class="bi bi-printer"></i> Imprimir (Enter)', cancelButtonText: 'Siguiente Cliente (Esc)' });

        if (result.isConfirmed) { imprimirTicket80mm(resultado.numero_ticket, suma, vuelto, resultado.ahorro_total); }
        limpiarMostrador();
    }
}

// --- COBRO DE PEDIDOS MAYORISTAS (CON SOPORTE MIXTO Y VUELTOS) ---
async function abrirCobroPedidoMayorista() {
    const { value: pedidoId } = await Swal.fire({
        title: 'Cobrar Pedido de Oficina',
        input: 'number',
        inputLabel: 'Ingrese el N° de Pedido',
        inputPlaceholder: 'Ej: 52',
        showCancelButton: true,
        confirmButtonText: '<i class="bi bi-search"></i> Buscar',
        cancelButtonText: 'Cancelar'
    });

    if (!pedidoId) return;

    try {
        Swal.fire({ title: 'Buscando en depósito...', didOpen: () => Swal.showLoading() });
        const res = await apiFetch(`${obtenerBaseUrl()}/deposito/pendiente/${pedidoId}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const { value: metodoPago } = await Swal.fire({
            title: `Pedido #${data.id}`,
            html: `
                <div class="text-muted mb-2">Cliente: <b>${data.cliente}</b></div>
                <div class="display-6 text-success fw-bold my-3">$${data.total_venta.toFixed(2)}</div>
            `,
            input: 'select',
            inputOptions: {
                'EFECTIVO': 'Efectivo Exacto',
                'TARJETA': 'Tarjeta (Débito/Crédito)',
                'TRANSFERENCIA': 'Transferencia Bancaria',
                'CTA_CTE': 'Fiado (Cuenta Corriente entera)',
                'MIXTO': '🧮 Pago Mixto / Calcular Vuelto' // <-- NUEVA ESTRELLA
            },
            inputPlaceholder: 'Seleccione Método de Pago',
            showCancelButton: true,
            confirmButtonText: 'Siguiente <i class="bi bi-arrow-right"></i>',
            confirmButtonColor: '#198754'
        });

        if (!metodoPago) return;

        let pagosMixtosData = [];
        let textoVuelto = '';

        // SI ELIGIÓ MIXTO, LE PEDIMOS EL DESGLOSE
        if (metodoPago === 'MIXTO') {
            const { value: resultadoMixto } = await Swal.fire({
                title: 'Dividir Pago',
                html: `
                    <div class="mb-3 text-start">
                        <label class="form-label fw-bold small text-success">Efectivo ($)</label>
                        <input id="mixEfe" type="number" class="form-control border-success" value="0" min="0" onfocus="this.select()">
                    </div>
                    <div class="mb-3 text-start">
                        <label class="form-label fw-bold small">Tarjeta ($)</label>
                        <input id="mixTar" type="number" class="form-control" value="0" min="0" onfocus="this.select()">
                    </div>
                    <div class="mb-3 text-start">
                        <label class="form-label fw-bold small">Transferencia ($)</label>
                        <input id="mixTra" type="number" class="form-control" value="0" min="0" onfocus="this.select()">
                    </div>
                    <div class="text-start mb-2">
                        <label class="form-label fw-bold small text-danger">Fiado / Cta Cte ($)</label>
                        <input id="mixCta" type="number" class="form-control border-danger" value="0" min="0" onfocus="this.select()">
                    </div>
                    <div class="mt-3 text-muted">Total a cubrir: <b class="fs-5">$${data.total_venta.toFixed(2)}</b></div>
                `,
                focusConfirm: false,
                showCancelButton: true,
                confirmButtonText: '<i class="bi bi-cash-coin"></i> Confirmar Pago',
                preConfirm: () => {
                    let efe = parseFloat(document.getElementById('mixEfe').value) || 0;
                    const tar = parseFloat(document.getElementById('mixTar').value) || 0;
                    const tra = parseFloat(document.getElementById('mixTra').value) || 0;
                    const cta = parseFloat(document.getElementById('mixCta').value) || 0;
                    const suma = efe + tar + tra + cta;

                    if (suma < data.total_venta) {
                        Swal.showValidationMessage(`Faltan $${(data.total_venta - suma).toFixed(2)} para cubrir el pedido.`);
                        return false;
                    }

                    let vuelto = 0;
                    if (suma > data.total_venta) {
                        vuelto = suma - data.total_venta;
                        efe = efe - vuelto; // El vuelto se descuenta de lo que entró en efectivo real a la caja
                        if (efe < 0) {
                            Swal.showValidationMessage(`Error: El vuelto a entregar supera el dinero físico entregado.`);
                            return false;
                        }
                    }

                    return {
                        pagos: [
                            { metodo: 'EFECTIVO', monto: efe },
                            { metodo: 'TARJETA', monto: tar },
                            { metodo: 'TRANSFERENCIA', monto: tra },
                            { metodo: 'CTA_CTE', monto: cta }
                        ],
                        vuelto: vuelto
                    };
                }
            });

            if (!resultadoMixto) return;

            pagosMixtosData = resultadoMixto.pagos.filter(p => p.monto > 0);
            if (resultadoMixto.vuelto > 0) {
                textoVuelto = `<br><br><span class="text-success fs-5"><b>Entregar Vuelto: $${resultadoMixto.vuelto.toFixed(2)}</b></span>`;
            }
        }

        // PROCEDEMOS A GUARDAR EN LA BASE DE DATOS
        Swal.fire({ title: 'Guardando en caja...', didOpen: () => Swal.showLoading() });

        const resCobro = await apiFetch(`${obtenerBaseUrl()}/caja/cobrar_pedido`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pedido_id: data.id,
                monto_total: data.total_venta,
                metodo_pago: metodoPago,
                pagos_mixtos: pagosMixtosData.length > 0 ? pagosMixtosData : null
            })
        });

        const dataCobro = await resCobro.json();

        if (!resCobro.ok) throw new Error('Error de conexión con el motor de caja.');
        if (dataCobro.error) throw new Error(dataCobro.error);

        Swal.fire({
            title: '¡Cobrado con Éxito!',
            html: `El pedido ya aparece en Logística para su entrega.${textoVuelto}`,
            icon: 'success'
        });

    } catch (e) {
        Swal.fire('Operación Cancelada', e.message, 'error');
    }
}

// =========================================================
// MOTOR NATIVO: LECTOR LÁSER GLOBAL
// =========================================================
let bufferCodigo = '';
let temporizadorLector = null;

document.addEventListener('keypress', (e) => {
    if (!cajaAbierta || document.querySelector('.modal.show') || Swal.isVisible()) return;
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

    if (e.key === 'Enter') {
        e.preventDefault(); // <-- EL ESCUDO: Evita que el Enter presione botones sueltos
        if (bufferCodigo.length > 3) {
            buscarProducto(bufferCodigo);
            bufferCodigo = '';
        }
        return;
    }

    bufferCodigo += e.key;

    clearTimeout(temporizadorLector);
    temporizadorLector = setTimeout(() => {
        bufferCodigo = '';
    }, 50);
});

// --- MOTOR OFFLINE-FIRST: EL CATÁLOGO LOCAL ---
async function descargarCatalogoParaOffline() {
    try {
        // Le pedimos al backend la lista completa de productos activos
        const response = await apiFetch(`${obtenerBaseUrl()}/productos/listar?estado=1`);

        if (response.ok) {
            const data = await response.json();
            // Guardamos el catálogo en la "mochila" del navegador
            localStorage.setItem('catalogo_productos_offline', JSON.stringify(data.productos));
            console.log(`✅ Catálogo Offline actualizado: ${data.productos.length} productos listos para cortes de luz.`);
        }
    } catch (error) {
        console.warn("No se pudo actualizar el catálogo offline. Se usará la última versión guardada.");
    }
}

// Disparadores:
// 1. Que se descargue apenas el cajero abre la pantalla de la caja
document.addEventListener("DOMContentLoaded", () => {
    descargarCatalogoParaOffline();
});

// 2. Que se actualice solo cada 10 minutos por si vos cambiaste algún precio desde la oficina
setInterval(descargarCatalogoParaOffline, 600000);

// =========================================================
// =========================================================
// MOTOR VISUAL: EL LATIDO (PING REAL A PYTHON)
// =========================================================
let pythonVivo = true;

function actualizarEstadoRedVisual(estaOnline) {
    // Agarramos los botones para desactivarlos por seguridad si se corta la red
    const btnCajaF10 = document.querySelector('[onclick="modalGestion.show()"]');
    const btnFiados = document.querySelector('[onclick="abrirModalCobroFiado()"]');
    const btnMayorista = document.querySelector('[onclick="abrirCobroPedidoMayorista()"]');

    // Agarramos el nuevo indicador sutil del HTML
    const indicador = document.getElementById('indicadorRed');
    if (!indicador) return;

    if (estaOnline) {
        indicador.className = 'd-flex align-items-center gap-1 text-success fw-bold small me-2';
        indicador.innerHTML = '<i class="bi bi-circle-fill punto-conexion latido-activo"></i> En línea';

        if (btnCajaF10) btnCajaF10.style.pointerEvents = 'auto', btnCajaF10.style.opacity = '1';
        if (btnFiados) btnFiados.style.pointerEvents = 'auto', btnFiados.style.opacity = '1';
        if (btnMayorista) btnMayorista.style.pointerEvents = 'auto', btnMayorista.style.opacity = '1';
    } else {
        indicador.className = 'd-flex align-items-center gap-1 text-danger fw-bold small me-2';
        indicador.innerHTML = '<i class="bi bi-circle-fill punto-conexion"></i> Desconectado';

        if (btnCajaF10) btnCajaF10.style.pointerEvents = 'none', btnCajaF10.style.opacity = '0.5';
        if (btnFiados) btnFiados.style.pointerEvents = 'none', btnFiados.style.opacity = '0.5';
        if (btnMayorista) btnMayorista.style.pointerEvents = 'none', btnMayorista.style.opacity = '0.5';
    }
}

// ==========================================
// MÓDULO: REGISTRO DE FALTANTES / PEDIDOS
// ==========================================
const modalFaltantes = new bootstrap.Modal(document.getElementById('modalFaltantes'));

function abrirModalFaltantes() {
    document.getElementById('inputFaltanteNombre').value = '';
    document.getElementById('inputFaltanteObs').value = '';
    modalFaltantes.show();
    setTimeout(() => document.getElementById('inputFaltanteNombre').focus(), 500);
}

async function guardarFaltante() {
    const nombre = document.getElementById('inputFaltanteNombre').value.trim();
    const obs = document.getElementById('inputFaltanteObs').value.trim();

    if (!nombre) return Swal.fire('Atención', 'Tenés que escribir el nombre del producto que falta.', 'warning');

    Swal.fire({ title: 'Anotando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        // Le pegamos a la ruta REAL que ya tenías programada
        const res = await apiFetch(`${obtenerBaseUrl()}/registrar_faltante`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                descripcion: nombre,
                cantidad: 1.0,
                notas: obs,
                usuario_nombre: empleadoLogueado ? empleadoLogueado.nombre : "Caja Principal" // <-- LE MANDAMOS EL NOMBRE
            })
        });

        if (!res.ok) throw new Error("No se pudo anotar el faltante.");

        modalFaltantes.hide();
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Anotado para pedir', showConfirmButton: false, timer: 1500 });

        // Devolvemos el foco al lector láser para no interrumpir el flujo de la caja
        setTimeout(() => document.getElementById('inputScan').focus(), 500);

    } catch (e) {
        // Plan B: Si se corta internet, lo anotamos en la libreta del navegador (Offline)
        let faltantesOffline = JSON.parse(localStorage.getItem('faltantes_offline')) || [];
        faltantesOffline.push({ nombre, obs, fecha: new Date().toISOString() });
        localStorage.setItem('faltantes_offline', JSON.stringify(faltantesOffline));

        modalFaltantes.hide();
        Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Guardado offline', showConfirmButton: false, timer: 1500 });
        setTimeout(() => document.getElementById('inputScan').focus(), 500);
    }
}

// El Latido: Toca la puerta de Python cada 3 segundos
setInterval(async () => {
    try {
        // Le hacemos un llamado cortito a la raíz del servidor
        const res = await apiFetch(`${obtenerBaseUrl()}/`, { method: 'GET', cache: 'no-store' });
        if (res.ok) {
            if (!pythonVivo) {
                pythonVivo = true;
                actualizarEstadoRedVisual(true);
                sincronizarVentasOffline(); // Volvió Python, mandamos los tickets atrapados
            }
        } else {
            throw new Error("Servidor caído");
        }
    } catch (error) {
        if (pythonVivo) {
            pythonVivo = false;
            actualizarEstadoRedVisual(false);
        }
    }
}, 3000);

document.addEventListener("DOMContentLoaded", () => actualizarEstadoRedVisual(true));