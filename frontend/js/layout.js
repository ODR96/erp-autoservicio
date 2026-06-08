// frontend/js/layout.js

// ========================================================
// PATOVICA GLOBAL: VERIFICACIÓN DE PERMISOS DE ADMINISTRACIÓN
// ========================================================
(function verificarPermisosGlobales() {
    // Leemos las llaves modernas del nuevo Login
    const token = localStorage.getItem('token');
    const rol = localStorage.getItem('usuario_rol') || localStorage.getItem('rol');
    
    // 1. Si no hay sesión, a la calle (al index)
    if (!token) {
        window.location.href = "index.html";
        return;
    }

    const rutaActual = window.location.pathname.toLowerCase();

    // 2. REGLA DE CAJERO: Cero administración
    if (rol === 'CAJERO' && rutaActual.includes('admin_')) {
        alert("ACCESO DENEGADO: Tu rol de CAJERO no te permite entrar a la administración.");
        window.location.href = "pos.html"; 
        return;
    }

    // 3. REGLA DE ENCARGADO: Puede entrar al depósito, pero no a la oficina del dueño
    if (rol === 'ENCARGADO') {
        const zonasProhibidas = [
            'admin_cajas.html', 
            'admin_cheques.html', 
            'admin_reportes.html', 
            'admin_config.html'
        ];
        
        if (zonasProhibidas.some(zona => rutaActual.includes(zona))) {
            alert("ACCESO RESTRINGIDO: Esta sección es exclusiva del Administrador (Dueño).");
            window.location.href = "admin_productos.html"; 
            return;
        }
    }
})();
// ========================================================

function inyectarLayout() {
    const nombre = localStorage.getItem('usuario_nombre') || 'Desconocido';
    const rol = localStorage.getItem('usuario_rol') || 'ADMIN';
    const esAdmin = rol === 'ADMIN';

    // LA MAGIA: Leemos el nombre del local
    const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: "Mi Negocio" };
    const nombreLocal = config.nombre_negocio;

    const sidebarHTML = `
        <div class="sidebar shadow d-print-none">
            <div class="sidebar-header">
                <i class="bi bi-shop display-4 text-warning"></i>
                <h5 class="mt-2 fw-bold mb-0">ERP Gestión</h5>
                <small class="text-warning">${nombreLocal}</small> </div>
            <div class="sidebar-menu">
                <a href="#" class="menu-item"><i class="bi bi-speedometer2"></i> Dashboard</a>
                <a href="pos.html" class="menu-item"><i class="bi bi-display"></i> Abrir POS (Caja)</a>
                <a href="admin_productos.html" class="menu-item"><i class="bi bi-box-seam"></i> Productos & Stock</a>
                <a href="admin_mayorista.html" class="menu-item"><i class="bi bi-truck"></i> Venta Depósito</a>
                
                ${esAdmin ? `<a href="admin_cajas.html" class="menu-item"><i class="bi bi-safe"></i> Cajas y Turnos</a>` : ''}
                ${esAdmin ? `<a href="#" class="menu-item"><i class="bi bi-receipt"></i> Cheques y Gastos</a>` : ''}
                
                <a href="admin_clientes.html" class="menu-item"><i class="bi bi-people"></i> Clientes (Cta Cte)</a>
                <a href="admin_proveedores.html" class="menu-item"><i class="bi bi-building"></i> Proveedores</a>
                
                ${esAdmin ? `<a href="#" class="menu-item"><i class="bi bi-bar-chart"></i> Reportes</a>` : ''}
                ${esAdmin ? `<a href="admin_config.html" class="menu-item"><i class="bi bi-gear"></i> Configuración</a>` : ''}
            </div>
        </div>
    `;

    // 3. EL CÓDIGO DE TU NAVBAR (Con Menú Desplegable para Cerrar Sesión)
    const navbarHTML = `
        <div class="top-navbar d-print-none">
            <div><span class="text-muted fw-bold d-none d-md-inline">Módulo de Inventario (Autoservicio)</span></div>
            
            <div class="d-flex align-items-center gap-3">
                <div id="cajaDolar" class="d-none d-md-flex align-items-center gap-2 px-3 py-1 bg-light border rounded-pill text-success fw-bold small">
                    <i class="bi bi-currency-dollar"></i> Cargando...
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
    `;

    // 4. REEMPLAZO QUIRÚRGICO
    const sidePlaceholder = document.getElementById('layout-sidebar-placeholder');
    if (sidePlaceholder) sidePlaceholder.outerHTML = sidebarHTML;

    const navPlaceholder = document.getElementById('layout-navbar-placeholder');
    if (navPlaceholder) navPlaceholder.outerHTML = navbarHTML;

    // 5. DETECTOR AUTOMÁTICO DE PÁGINA
    const urlActual = window.location.pathname;
    document.querySelectorAll('.sidebar-menu .menu-item').forEach(link => {
        const href = link.getAttribute('href');
        if (href !== '#' && urlActual.includes(href)) {
            link.classList.add('active');
        }
    });
}

function toggleMenu() {
    document.getElementById('sidebarMenu').classList.toggle('mostrar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if(backdrop) backdrop.classList.toggle('mostrar');
}

async function cargarDolar() {
    try {
        const respuesta = await fetch('https://dolarapi.com/v1/dolares/blue');
        const datos = await respuesta.json();
        const caja = document.getElementById('cajaDolar');
        if(caja) caja.innerHTML = `<i class="bi bi-currency-dollar text-success"></i> Blue: C $${datos.compra} | V $${datos.venta}`;
    } catch (error) {
        console.log("No se pudo cargar el dólar. Sin internet.");
    }
}

function cerrarSesionGlobal() {
    localStorage.clear();
    window.location.href = 'index.html';
}

// Para que el botón hamburguesa aparezca solo en celulares
const style = document.createElement('style');
style.innerHTML = `@media (max-width: 768px) { .btn-hamburguesa { display: block !important; } .titulo-modulo-desktop, .cotizacion-dolar { display: none !important; } .sidebar { position: fixed; left: -260px; top: 0; height: 100vh; z-index: 1050; transition: left 0.3s; } .sidebar.mostrar { left: 0; } .sidebar-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 1040; } .sidebar-backdrop.mostrar { display: block; } }`;
document.head.appendChild(style);

document.addEventListener("DOMContentLoaded", () => {
    inyectarLayout();
    cargarDolar();
});