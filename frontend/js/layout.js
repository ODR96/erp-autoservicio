function obtenerBaseUrl() {
    const protocolo = window.location.protocol;
    const dominio = window.location.hostname;

    // Si estás en la compu programando/probando localmente:
    if (dominio === 'localhost' || dominio === '127.0.0.1') {
        return 'http://localhost:8000'; 
    }
    
    // Si la app corre en el mostrador (Electron usa 'file:') o desde la web remota:
    // Apunta directo a tu Contabo para tener tiempo real absoluto
    return 'http://185.249.225.63:8000';
}

// ========================================================
// PATOVICA GLOBAL: VERIFICACIÓN DE PERMISOS DE ADMINISTRACIÓN
// ========================================================
(function verificarPermisosGlobales() {
    const token = localStorage.getItem('token');
    const rol = localStorage.getItem('usuario_rol') || localStorage.getItem('rol');
    
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

    const config = JSON.parse(localStorage.getItem('config_negocio')) || { nombre_negocio: "Mi Negocio" };
    const nombreLocal = config.nombre_negocio;

    const sidebarHTML = `
        <div id="sidebarMenu" class="sidebar shadow d-print-none">
            <div class="sidebar-header">
                <i class="bi bi-shop display-4 text-warning"></i>
                <h5 class="mt-2 fw-bold mb-0">ERP Gestión</h5>
                <small class="text-warning">${nombreLocal}</small> 
            </div>
            <div class="sidebar-menu">
                <a href="admin_dashboard.html" class="menu-item"><i class="bi bi-speedometer2"></i> Dashboard</a>
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

    // --- NUEVO: BOTÓN DE SINCRONIZACIÓN (Solo Admin) ---
    const botonSyncHTML = esAdmin ? `
        <button id="btnSyncNube" onclick="forzarSincronizacion()" class="btn btn-outline-primary btn-sm rounded-pill px-3 d-flex align-items-center gap-2 fw-bold shadow-sm" title="Subir datos a la Nube">
            <i class="bi bi-cloud-arrow-up-fill fs-6"></i> 
            <span class="d-none d-md-inline">Sincronizar</span>
        </button>
    ` : '';

const navbarHTML = `
        <div class="top-navbar d-print-none">
            <!-- BOTÓN HAMBURGUESA QUE HABÍA DESAPARECIDO -->
            <button class="btn-hamburguesa d-md-none me-3" onclick="toggleMenu()" title="Abrir Menú">
                <i class="bi bi-list"></i>
            </button>
            
            <div><span class="text-muted fw-bold d-none d-md-inline">Módulo de Inventario (Autoservicio)</span></div>
            
            <div class="d-flex align-items-center gap-3">
                ${botonSyncHTML}
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
        <!-- FONDO NEGRO PARA EL CELULAR -->
        <div id="sidebarBackdrop" class="sidebar-backdrop" onclick="toggleMenu()"></div>
    `;

    const sidePlaceholder = document.getElementById('layout-sidebar-placeholder');
    if (sidePlaceholder) sidePlaceholder.outerHTML = sidebarHTML;

    const navPlaceholder = document.getElementById('layout-navbar-placeholder');
    if (navPlaceholder) navPlaceholder.outerHTML = navbarHTML;

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

// ========================================================
// DETECTOR INTELIGENTE DE DIRECCIÓN (Local vs Nube)
// ========================================================


// ========================================================
// NUEVA FUNCIÓN: LÓGICA DEL BOTÓN DE SINCRONIZACIÓN
// ========================================================
async function forzarSincronizacion() {
    const btn = document.getElementById('btnSyncNube');
    const htmlOriginal = btn.innerHTML;

    try {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Sincronizando...`;

        // ---> LA MAGIA: Ahora usa la dirección inteligente en vez de localhost fijo <---
        const baseUrl = obtenerBaseUrl();
        const respuesta = await fetch(`${baseUrl}/sync/forzar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!respuesta.ok) throw new Error("Error en el servidor");

        btn.classList.replace('btn-outline-primary', 'btn-success');
        btn.innerHTML = `<i class="bi bi-check-circle-fill"></i> ¡Listo!`;

        setTimeout(() => {
            window.location.reload();
        }, 1500);
        
        setTimeout(() => {
            btn.classList.replace('btn-success', 'btn-outline-primary');
            btn.innerHTML = htmlOriginal;
            btn.disabled = false;
        }, 3000);

    } catch (error) {
        console.error("Error al sincronizar:", error);
        
        btn.classList.replace('btn-outline-primary', 'btn-danger');
        btn.innerHTML = `<i class="bi bi-x-circle-fill"></i> Error`;
        
        setTimeout(() => {
            btn.classList.replace('btn-danger', 'btn-outline-primary');
            btn.innerHTML = htmlOriginal;
            btn.disabled = false;
        }, 3000);
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

// ========================================================
// ESCUCHA DE ACTUALIZACIONES AUTOMÁTICAS
// ========================================================
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
            if (result.isConfirmed) {
                // Le avisamos al motor de Windows que instale y reinicie
                ipcRenderer.send('reiniciar-y-actualizar');
            }
        });
    });
}