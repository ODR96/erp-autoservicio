// --- ENVOLTORIO DE SEGURIDAD PARA LLAMADAS ---
async function apiFetchSeguro(recurso, config = {}) {
    const tokenValido = localStorage.getItem('token') || localStorage.getItem('token_pos');
    if (!tokenValido) {
        window.location.href = 'index.html'; 
        throw new Error("Sin sesión");
    }
    
    if (!config.headers) config.headers = {};
    config.headers['Authorization'] = `Bearer ${tokenValido}`;
    config.headers['Content-Type'] = 'application/json';

    const res = await fetch(`${obtenerBaseUrl()}${recurso}`, config);
    if (res.status === 401) {
        localStorage.clear(); window.location.href = 'index.html';
    }
    return res;
}

// --- 1. CARGAR CATEGORÍAS EN EL SELECTOR ---
async function cargarCategorias() {
    const selector = document.getElementById('selectCategoriaGasto');
    try {
        const res = await apiFetchSeguro('/gastos/categorias'); // Asegurate del prefijo
        const data = await res.json();
        
        selector.innerHTML = '<option value="" disabled selected>-- Elegí una categoría --</option>';
        
        if (data.categorias) {
            data.categorias.forEach(cat => {
                selector.innerHTML += `<option value="${cat.id}">${cat.nombre}</option>`;
            });
        }
    } catch (e) {
        console.error("Error al cargar categorías", e);
    }
}

// --- NUEVA FUNCIÓN PARA CREAR CATEGORÍAS ---
async function crearCategoria() {
    const { value: formValues } = await Swal.fire({
        title: 'Nueva Categoría',
        html: `
            <input id="swal-nombre" class="swal2-input form-control-dark w-75 mx-auto" placeholder="Ej: Sueldo, Luz, Limpieza">
            <select id="swal-tipo" class="swal2-select form-select-dark w-75 mx-auto mt-3">
                <option value="OPERATIVO">Gasto del Local (Costos)</option>
                <option value="RETIRO_SOCIO">Retiro Personal / Socio</option>
            </select>
        `,
        background: '#111C2A', color: '#fff',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Crear',
        confirmButtonColor: '#38bdf8',
        preConfirm: () => {
            return {
                nombre: document.getElementById('swal-nombre').value,
                tipo_categoria: document.getElementById('swal-tipo').value
            }
        }
    });

    if (formValues && formValues.nombre) {
        try {
            Swal.fire({ title: 'Guardando...', background: '#111C2A', color: '#fff', didOpen: () => Swal.showLoading() });
            
            const res = await apiFetchSeguro('/gastos/categorias', {
                method: 'POST',
                body: JSON.stringify(formValues)
            });
            const data = await res.json();
            
            if(data.error) throw new Error(data.error);
            
            Swal.fire({
                icon: 'success', 
                title: '¡Listo!', 
                text: data.mensaje, 
                background: '#111C2A', 
                color: '#fff', 
                timer: 1500, 
                showConfirmButton: false
            });
            
            cargarCategorias(); // Recargamos el selector automáticamente
        } catch(e) {
            Swal.fire({icon: 'error', title: 'Error', text: e.message, background: '#111C2A', color: '#fff'});
        }
    }
}

// --- 2. REGISTRAR UN NUEVO GASTO ---
async function registrarGastoNuevo() {
    const categoriaId = document.getElementById('selectCategoriaGasto').value;
    const monto = document.getElementById('inputMontoGasto').value;
    const detalle = document.getElementById('inputDetalleGasto').value;
    const origen = document.getElementById('selectOrigenFondos').value;

    if (!categoriaId || !monto || monto <= 0 || !detalle.trim()) {
        Swal.fire({
            icon: 'warning',
            title: 'Datos Incompletos',
            text: 'Por favor completá el monto, la categoría y el detalle.',
            background: '#111C2A', color: '#fff'
        });
        return;
    }

    try {
        Swal.fire({ title: 'Registrando...', background: '#111C2A', color: '#fff', didOpen: () => Swal.showLoading() });

        const payload = {
            categoria_id: parseInt(categoriaId),
            descripcion_detalle: detalle,
            monto: parseFloat(monto),
            metodo_pago: origen,
            origen_fondos: origen,
            usuario_id: 1 // Esto luego lo toma el backend automático
        };

        const res = await apiFetchSeguro('/gastos/registrar', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (data.error) throw new Error(data.error);

        Swal.fire({
            icon: 'success',
            title: '¡Registrado!',
            text: data.mensaje,
            background: '#111C2A', color: '#fff',
            timer: 2000,
            showConfirmButton: false
        });

        // Limpiar el formulario
        document.getElementById('inputMontoGasto').value = '';
        document.getElementById('inputDetalleGasto').value = '';
        document.getElementById('selectCategoriaGasto').value = '';
        
        // Recargar datos
        cargarResumenMensual();

    } catch (e) {
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: e.message,
            background: '#111C2A', color: '#fff'
        });
    }
}

// --- 3. CARGAR LOS KPIS DEL MES ---
async function cargarResumenMensual() {
    try {
        const res = await apiFetchSeguro('/gastos/resumen_mensual');
        const data = await res.json();
        
        if (!data.error && data.gastos_por_categoria) {
            let totalGastosOperativos = 0;
            let totalRetirosSocio = 0;

            // Magia corporativa: Agrupamos leyendo el TIPO que dice la base de datos
            data.gastos_por_categoria.forEach(item => {
                if (item.tipo_categoria === 'RETIRO_SOCIO') {
                    totalRetirosSocio += item.total_gastado;
                } else {
                    totalGastosOperativos += item.total_gastado;
                }
            });

            document.getElementById('kpiGastos').innerText = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(totalGastosOperativos);
            document.getElementById('kpiRetiros').innerText = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(totalRetirosSocio);
        }
    } catch (e) {
        console.error("Error al cargar KPIs", e);
    }
}

// --- 4. CARGAR EL HISTORIAL DE LA TABLA DERECHA ---
async function cargarHistorial() {
    const tbody = document.getElementById('tablaGastosBody');
    try {
        // Hacemos el llamado a la ruta nueva que agregamos en rutas_gastos.py
        const res = await apiFetchSeguro('/gastos/historial'); 
        const data = await res.json();
        
        tbody.innerHTML = ''; // Limpiamos el mensaje de "Cargando..."
        
        if (data.error || !data.movimientos || data.movimientos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="py-5 text-muted">No hay movimientos registrados.</td></tr>';
            return;
        }

        // Dibujamos fila por fila
        data.movimientos.forEach(mov => {
            // Formatear fecha y plata para que se vea lindo
            const fechaCorta = mov.fecha.split(' ')[0]; 
            const plataLimpia = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(mov.monto);
            
            // Etiqueta de color según de dónde salió la plata
            const badgeColor = mov.origen_fondos === 'CAJA_MAYOR' ? 'bg-success' : 'bg-secondary';
            const origenTexto = mov.origen_fondos === 'CAJA_MAYOR' ? 'Caja Fuerte' : 'Cajón (POS)';

            tbody.innerHTML += `
                <tr>
                    <td class="text-white">${fechaCorta}</td>
                    <td class="text-start fw-bold text-info">${mov.categoria}</td>
                    <td class="text-start text-muted">${mov.detalle}</td>
                    <td><span class="badge ${badgeColor}">${origenTexto}</span></td>
                    <td class="text-end fw-bold text-danger pe-4">${plataLimpia}</td>
                </tr>
            `;
        });
    } catch (e) {
        console.error("Error al cargar el historial", e);
        tbody.innerHTML = '<tr><td colspan="5" class="py-5 text-danger">Error al cargar datos.</td></tr>';
    }
}

// Asegurate de que tu DOMContentLoaded final quede así:
document.addEventListener('DOMContentLoaded', () => {
    cargarCategorias();
    cargarResumenMensual();
    cargarHistorial(); // <--- Agregamos esta línea
});