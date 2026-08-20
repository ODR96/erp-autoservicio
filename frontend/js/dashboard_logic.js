let graficoVentas = null;

// Formateador de moneda argentina
const formatiarDinero = (monto) => {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(monto);
};

// Función principal para cargar datos
async function cargarDashboard() {
    try {
        const respuesta = await fetch('/api/dashboard');
        const json = await respuesta.json();
        
        if(json.status === 'success') {
            const data = json.data;

            // 1. Llenar Tarjetas Superiores
            document.getElementById('val-ingresos').innerText = formatiarDinero(data.hoy.ingresos);
            document.getElementById('val-tickets').innerText = data.hoy.tickets;
            document.getElementById('val-riesgo').innerText = data.vencimientos.length;

            // 2. Tabla Stock Crítico
            const tbodyCritico = document.getElementById('tabla-critico');
            tbodyCritico.innerHTML = '';
            data.stock_critico.forEach(item => {
                tbodyCritico.innerHTML += `
                    <tr>
                        <td>${item.nombre}</td>
                        <td><span class="badge-rojo">${item.stock_real} / ${item.stock_minimo_alerta}</span></td>
                    </tr>
                `;
            });

            // 3. Tabla Vencimientos
            const tbodyVenc = document.getElementById('tabla-vencimientos');
            tbodyVenc.innerHTML = '';
            data.vencimientos.forEach(item => {
                tbodyVenc.innerHTML += `
                    <tr>
                        <td>${item.nombre} <br><small style="color: #64748b;">Quedan: ${item.cantidad_disponible}</small></td>
                        <td>${item.fecha_vencimiento}</td>
                        <td><button class="btn-promo" onclick="lanzarPromo('${item.nombre}')">Promo</button></td>
                    </tr>
                `;
            });

            // 4. Tabla Faltantes
            const tbodyFaltantes = document.getElementById('tabla-faltantes');
            tbodyFaltantes.innerHTML = '';
            data.faltantes.forEach(item => {
                tbodyFaltantes.innerHTML += `
                    <tr>
                        <td>${item.descripcion_producto}</td>
                        <td>${item.cantidad_pedida}</td>
                    </tr>
                `;
            });

            // 5. Renderizar Gráfico de Horarios
            renderizarGrafico(data.horarios_calientes);

            // Hora de actualización
            const ahora = new Date();
            document.getElementById('ultima-actualizacion').innerText = `Última act: ${ahora.toLocaleTimeString('es-AR')}`;
        }
    } catch (error) {
        console.error("Error al cargar el dashboard:", error);
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