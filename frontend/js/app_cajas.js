// frontend/js/app_cajas.js

function cambiarPestana(id, evento) {
    document.querySelectorAll('#cajaTabs .nav-link').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    evento.target.classList.add('active');
    document.getElementById('tab-' + id).classList.add('active');
}

async function cargarDatosEnVivo() {
    cargarMonitor();
    cargarEmpleados();
}

async function cargarMonitor() {
    const contenedor = document.getElementById('contenedorMonitorVivo');
    
    try {
        const response = await fetch('http://localhost:8000/caja/monitor_vivo');
        const data = await response.json();
        
        if (data.error) throw new Error(data.error);

        const turnos = data.turnos_vivos;
        contenedor.innerHTML = '';

        if (turnos.length === 0) {
            contenedor.innerHTML = `
                <div class="col-12 text-center text-muted py-5">
                    <i class="bi bi-safe display-1 mb-3 d-block opacity-50"></i>
                    <h4>No hay ninguna caja abierta en este momento.</h4>
                    <p>El mostrador está cerrado.</p>
                </div>
            `;
            return;
        }

        turnos.forEach(t => {
            // Formatear la fecha para que se lea linda
            let fecha = new Date(t.fecha_hora_apertura).toLocaleTimeString('es-AR', {hour: '2-digit', minute:'2-digit'});
            
            contenedor.innerHTML += `
                <div class="col-md-6 col-lg-4">
                    <div class="card border-success h-100 shadow-sm">
                        <div class="card-header bg-success text-white fw-bold d-flex justify-content-between align-items-center">
                            <span><i class="bi bi-display"></i> CAJA ${t.caja_id}</span>
                            <span class="badge bg-light text-success"><i class="bi bi-circle-fill text-success" style="font-size:0.5rem; vertical-align: middle;"></i> ONLINE</span>
                        </div>
                        <div class="card-body">
                            <h5 class="fw-bold mb-0 text-primary">${t.cajero || "Cajero Desconocido"}</h5>
                            <small class="text-muted d-block mb-3">Abrió a las: ${fecha}</small>
                            
<ul class="list-group list-group-flush mb-3 small">
                                <li class="list-group-item d-flex justify-content-between px-0">
                                    <span>Fondo Inicial:</span> <b>$${t.monto_inicial.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 text-success">
                                    <span>Ventas Efectivo:</span> <b>+$${t.ventas_efectivo.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 text-success">
                                    <span>Otros Ingresos:</span> <b>+$${t.ingresos.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 text-danger">
                                    <span>Retiros/Gastos:</span> <b>-$${t.retiros.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 bg-light mt-2 border-top border-secondary">
                                    <span class="text-muted"><i class="bi bi-credit-card"></i> Tarjetas:</span> <b class="text-muted">$${t.ventas_tarjeta.toFixed(2)}</b>
                                </li>
                                <li class="list-group-item d-flex justify-content-between px-0 bg-light">
                                    <span class="text-muted"><i class="bi bi-qr-code-scan"></i> Billeteras Virtuales:</span> <b class="text-muted">$${t.ventas_virtual.toFixed(2)}</b>
                                </li>
                            </ul>
                            
                            <div class="p-3 bg-light rounded text-center border">
                                <span class="d-block text-muted fw-bold small text-uppercase mb-1">Efectivo Físico en Cajón</span>
                                <h3 class="fw-bold text-success mb-0">$${t.total_esperado.toFixed(2)}</h3>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

    } catch (e) {
        contenedor.innerHTML = `<div class="col-12 text-center text-danger py-4 fw-bold">Error de conexión con el servidor.</div>`;
    }
}

async function cargarEmpleados() {
    const tbody = document.getElementById('tablaEmpleadosBody');
    try {
        const response = await fetch('http://localhost:8000/usuarios/listar');
        const data = await response.json();
        
        if (data.error) throw new Error(data.error);

        tbody.innerHTML = '';
        data.usuarios.forEach(u => {
            let badgeRol = 'bg-secondary';
            if(u.rol === 'ADMIN') badgeRol = 'bg-danger';
            if(u.rol === 'ENCARGADO') badgeRol = 'bg-warning text-dark';
            if(u.rol === 'CAJERO') badgeRol = 'bg-info text-dark';

            // PARCHE: Botones de Lápiz y Basurero
// PARCHE: Botones de Lápiz y Basurero, o Botón de Restaurar
            // PARCHE: Botones de Editar, Borrar y el nuevo de Imprimir Credencial
            let botonesAccion = u.estado === 'ACTIVO' 
                ? `
                   <button class="btn btn-sm btn-outline-dark py-0 me-1" title="Imprimir Credencial" onclick="imprimirCredencial('${u.nombre_completo}', '${u.rol}', '${u.codigo_barras_credencial}')"><i class="bi bi-printer"></i></button>
                   <button class="btn btn-sm btn-outline-primary py-0" title="Editar" onclick="abrirEditarEmpleado(${u.id}, '${u.nombre_completo}', '${u.rol}', '${u.codigo_barras_credencial}')"><i class="bi bi-pencil"></i></button>
                   <button class="btn btn-sm btn-outline-danger py-0 ms-1" title="Dar de baja" onclick="darDeBajaEmpleado(${u.id}, '${u.nombre_completo}')"><i class="bi bi-trash"></i></button>
                  `
                : `<button class="btn btn-sm btn-success py-0 fw-bold shadow-sm" onclick="reactivarEmpleado(${u.id}, '${u.nombre_completo}')"><i class="bi bi-arrow-counterclockwise"></i> Restaurar</button>`;
            let badgeEstado = u.estado === 'ACTIVO' ? `<span class="badge bg-success">Activo</span>` : `<span class="badge bg-secondary">Inactivo</span>`;
            let claseFila = u.estado === 'ACTIVO' ? '' : 'opacity-50 bg-light';

            tbody.innerHTML += `
                <tr class="${claseFila}">
                    <td class="text-muted fw-bold">#${u.id}</td>
                    <td class="fw-bold">${u.nombre_completo}</td>
                    <td><span class="badge ${badgeRol}">${u.rol}</span></td>
                    <td class="text-muted"><i class="bi bi-upc-scan"></i> ${u.codigo_barras_credencial || 'Sin tarjeta'}</td>
                    <td class="text-center">${botonesAccion}</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Error cargando usuarios</td></tr>`;
    }
}

// Limpiar el modal cuando tocamos "NUEVO EMPLEADO"
document.querySelector('[data-bs-target="#modalNuevoEmpleado"]').addEventListener('click', () => {
    document.getElementById('empId').value = '';
    document.getElementById('empNombre').value = '';
    document.getElementById('empRol').value = 'CAJERO';
    document.getElementById('empPin').value = '';
    document.getElementById('empCredencial').value = '';
    document.querySelector('#modalNuevoEmpleado .modal-title').innerHTML = '<i class="bi bi-person-badge"></i> Alta de Empleado';
});

// Función para llenar el modal y abrirlo en modo "EDICIÓN"
function abrirEditarEmpleado(id, nombre, rol, credencial) {
    document.getElementById('empId').value = id;
    document.getElementById('empNombre').value = nombre;
    document.getElementById('empRol').value = rol;
    document.getElementById('empPin').value = ''; // Lo dejamos vacío por seguridad
    document.getElementById('empCredencial').value = credencial === 'null' ? '' : credencial;
    
    document.querySelector('#modalNuevoEmpleado .modal-title').innerHTML = '<i class="bi bi-pencil-square"></i> Editar Empleado';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalNuevoEmpleado')).show();
}

async function guardarEmpleado() {
    const idEditando = document.getElementById('empId').value; // Si tiene número, estamos editando
    const nombre = document.getElementById('empNombre').value.trim();
    const rol = document.getElementById('empRol').value;
    const pin = document.getElementById('empPin').value.trim();
    const credencial = document.getElementById('empCredencial').value.trim() || `CRED-${Math.floor(Math.random() * 10000)}`;

// EL PARCHE: Si es nuevo exige PIN, si estamos editando lo deja pasar en blanco
    if(!nombre) return Swal.fire('Atención', 'El nombre es obligatorio', 'warning');
    if(idEditando === '' && !pin) return Swal.fire('Atención', 'El PIN es obligatorio para un empleado nuevo', 'warning');
    
    try {
        let url = 'http://localhost:8000/usuarios/crear';
        let metodo = 'POST';

        // Si estamos editando, cambiamos la ruta y el método
        if (idEditando !== '') {
            url = `http://localhost:8000/usuarios/actualizar/${idEditando}`;
            metodo = 'PUT';
        }

        const res = await fetch(url, {
            method: metodo,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre_completo: nombre, rol: rol, codigo_barras_credencial: credencial, pin_secreto: pin })
        });
        const data = await res.json();
        
        if (!res.ok) throw new Error(data.detail || data.error || "Error al guardar");

        Swal.fire('¡Éxito!', 'Empleado guardado correctamente.', 'success');
        bootstrap.Modal.getInstance(document.getElementById('modalNuevoEmpleado')).hide();
        cargarEmpleados();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// Función para echar / bloquear a un empleado
async function darDeBajaEmpleado(id, nombre) {
    const confirm = await Swal.fire({
        title: '¿Dar de baja?',
        text: `El usuario ${nombre} ya no podrá entrar al sistema.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonText: 'Cancelar',
        confirmButtonText: 'Sí, bloquear acceso'
    });

    if (confirm.isConfirmed) {
        try {
            await fetch(`http://localhost:8000/usuarios/baja/${id}`, { method: 'DELETE' });
            Swal.fire('Bloqueado', 'Empleado dado de baja.', 'success');
            cargarEmpleados();
        } catch (e) {
            Swal.fire('Error', 'No se pudo dar de baja.', 'error');
        }
    }
}
// Función para devolverle el acceso a un empleado
async function reactivarEmpleado(id, nombre) {
    const confirm = await Swal.fire({
        title: '¿Reactivar empleado?',
        text: `Devolver acceso al sistema a ${nombre}.`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#198754',
        cancelButtonText: 'Cancelar',
        confirmButtonText: 'Sí, reactivar'
    });

    if (confirm.isConfirmed) {
        try {
            await fetch(`http://localhost:8000/usuarios/alta/${id}`, { method: 'PUT' });
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Usuario reactivado', showConfirmButton: false, timer: 1500 });
            cargarEmpleados();
        } catch (e) {
            Swal.fire('Error', 'No se pudo reactivar.', 'error');
        }
    }
}

// Función para generar la credencial en PDF
function imprimirCredencial(nombre, rol, codigo) {
    if (!codigo || codigo === 'null' || codigo === '') return Swal.fire('Error', 'Este empleado no tiene un código de credencial asignado.', 'warning');

    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Credencial ${nombre}</title>
            <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.0/dist/JsBarcode.all.min.js"></script>
            <style>
                body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f0f0f0; font-family: sans-serif; }
                .credencial { width: 54mm; height: 86mm; background-color: white; border: 2px solid #333; border-radius: 10px; display: flex; flex-direction: column; align-items: center; padding: 15px; box-sizing: border-box; box-shadow: 0 4px 8px rgba(0,0,0,0.2); }
                .logo { font-weight: 900; font-size: 14px; text-transform: uppercase; color: #1b365d; text-align: center; margin-bottom: 20px; }
                .nombre { font-size: 18px; font-weight: bold; text-align: center; line-height: 1.1; margin-bottom: 5px; }
                .rol { font-size: 12px; color: #666; font-weight: bold; text-transform: uppercase; margin-bottom: auto; }
                .barcode-container { margin-top: 15px; }
                svg { width: 100%; height: 60px; }
            </style>
        </head>
        <body>
            <div class="credencial">
                <div class="logo">Autoservicio<br>20 de Junio</div>
                <div class="nombre">${nombre}</div>
                <div class="rol">${rol}</div>
                <div class="barcode-container">
                    <svg id="barcode"></svg>
                </div>
            </div>
            <script>
                JsBarcode("#barcode", "${codigo}", { format: "CODE128", width: 2, height: 50, displayValue: true, fontSize: 14, margin: 0 });
                setTimeout(() => { window.print(); }, 500);
            </script>
        </body>
        </html>
    `;

    let vent = window.open('', '_blank', 'width=400,height=600');
    vent.document.write(html);
    vent.document.close();
}
// Arrancamos
document.addEventListener("DOMContentLoaded", () => {
    // Le agregamos el link correcto a la flecha del layout para esta página
    document.querySelector('.sidebar-menu a[href="admin_productos.html"]').classList.remove('active');
    
    
    cargarDatosEnVivo();
});