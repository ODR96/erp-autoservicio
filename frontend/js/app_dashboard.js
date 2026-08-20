let graficoVentas = null;

// Formateador de moneda argentina
const formatiarDinero = (monto) => {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(monto);
};

// Función principal para cargar datos
async function cargarDashboard() {
    try {
        // Buscamos la llave maestra donde sea que esté guardada
        const tokenValido = localStorage.getItem('token') || localStorage.getItem('token_pos');
        
        if (!tokenValido) {
            console.warn("No se encontró sesión activa.");
            document.getElementById('dash-ingresos').innerText = "SIN SESIÓN";
            return;
        }

        const res = await fetch(`${obtenerBaseUrl()}/dashboard/datos`, {
            headers: { 
                'Authorization': `Bearer ${tokenValido}`,
                'Content-Type': 'application/json'
            }
        });

        // Si el patovica nos rebota (401), cortamos por lo sano
        if (res.status === 401) {
            throw new Error("Permisos insuficientes o sesión vencida (401)");
        }
        
        if (!res.ok) throw new Error("Error en la respuesta del servidor");
        
        const data = await res.json();

        // 1. Tarjetas
        document.getElementById('dash-ingresos').innerText = `$${data.hoy.ingresos.toLocaleString('es-AR', {minimumFractionDigits: 2})}`;
        document.getElementById('dash-tickets').innerText = data.hoy.tickets;

        // 2. Stock Crítico
        const lista = document.getElementById('lista-stock');
        lista.innerHTML = '';
        data.stock_critico.forEach(p => {
            lista.innerHTML += `<li class="list-group-item d-flex justify-content-between align-items-center">
                ${p.nombre} <span class="badge bg-danger rounded-pill">${p.stock_real} / ${p.stock_minimo_alerta}</span>
            </li>`;
        });

        // 3. Gráfico (Chart.js)
        const ctx = document.getElementById('graficoHorarios').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.horarios_calientes.map(d => d.hora + ':00'),
                datasets: [{
                    label: 'Tickets',
                    data: data.horarios_calientes.map(d => d.cantidad_ventas),
                    backgroundColor: '#1a365d',
                    borderRadius: 4
                }]
            },
            options: { plugins: { legend: { display: false } } }
        });
    } catch (error) {
        console.error("Error cargando dashboard:", error);
    }
}

// Configuración de Chart.js
function renderizarGrafico(datos) {
    const horas = datos.map(d => d.hora + ':00');
    const ventas = datos.map(d => d.cantidad_ventas);

    const ctx = document.getElementById('graficoHorarios').getContext('2d');
    
    // Destruir gráfico previo si se está actualizando para evitar superposiciones
    if(graficoVentas) { graficoVentas.destroy(); }

    graficoVentas = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: horas,
            datasets: [{
                label: 'Tickets por Hora',
                data: ventas,
                backgroundColor: '#0ea5e9', // Azul Petróleo
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true, grid: { color: '#334155' } },
                x: { grid: { display: false } }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function lanzarPromo(producto) {
    alert(`Lógica futura: Abriendo modal para bajar el precio de ${producto}`);
    // Acá luego conectamos el POST a la API para bajar el precio temporalmente.
}

// Cargar al inicio y auto-actualizar cada 5 minutos (300000 ms)
document.addEventListener('DOMContentLoaded', () => {
    cargarDashboard();
    setInterval(cargarDashboard, 300000); 
});