// ========================================================
// CONFIGURACIÓN GLOBAL
// ========================================================
const APP_VERSION = "v1.0.26"; // Modificá este número antes de cada compilación

function obtenerBaseUrl() {
    const dominio = window.location.hostname;
    if (dominio === 'localhost' || dominio === '127.0.0.1') {
        return 'http://localhost:8000';
    }
    return 'http://185.249.225.63:8000';
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
        const zonasProhibidas = ['admin_cajas.html', 'admin_cheques.html', 'admin_reportes.html', 'admin_config.html'];
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

    const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: "Autoservicio 20 de Junio" };
    const nombreLocal = config.nombre_negocio;

    // Se agrega flexbox (d-flex flex-column) para mandar el footer al fondo
    const sidebarHTML = `
        <div id="sidebarMenu" class="sidebar shadow d-print-none d-flex flex-column" style="height: 100vh;">
            <div class="sidebar-header">
                <i class="bi bi-shop display-4 text-warning"></i>
                <h5 class="mt-2 fw-bold mb-0">ERP Gestión</h5>
                <small class="text-warning">${nombreLocal}</small> 
            </div>
            
            <div class="sidebar-menu flex-grow-1" style="overflow-y: auto;">
                <a href="admin_dashboard.html" class="menu-item"><i class="bi bi-speedometer2"></i> Dashboard</a>
                <a href="pos.html" class="menu-item"><i class="bi bi-display"></i> Abrir POS (Caja)</a>
                <a href="admin_productos.html" class="menu-item"><i class="bi bi-box-seam"></i> Productos & Stock</a>
                <a href="admin_carteleria.html" class="menu-item"><i class="bi bi-megaphone"></i> Cartelería</a>
                <a href="admin_mayorista.html" class="menu-item"><i class="bi bi-truck"></i> Venta Depósito</a>
                
                ${esAdmin ? `<a href="admin_cajas.html" class="menu-item"><i class="bi bi-safe"></i> Cajas y Turnos</a>` : ''}
                ${esAdmin ? `<a href="admin_gastos.html" class="menu-item"><i class="bi bi-receipt"></i> Cheques y Gastos</a>` : ''}
                
                <a href="admin_clientes.html" class="menu-item"><i class="bi bi-people"></i> Clientes (Cta Cte)</a>
                <a href="admin_proveedores.html" class="menu-item"><i class="bi bi-building"></i> Proveedores</a>
                
                ${esAdmin ? `<a href="#" class="menu-item"><i class="bi bi-bar-chart"></i> Reportes</a>` : ''}
                ${esAdmin ? `<a href="admin_config.html" class="menu-item"><i class="bi bi-gear"></i> Configuración</a>` : ''}
            </div>

            <!-- FOOTER DE VERSIÓN -->
            <div class="sidebar-footer mt-auto py-3 text-center" style="background-color: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.05);">
                <div class="text-secondary small fw-bold" style="letter-spacing: 1px;">ERPetto | ODR Systems</div>
                <div class="badge bg-secondary text-light mt-1"><i class="bi bi-git me-1"></i> ${APP_VERSION}</div>
            </div>
        </div>
    `;

    const navbarHTML = `
        <div class="top-navbar d-print-none">
            <button class="btn-hamburguesa d-md-none me-3" onclick="toggleMenu()" title="Abrir Menú">
                <i class="bi bi-list"></i>
            </button>
            
            <div><span class="text-muted fw-bold d-none d-md-inline">Módulo de Inventario (Autoservicio)</span></div>
            
            <div class="d-flex align-items-center gap-3">
                <div id="cajaDolar" class="d-none d-md-flex align-items-center gap-2 px-3 py-1 bg-light border rounded-pill text-success fw-bold small">
                    <span class="spinner-border spinner-border-sm text-success" role="status"></span>
                </div>
                <button class="btn btn-light position-relative p-1 border shadow-sm rounded-circle d-flex justify-content-center align-items-center" style="width: 35px; height: 35px;">
                    <i class="bi bi-bell text-secondary"></i>
                    <span class="position-absolute top-0 start-100 translate-middle p-1 bg-danger border border-light rounded-circle"></span>
                </button>
                <div class="dropdown">
                    <div class="d-flex align-items-center gap-2 border-start ps-3" data-bs-toggle="dropdown" style="cursor: pointer;" title="Opciones de cuenta">
                        <div class="text-end lh-1">
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

const style = document.createElement('style');
style.innerHTML = `@media (max-width: 768px) { .btn-hamburguesa { display: block !important; } .titulo-modulo-desktop, .cotizacion-dolar { display: none !important; } .sidebar { position: fixed; left: -260px; top: 0; height: 100vh; z-index: 1050; transition: left 0.3s; } .sidebar.mostrar { left: 0; } .sidebar-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 1040; } .sidebar-backdrop.mostrar { display: block; } }`;
document.head.appendChild(style);

document.addEventListener("DOMContentLoaded", () => {
    inyectarLayout();
    cargarDolar();
});

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