// ========================================================
// DETECTOR INTELIGENTE DE DIRECCIÓN (Local vs Nube)
// ========================================================
function obtenerBaseUrl() {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.')) {
        return 'http://localhost:8000';
    }
    return 'https://erp-autoservicio-backend.onrender.com'; 
}

async function intentarAcceso() {
    const usuario = document.getElementById('inputUsuario').value.trim();
    const pin = document.getElementById('inputPin').value.trim();
    const btn = document.getElementById('btnIngresar'); // <-- Asegurate de ponerle este id a tu botón HTML

    // Mejora de UX: Avisar si falta un dato en vez de no hacer nada
    if (!usuario || !pin) {
        Swal.fire({ title: 'Atención', text: 'Completá usuario y PIN', icon: 'warning', confirmButtonColor: '#0d6efd' });
        return;
    }

    // --- 1. ESTADO DE CARGA Y BLOQUEO ANTI-SPAM ---
    const htmlOriginal = btn.innerHTML;
    btn.disabled = true; // Bloquea el botón para que no hagan doble clic
    btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Ingresando...`;

    try {
        const baseUrl = obtenerBaseUrl();
        const res = await fetch(`${baseUrl}/usuarios/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo_credencial: usuario, pin_secreto: pin })
        });

        const data = await res.json();

        if (res.ok && data.token_acceso) {
            // Guardado de sesión
            localStorage.setItem('token', data.token_acceso);
            localStorage.setItem('usuario_nombre', data.usuario.nombre);
            localStorage.setItem('usuario_id', data.usuario.id);
            localStorage.setItem('usuario_rol', data.usuario.rol); 
            localStorage.setItem('rol', data.usuario.rol); 

            // --- 2. SOLUCIÓN AL PROBLEMA DE CONFIGURACIÓN VACÍA ---
            try {
                const resConfig = await fetch(`${baseUrl}/configuracion`);
                if (resConfig.ok) {
                    const dataConfig = await resConfig.json();
                    localStorage.setItem('config_negocio', JSON.stringify(dataConfig));
                }
            } catch (error) {
                console.error("No se pudo cargar la config inicial", error);
            }

            // Redirección por rol
            if (data.usuario.rol === 'ADMIN' || data.usuario.rol === 'ENCARGADO') {
                window.location.href = 'admin_productos.html'; 
            } else {
                window.location.href = 'pos.html'; 
            }
        } else {
            // --- 3. SEGURIDAD: Mensaje de error genérico ---
            Swal.fire({ title: 'Acceso Denegado', text: 'Credenciales incorrectas.', icon: 'error', confirmButtonColor: '#0d6efd' });
            
            // Si hay error, apagamos el spinner y revivimos el botón
            btn.disabled = false;
            btn.innerHTML = htmlOriginal;
        }
    } catch (e) {
        Swal.fire('Error', 'No hay conexión con el servidor. Revisá la red.', 'error');
        // También revivimos el botón si se cae el internet
        btn.disabled = false;
        btn.innerHTML = htmlOriginal;
    }
}