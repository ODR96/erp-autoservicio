// ========================================================
// CONFIGURACIÓN GLOBAL
// ========================================================
const APP_VERSION = "v1.0.36"; // Modificá este número antes de cada compilación (y el ?v= de los <script> en los .html)

function obtenerBaseUrl() {
    const protocolo = window.location.protocol;
    const host = window.location.hostname;
    const puerto = window.location.port;

    if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://localhost:8000';
    }

    // Electron (file://): el instalador 1.0.36 sigue :8000. Nginx :80 es el admin en browser.
    if (protocolo === 'file:' || !host) {
        return 'http://185.249.225.63:8000';
    }

    // Hoy el admin se abre en :8000. No romper el git pull antes de levantar Nginx.
    if (puerto === '8000') {
        return `${protocolo}//${host}:8000`;
    }

    // Puerto 80/443 o vacío: mismo origen (Nginx → uvicorn).
    const extra = (puerto && puerto !== '80' && puerto !== '443') ? `:${puerto}` : '';
    return `${protocolo}//${host}${extra}`;
}

function leerConfigNegocio() {
    try {
        return JSON.parse(localStorage.getItem('config_negocio') || '{}') || {};
    } catch (e) {
        return {};
    }
}

function nombreNegocio() {
    const n = String(leerConfigNegocio().nombre_negocio || '').trim();
    return n || 'ERPetto';
}

function urlLogoNegocio() {
    const ruta = leerConfigNegocio().ruta_logo || '';
    if (!ruta) return '';
    const s = String(ruta);
    if (s.startsWith('data:image') || s.startsWith('http://') || s.startsWith('https://')) return s;
    return `${obtenerBaseUrl()}/static/logos/${s}`;
}

// ========================================================
// VERIFICACIÓN VISUAL DE PERMISOS (Protección UX)
// ========================================================
(function verificarPermisosGlobales() {
    const token = localStorage.getItem('token') || localStorage.getItem('token_pos');
    const rol = localStorage.getItem('usuario_rol');

    if (!token) {
        window.location.href = "index.html";
        return;
    }

    const rutaActual = window.location.pathname.toLowerCase();

    if (rol === 'CAJERO' && rutaActual.includes('admin_')) {
        alert("ACCESO DENEGADO: Tu rol de CAJERO no te permite entrar a la administración.");
        window.location.href = "pos.html";
        return;
    }

    if (rol === 'ENCARGADO') {
        const zonasProhibidas = ['admin_cajas.html', 'admin_cheques.html', 'admin_reportes.html', 'admin_config.html', 'admin_rrhh.html', 'admin_dashboard.html', 'admin_gastos.html'];
        if (zonasProhibidas.some(zona => rutaActual.includes(zona))) {
            alert("ACCESO RESTRINGIDO: Esta sección es exclusiva del Administrador.");
            window.location.href = "admin_productos.html";
            return;
        }
    }
})();

function inyectarLayout() {
    const nombre = localStorage.getItem('usuario_nombre') || 'Desconocido';
    const rol = localStorage.getItem('usuario_rol') || 'ADMIN';
    const esAdmin = rol === 'ADMIN';

    const nombreLocal = nombreNegocio();

    // Se agrega flexbox (d-flex flex-column) para mandar el footer al fondo
    const sidebarHTML = `
        <div id="sidebarMenu" class="sidebar shadow d-print-none d-flex flex-column" style="height: 100vh;">
            <div class="sidebar-header">
                <i class="bi bi-shop display-4 text-warning"></i>
                <h5 class="mt-2 fw-bold mb-0">ERP Gestión</h5>
                <small class="text-warning">${nombreLocal}</small> 
            </div>
            
            <div class="sidebar-menu flex-grow-1" style="overflow-y: auto;">
                ${esAdmin ? `<a href="admin_dashboard.html" class="menu-item"><i class="bi bi-speedometer2"></i> Dashboard</a>` : ''}
                <a href="pos.html" class="menu-item"><i class="bi bi-display"></i> Abrir POS (Caja)</a>
                <a href="admin_productos.html" class="menu-item"><i class="bi bi-box-seam"></i> Productos & Stock</a>
                <a href="admin_inventario.html" class="menu-item"><i class="bi bi-clipboard-check"></i> Inventario</a>
                <a href="admin_carteleria.html" class="menu-item"><i class="bi bi-megaphone"></i> Cartelería</a>
                <a href="admin_mayorista.html" class="menu-item"><i class="bi bi-truck"></i> Venta Depósito</a>
                
                ${esAdmin ? `<a href="admin_cajas.html" class="menu-item"><i class="bi bi-safe"></i> Cajas y Turnos</a>` : ''}
                ${esAdmin ? `<a href="admin_gastos.html" class="menu-item"><i class="bi bi-receipt"></i> Cheques y Gastos</a>` : ''}
                ${esAdmin ? `<a href="admin_rrhh.html" class="menu-item"><i class="bi bi-person-badge"></i> RRHH: Sueldos</a>` : ''}
                
                <a href="admin_clientes.html" class="menu-item"><i class="bi bi-people"></i> Clientes (Cta Cte)</a>
                <a href="admin_proveedores.html" class="menu-item"><i class="bi bi-building"></i> Proveedores</a>
                
                ${esAdmin ? `<a href="admin_reportes.html" class="menu-item"><i class="bi bi-bar-chart"></i> Reportes</a>` : ''}
                ${esAdmin ? `<a href="admin_config.html" class="menu-item"><i class="bi bi-gear"></i> Configuración</a>` : ''}
            </div>

            <!-- FOOTER DE VERSIÓN -->
            <div class="sidebar-footer mt-auto py-3 text-center" style="background-color: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.05);">
                <div class="text-secondary small fw-bold" style="letter-spacing: 1px;">ERP | ODR Systems</div>
                <div class="badge bg-secondary text-light mt-1"><i class="bi bi-git me-1"></i> ${APP_VERSION}</div>
            </div>
        </div>
    `;

    const navbarHTML = `
        <div class="top-navbar d-print-none">
            <button type="button" class="btn-hamburguesa" onclick="toggleMenu()" title="Abrir Menú" aria-label="Abrir menú">
                <i class="bi bi-list"></i>
            </button>
            
            <div><span class="text-muted fw-bold d-none d-md-inline">Módulo de Inventario (Autoservicio)</span></div>
            
            <div class="d-flex align-items-center gap-3">
                <div id="cajaDolar" class="d-none d-md-flex align-items-center gap-2 px-3 py-1 bg-light border rounded-pill text-success fw-bold small">
                    <span class="spinner-border spinner-border-sm text-success" role="status"></span>
                </div>
                <button class="btn btn-light position-relative p-1 border shadow-sm rounded-circle d-flex justify-content-center align-items-center" style="width: 44px; height: 44px;">
                    <i class="bi bi-bell text-secondary"></i>
                    <span class="position-absolute top-0 start-100 translate-middle p-1 bg-danger border border-light rounded-circle"></span>
                </button>
                <div class="dropdown">
                    <div class="d-flex align-items-center gap-2 border-start ps-3" data-bs-toggle="dropdown" style="cursor: pointer; min-height: 44px;" title="Opciones de cuenta">
                        <div class="text-end lh-1 navbar-user-nombre">
                            <strong class="d-block text-dark">${nombre}</strong>
                            <small class="text-muted">${rol}</small>
                        </div>
                        <i class="bi bi-person-circle fs-3 text-secondary"></i>
                    </div>
                    <ul class="dropdown-menu dropdown-menu-end shadow-sm border-0 mt-2">
                        <li><h6 class="dropdown-header">Sesión actual</h6></li>
                        <li><a class="dropdown-item text-danger fw-bold py-2" href="#" onclick="cerrarSesionGlobal()"><i class="bi bi-box-arrow-right me-2"></i> Cerrar Sesión</a></li>
                    </ul>
                </div>
            </div>
        </div>
        <div id="sidebarBackdrop" class="sidebar-backdrop" onclick="toggleMenu()"></div>
    `;

    const sidePlaceholder = document.getElementById('layout-sidebar-placeholder');
    if (sidePlaceholder) sidePlaceholder.outerHTML = sidebarHTML;

    const navPlaceholder = document.getElementById('layout-navbar-placeholder');
    if (navPlaceholder) navPlaceholder.outerHTML = navbarHTML;

    const urlActual = window.location.pathname;
    document.querySelectorAll('.sidebar-menu .menu-item').forEach(link => {
        const href = link.getAttribute('href');
        if (href !== '#' && urlActual.includes(href)) link.classList.add('active');
        link.addEventListener('click', () => {
            const sidebar = document.getElementById('sidebarMenu');
            if (sidebar && sidebar.classList.contains('mostrar')) toggleMenu();
        });
    });
}

function toggleMenu() {
    document.getElementById('sidebarMenu').classList.toggle('mostrar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (backdrop) backdrop.classList.toggle('mostrar');
}

async function cargarDolar() {
    const caja = document.getElementById('cajaDolar');
    try {
        const respuesta = await fetch('https://dolarapi.com/v1/dolares/blue');
        if (!respuesta.ok) throw new Error("API caída");
        const datos = await respuesta.json();
        if (caja) caja.innerHTML = `<i class="bi bi-currency-dollar text-success"></i> Blue: C $${datos.compra} | V $${datos.venta}`;
    } catch (error) {
        if (caja) {
            caja.classList.replace('text-success', 'text-muted');
            caja.innerHTML = `<i class="bi bi-wifi-off"></i> Dólar offline`;
        }
    }
}


function cerrarSesionGlobal() {
    localStorage.clear();
    window.location.href = 'index.html';
}

const styleLayoutMovil = document.createElement('style');
styleLayoutMovil.innerHTML = `
.btn-hamburguesa { display: none; background: transparent; border: none; font-size: 1.5rem; color: #1b365d; cursor: pointer; min-width: 44px; min-height: 44px; }
@media (max-width: 767.98px) {
    .btn-hamburguesa { display: flex !important; align-items: center; justify-content: center; }
    .titulo-modulo-desktop, .cotizacion-dolar, .navbar-user-nombre { display: none !important; }
    .sidebar { position: fixed; left: -260px; top: 0; height: 100vh; z-index: 1050; transition: left 0.3s; }
    .sidebar.mostrar { left: 0; }
    .sidebar-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 1040; }
    .sidebar-backdrop.mostrar { display: block; }
}`;
document.head.appendChild(styleLayoutMovil);

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const sidebar = document.getElementById('sidebarMenu');
    if (sidebar && sidebar.classList.contains('mostrar')) toggleMenu();
});

document.addEventListener("DOMContentLoaded", () => {
    inyectarLayout();
    cargarDolar();
});

let ultimoReciboPagoCtaCte = null;

function plataTicket(n) {
    return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escaparHtmlTicket(texto) {
    return String(texto || '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function imprimirHtmlTermico(html) {
    try {
        if (typeof require !== 'undefined') {
            require('electron').ipcRenderer.send('imprimir-silencioso', html);
            return;
        }
    } catch (e) { /* Chrome u otro navegador */ }
    const vent = window.open('', '_blank', 'width=300,height=560');
    if (!vent) return;
    vent.document.write(html);
    vent.document.close();
    vent.focus();
    setTimeout(() => { vent.print(); vent.close(); }, 400);
}

function formatearFechaTicket(valor) {
    if (!valor) {
        return `${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
    }
    const s = String(valor).replace('T', ' ');
    const partes = s.slice(0, 10).split('-');
    const hora = s.length >= 16 ? s.slice(11, 16) : '';
    if (partes.length === 3 && partes[0].length === 4) {
        return `${partes[2]}/${partes[1]}/${partes[0]}${hora ? ' ' + hora : ''}`;
    }
    return s;
}

function htmlReciboPagoCtaCte(datos) {
    const cfg = leerConfigNegocio();
    const negocio = String(cfg.nombre_negocio || '').trim();
    const direccion = String(cfg.direccion || '').trim();
    const cuit = String(cfg.cuit || '').trim();
    const pie = String(cfg.mensaje_ticket || '').trim();
    const fecha = formatearFechaTicket(datos.fecha);
    const monto = Number(datos.monto) || 0;
    const saldo = Number(datos.saldo) || 0;
    const vencido = Number(datos.vencido) || 0;
    const abierto = Number(datos.abierto) || 0;
    const alDia = saldo <= 0;
    const saldoTxt = saldo < 0 ? `A FAVOR $ ${plataTicket(Math.abs(saldo))}` : `$ ${plataTicket(saldo)}`;
    const lineaLocal = [direccion, cuit ? `CUIT ${cuit}` : ''].filter(Boolean).join(' | ');
    const ticksImp = ticketsImputacionDe(datos.aplicaciones);
    const lineaTickets = ticksImp.length
        ? `<div class="center" style="font-size: 10px;">Imputado a ${ticksImp.map((n) => '#' + n).join(', ')}</div>`
        : '';
    const encabezado = [
        negocio ? `<div class="center bold" style="font-size: 14px; margin-bottom: 2px;">${escaparHtmlTicket(negocio.toUpperCase())}</div>` : '',
        lineaLocal ? `<div class="center" style="font-size: 10px; margin-bottom: 4px;">${escaparHtmlTicket(lineaLocal)}</div>` : ''
    ].join('');
    const bloqueSaldo = alDia
        ? `<div class="center bold" style="font-size: 13px; border: 1px solid #000; padding: 4px 2px; margin: 6px 0;">CUENTA AL DÍA</div>
        ${saldo < 0 ? `<div class="center bold">SALDO A FAVOR $ ${plataTicket(Math.abs(saldo))}</div>` : ''}`
        : `<div class="center bold" style="font-size: 10px; margin: 4px 0;">${escaparHtmlTicket(datos.tituloSaldo || 'SALDO LUEGO DE ESTE COBRO')}</div>
        <table>
            <tr><td class="k">Vencido</td><td class="v">$ ${plataTicket(vencido)}</td></tr>
            <tr><td class="k">Período</td><td class="v">$ ${plataTicket(abierto)}</td></tr>
            <tr><td class="k bold">TOTAL</td><td class="v bold">${saldoTxt}</td></tr>
        </table>`;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Recibo de Pago</title>
    <style>
        @page { size: 80mm auto; margin: 0; }
        html, body { width: 76mm; max-width: 76mm; }
        body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 600; color: #000; margin: 0; padding: 2mm 6mm 2mm 0; box-sizing: border-box; -webkit-font-smoothing: none; text-rendering: crispEdges; }
        .center { text-align: center; } .bold { font-weight: bold; }
        .divisor { border-top: 1px dashed #000; margin: 4px 0; }
        .divisor-doble { border-top: 2px solid #000; border-bottom: 2px solid #000; height: 2px; margin: 4px 0; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        td { vertical-align: top; padding: 1px 0; word-wrap: break-word; overflow-wrap: anywhere; }
        td.k { width: 36%; text-align: left; }
        td.v { width: 64%; text-align: right; }
        .monto { font-size: 16px; text-align: center; border: 1px solid #000; padding: 4px 2px; margin: 4px 0; box-sizing: border-box; }
    </style></head><body>
        ${encabezado}
        <div class="center bold" style="font-size: 13px;">${alDia ? 'LIBRE DE DEUDA' : 'RECIBO DE PAGO'}</div>
        <div class="center" style="font-size: 10px;">Cuenta corriente</div>
        <div class="divisor-doble"></div>
        <table>
            <tr><td class="k">Fecha</td><td class="v">${escaparHtmlTicket(fecha)}</td></tr>
            <tr><td class="k">Cliente</td><td class="v">${escaparHtmlTicket(datos.cliente)}</td></tr>
        </table>
        <div class="divisor-doble"></div>
        <div class="center bold" style="font-size: 11px;">IMPORTE ABONADO</div>
        <div class="monto bold">$ ${plataTicket(monto)}</div>
        ${lineaTickets}
        <div class="divisor"></div>
        <table>
            <tr><td class="k">Medio</td><td class="v">${escaparHtmlTicket(datos.metodo)}</td></tr>
        </table>
        <div class="divisor"></div>
        ${bloqueSaldo}
        ${pie ? `<div class="center" style="font-size: 10px; margin-top: 10px; white-space: pre-wrap;">${escaparHtmlTicket(pie)}</div>` : ''}
        <div class="center" style="font-size: 9px; margin-top: 8px;">Comprobante no válido como factura.</div>
        <div style="margin-bottom: 20mm;"></div>
    </body></html>`;
}

function ticketsImputacionDe(aplicaciones) {
    return [...new Set((aplicaciones || []).map((a) => a && a.ticket).filter(Boolean))];
}

function htmlLineaImputacionFiado(aplicaciones) {
    const t = ticketsImputacionDe(aplicaciones);
    if (!t.length) return '';
    return `<div class="small text-muted">Imputado a ticket ${t.map((n) => '#' + n).join(', ')}</div>`;
}

function imprimirReciboPagoCtaCte(datos) {
    if (!datos) return;
    ultimoReciboPagoCtaCte = datos;
    imprimirHtmlTermico(htmlReciboPagoCtaCte(datos));
}

async function preguntarImprimirReciboPagoCtaCte(datos) {
    ultimoReciboPagoCtaCte = datos;
    const saldo = Number(datos.saldo) || 0;
    const alDia = saldo <= 0;
    const r = await Swal.fire({
        title: alDia ? 'Cuenta al día' : 'Imprimir recibo',
        html: `<div class="text-start small">Abonó <b>$ ${plataTicket(datos.monto)}</b> (${escaparHtmlTicket(datos.metodo)})<br>
            ${alDia ? '<b>No debe nada.</b>' : `Vencido $ ${plataTicket(datos.vencido)} · Período $ ${plataTicket(datos.abierto)}<br>Saldo: <b>$ ${plataTicket(saldo)}</b>`}
            ${htmlLineaImputacionFiado(datos.aplicaciones)}</div>`,
        icon: 'success',
        showCancelButton: true,
        confirmButtonText: '<i class="bi bi-printer"></i> Ticketera',
        cancelButtonText: 'No imprimir',
        confirmButtonColor: '#198754',
        reverseButtons: true
    });
    if (r.isConfirmed) imprimirReciboPagoCtaCte(datos);
}

async function imprimirReciboPagoPorMovimiento(movimientoId, opciones) {
    const id = parseInt(movimientoId, 10);
    const preguntar = !opciones || opciones.preguntar !== false;
    if (!id) return Swal.fire('Atención', 'Ese cobro no se puede reimprimir.', 'info');
    Swal.fire({ title: 'Armando recibo...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const token = localStorage.getItem('token') || localStorage.getItem('token_pos');
        const res = await fetch(`${obtenerBaseUrl()}/clientes/recibo_pago/${id}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const data = await res.json();
        if (!res.ok || data.error || data.detail) {
            throw new Error(data.error || data.detail || 'No se pudo armar el recibo.');
        }
        Swal.close();
        const datos = {
            clienteId: data.cliente_id,
            cliente: data.nombre,
            monto: data.monto,
            metodo: data.metodo,
            saldo: data.saldo,
            vencido: data.vencido,
            abierto: data.abierto,
            fecha: data.fecha,
            tituloSaldo: 'SALDO LUEGO DE ESTE COBRO',
            aplicaciones: data.aplicaciones || []
        };
        if (preguntar) {
            ultimoReciboPagoCtaCte = datos;
            const saldo = Number(datos.saldo) || 0;
            const alDia = saldo <= 0;
            const r = await Swal.fire({
                title: alDia ? 'Reimprimir · cuenta al día' : 'Reimprimir recibo',
                html: `<div class="text-start small">Abonó <b>$ ${plataTicket(datos.monto)}</b> (${escaparHtmlTicket(datos.metodo)})<br>
                    ${alDia ? '<b>Quedó al día en ese cobro.</b>' : `Saldo luego del cobro: <b>$ ${plataTicket(saldo)}</b>`}
                    ${htmlLineaImputacionFiado(datos.aplicaciones)}</div>`,
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: '<i class="bi bi-printer"></i> Ticketera',
                cancelButtonText: 'Cancelar',
                confirmButtonColor: '#198754',
                reverseButtons: true
            });
            if (r.isConfirmed) imprimirReciboPagoCtaCte(datos);
            return;
        }
        imprimirReciboPagoCtaCte(datos);
    } catch (e) {
        Swal.fire('Error', e.message || 'No se pudo armar el recibo.', 'error');
    }
}

if (typeof require !== 'undefined') {
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('actualizacion-lista', () => {
        Swal.fire({
            title: '¡Actualización Disponible!',
            text: 'Hay una nueva versión del sistema lista. Se aplicarán mejoras de velocidad y diseño. ¿Desea reiniciar el sistema ahora?',
            icon: 'info',
            showCancelButton: true,
            confirmButtonColor: '#198754',
            cancelButtonColor: '#6c757d',
            confirmButtonText: '<i class="bi bi-arrow-clockwise"></i> Reiniciar y Actualizar',
            cancelButtonText: 'Más tarde'
        }).then((result) => {
            if (result.isConfirmed) ipcRenderer.send('reiniciar-y-actualizar');
        });
    });
}