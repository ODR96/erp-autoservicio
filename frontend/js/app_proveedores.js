let graficoVentas = null;

const formatiarDinero = (monto) => {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(monto);
};

async function cargarDashboard() {
    try {
        const tokenValido = localStorage.getItem('token') || localStorage.getItem('token_pos');
        
        if (!tokenValido) {
            console.warn("No se encontró sesión activa.");
            document.getElementById('dash-ingresos').innerText = "SIN ACCESO";
            return;
        }

        const res = await fetch(`${obtenerBaseUrl()}/dashboard/datos`, {
            headers: { 
                'Authorization': `Bearer ${tokenValido}`,
                'Content-Type': 'application/json'
            }
        });

        if (res.status === 401) throw new Error("Permisos insuficientes");
        if (!res.ok) throw new Error("Error en la respuesta del servidor");
        
        const data = await res.json();

        // Actualización de KPIs
        document.getElementById('dash-ingresos').innerText = formatiarDinero(data.hoy.ingresos);
        document.getElementById('dash-tickets').innerText = data.hoy.tickets;
        
        const promedio = data.hoy.tickets > 0 ? (data.hoy.ingresos / data.hoy.tickets) : 0;
        document.getElementById('dash-promedio').innerText = formatiarDinero(promedio);

        // Lista de Stock Crítico
        const lista = document.getElementById('lista-stock');
        lista.innerHTML = '';
        
        document.getElementById('dash-total-critico').innerText = data.stock_critico.length;

        if (data.stock_critico.length === 0) {
            lista.innerHTML = '<tr><td class="text-center text-success py-4"><i class="bi bi-check-circle fs-4 d-block mb-2"></i> Stock en niveles óptimos</td></tr>';
        } else {
            data.stock_critico.forEach(p => {
                lista.innerHTML += `
                <tr>
                    <td class="fw-bold">${p.nombre}</td>
                    <td class="text-end">
                        <span class="badge bg-danger bg-opacity-25 text-danger border border-danger px-2 py-1">
                            ${p.stock_real} / ${p.stock_minimo_alerta}
                        </span>
                    </td>
                </tr>`;
            });
        }

        // Renderizar el gráfico adaptado al modo oscuro
        renderizarGrafico(data.horarios_calientes);

    } catch (error) {
        console.error("Error cargando dashboard:", error);
    }
}

function renderizarGrafico(datos) {
    const horas = datos.map(d => d.hora + ':00');
    const ventas = datos.map(d => d.cantidad_ventas);

    const ctx = document.getElementById('graficoHorarios').getContext('2d');
    
    if(graficoVentas) { graficoVentas.destroy(); }

    graficoVentas = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: horas,
            datasets: [{
                label: 'Tickets Emitidos',
                data: ventas,
                backgroundColor: '#235A68', // Azul Petróleo corporativo
                hoverBackgroundColor: '#38bdf8',
                borderRadius: 6,
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            color: '#94A3B8', // Letras en gris claro
            scales: {
                y: { 
                    beginAtZero: true, 
                    grid: { color: 'rgba(255, 255, 255, 0.05)', drawBorder: false },
                    ticks: { color: '#94A3B8' }
                },
                x: { 
                    grid: { display: false },
                    ticks: { color: '#94A3B8' }
                }
            },
            plugins: { 
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#142032',
                    titleColor: '#E2E8F0',
                    bodyColor: '#38bdf8',
                    borderColor: '#1F304A',
                    borderWidth: 1,
                    padding: 12
                }
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    cargarDashboard();
    setInterval(cargarDashboard, 300000); 
});