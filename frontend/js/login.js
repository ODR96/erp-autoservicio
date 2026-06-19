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

    if (!usuario || !pin) return;

    try {
        const baseUrl = obtenerBaseUrl();
        // Le sacamos la barra final a /login
        const res = await fetch(`${baseUrl}/usuarios/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo_credencial: usuario, pin_secreto: pin })
        });

        const data = await res.json();

        if (res.ok && data.token_acceso) {
            localStorage.setItem('token', data.token_acceso);
            localStorage.setItem('usuario_nombre', data.usuario.nombre);
            localStorage.setItem('usuario_id', data.usuario.id);
            localStorage.setItem('usuario_rol', data.usuario.rol); 
            localStorage.setItem('rol', data.usuario.rol); 

            if (data.usuario.rol === 'ADMIN' || data.usuario.rol === 'ENCARGADO') {
                window.location.href = 'admin_productos.html'; 
            } else {
                window.location.href = 'pos.html'; 
            }
        } else {
            Swal.fire({ title: 'Acceso Denegado', text: data.detail || 'PIN incorrecto', icon: 'error', confirmButtonColor: '#0d6efd' });
        }
    } catch (e) {
        Swal.fire('Error', 'No hay conexión con el servidor.', 'error');
    }
}