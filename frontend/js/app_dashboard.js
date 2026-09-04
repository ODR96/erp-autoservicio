let graficoVentas = null;

const formatiarDinero = (monto) => {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(monto);
};

// --- ENVOLTORIO DE SEGURIDAD ---
async function apiFetchSeguro(recurso, config = {}) {
    const tokenValido = localStorage.getItem('token') || localStorage.getItem('token_pos');
    if (!tokenValido) throw new Error("Sin sesión");
    
    if (!config.headers) config.headers = {};
    config.headers['Authorization'] = `Bearer ${tokenValido}`;
    config.headers['Content-Type'] = 'application/json';

    const res = await fetch(`${obtenerBaseUrl()}${recurso}`, config);
    if (res.status === 401) {
        localStorage.clear(); window.location.href = 'index.html'; throw new Error("Acceso denegado");
    }
    return res;
}

async function cargarDashboardCompleto() {
    cargarMeticasFinancieras();
    cargarOperatividadDia();
    cargarRankingVentas();
    cargarAlertasYVencimientos();
    cargarBajaRotacion();
    cargarVentasPorPago();
}

// 1. FINANZAS
// 1. FINANZAS Y PUNTO DE EQUILIBRIO
async function cargarMeticasFinancieras() {
    try {
        const res = await apiFetchSeguro('/reportes/ganancia_neta'); 
        const data = await res.json();
        
        if (!data.error) {
            const rf = data.resumen_financiero;
            const ingresos = rf['1_ingresos_por_ventas'];
            const cmv = rf['2_costo_de_la_mercaderia'];
            const gastos = rf['3_gastos_del_local'];
            const gananciaNeta = rf['4_GANANCIA_NETA_PURA'];

            // 1. Llenamos las cajas de texto de arriba
            document.getElementById('dash-ingresos-mes').innerText = formatiarDinero(ingresos);
            document.getElementById('dash-cmv').innerText = formatiarDinero(cmv);
            document.getElementById('dash-gastos').innerText = formatiarDinero(gastos);
            document.getElementById('dash-ganancia').innerText = formatiarDinero(gananciaNeta);
            document.getElementById('dash-rentabilidad').innerText = rf['5_rentabilidad_del_mes'];

            // ==============================================================
            // 2. MATEMÁTICA DEL PUNTO DE EQUILIBRIO (El Velocímetro)
            // ==============================================================
            // Ganancia Bruta = Lo que te queda después de pagarle al camión que te trajo la mercadería
// 2. MATEMÁTICA DEL PUNTO DE EQUILIBRIO
            const gananciaBruta = ingresos - cmv;
            let porcentajeEquilibrio = 0;
            
            if (gastos > 0) {
                porcentajeEquilibrio = (gananciaBruta / gastos) * 100;
            } else if (gananciaBruta > 0) {
                porcentajeEquilibrio = 100; 
            }

            let porcentajeVisual = porcentajeEquilibrio;
            if (porcentajeVisual < 0) porcentajeVisual = 0;
            if (porcentajeVisual > 100) porcentajeVisual = 100;

            // 3. ACTUALIZAMOS TU HTML EXACTO
            const textoProgreso = document.getElementById('dash-progreso-texto');
            if (textoProgreso) {
                // Muestra: "$ 50.000 / $ 110.000" (Ganancia Bruta vs Gastos Reales)
                textoProgreso.innerText = `${formatiarDinero(gananciaBruta)} / ${formatiarDinero(gastos)}`;
            }

            const textoPorcentaje = document.getElementById('dash-progreso-porcentaje');
            if (textoPorcentaje) {
                textoPorcentaje.innerText = `${porcentajeEquilibrio.toFixed(1)}%`;
            }

            const barraEquilibrio = document.getElementById('dash-progreso-barra');
            if (barraEquilibrio) {
                barraEquilibrio.style.width = `${porcentajeVisual}%`;
                
                // Cambiamos el color según cómo venimos
                if (porcentajeEquilibrio >= 100) {
                    barraEquilibrio.className = "progress-bar bg-success progress-bar-striped progress-bar-animated"; 
                } else if (porcentajeEquilibrio >= 75) {
                    barraEquilibrio.className = "progress-bar bg-warning progress-bar-striped progress-bar-animated";
                } else {
                    barraEquilibrio.className = "progress-bar bg-danger progress-bar-striped progress-bar-animated";
                }
            }
        }
    } catch(e) { console.warn("Fallo finanzas", e); }
}

// 2. OPERATIVIDAD DEL DÍA
async function cargarOperatividadDia() {
    try {
        // RUTA CORREGIDA
        const res = await apiFetchSeguro('/dashboard/datos');
        const data = await res.json();
        if (!data.error) {
            document.getElementById('dash-tickets-hoy').innerText = data.hoy.tickets;
            const promedio = data.hoy.tickets > 0 ? (data.hoy.ingresos / data.hoy.tickets) : 0;
            document.getElementById('dash-promedio-hoy').innerText = formatiarDinero(promedio);
            if(data.horarios_calientes) renderizarGrafico(data.horarios_calientes);
        }
    } catch(e) { console.warn("Fallo operatividad", e); }
}

function renderizarGrafico(datos) {
    if (!datos || datos.length === 0) return;
    const horas = datos.map(d => d.hora + ':00');
    const ventas = datos.map(d => d.cantidad_ventas);

    const ctx = document.getElementById('graficoHorarios').getContext('2d');
    if(graficoVentas) { graficoVentas.destroy(); }

    graficoVentas = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: horas,
            datasets: [{ label: 'Tickets', data: ventas, backgroundColor: '#38bdf8', borderRadius: 4 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, color: '#fff',
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#fff', precision: 0 } },
                x: { grid: { display: false }, ticks: { color: '#fff' } }
            },
            plugins: { legend: { display: false } },
        }
    });
}

async function cargarVentasPorPago() {
    const lista = document.getElementById('lista-pagos');
    try {
        const res = await apiFetchSeguro('/reportes/ventas_por_pago');
        const data = await res.json();
        lista.innerHTML = '';
        if(!data || data.length === 0 || data.error) {
            lista.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-4">Sin datos</td></tr>';
        } else {
            // 1. Calculamos la suma de todos los métodos (El Gran Total)
            const granTotal = data.reduce((acc, curr) => acc + curr.total_dinero, 0);

            data.forEach(m => {
                // 2. Calculamos el porcentaje
                const porcentaje = granTotal > 0 ? ((m.total_dinero / granTotal) * 100).toFixed(1) : 0;
                
                lista.innerHTML += `<tr>
                    <td class="text-white fw-bold"><i class="bi bi-wallet2 text-muted me-2"></i> ${m.metodo_pago}</td>
                    <td class="text-center">
                        <span class="badge bg-secondary fs-6">${porcentaje}%</span><br>
                        <small class="text-muted">${m.cantidad_transacciones} tx</small>
                    </td>
                    <td class="text-success text-end fw-bold fs-5">${formatiarDinero(m.total_dinero)}</td>
                </tr>`;
            });
        }
    } catch(e) { console.warn("Fallo pagos", e); }
}

// 3. RANKING DINÁMICO
async function cargarRankingVentas() {
    const periodo = document.getElementById('filtroRanking').value;
    const lista = document.getElementById('lista-ranking');
    lista.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-4">Filtrando...</td></tr>';
    
    try {
        // RUTA CORREGIDA
        const res = await apiFetchSeguro(`/reportes/ranking_ventas?periodo=${periodo}`);
        const data = await res.json();
        lista.innerHTML = '';
        
        if (!data || data.length === 0 || data.error) {
            lista.innerHTML = '<tr><td colspan="3" class="text-muted py-4">No hay ventas registradas.</td></tr>';
        } else {
            data.forEach(p => {
                lista.innerHTML += `
                <tr>
                    <td class="text-start fw-bold text-white text-truncate" style="max-width: 150px;" title="${p.nombre}">${p.nombre}</td>
                    <td class="text-info fw-bold">${p.total_vendido}</td>
                    <td class="text-success">${formatiarDinero(p.recaudacion)}</td>
                </tr>`;
            });
        }
    } catch(e) { console.warn("Fallo ranking", e); }
}

// 4. ALERTAS (CRÍTICO Y VENCIMIENTOS)
async function cargarAlertasYVencimientos() {
    try {
        // RUTA CORREGIDA
        const res = await apiFetchSeguro('/reportes/alertas');
        const data = await res.json();
        
        const listaStock = document.getElementById('lista-stock');
        listaStock.innerHTML = '';
        if (!data.error && data.alertas_stock_critico) {
            document.getElementById('dash-total-critico').innerText = data.alertas_stock_critico.length;
            if (data.alertas_stock_critico.length === 0) {
                listaStock.innerHTML = '<tr><td colspan="2" class="text-center text-success py-4 fw-bold"><i class="bi bi-check-circle fs-4 d-block mb-2"></i> Stock impecable</td></tr>';
            } else {
                data.alertas_stock_critico.forEach(p => {
                    listaStock.innerHTML += `
                    <tr>
                        <td class="fw-bold text-white text-truncate" style="max-width: 180px;" title="${p.nombre}">${p.nombre}</td>
                        <td class="text-end" style="width: 80px;"><span class="badge bg-danger fs-6">${p.stock_actual} / ${p.stock_minimo_alerta}</span></td>
                    </tr>`;
                });
            }
        }

        const listaVenc = document.getElementById('lista-vencimientos');
        listaVenc.innerHTML = '';
        if (!data.error && data.alertas_vencimientos) {

            document.getElementById('badge-vencimientos').innerText = data.alertas_vencimientos.length;
            
            if (data.alertas_vencimientos.length === 0) {
                listaVenc.innerHTML = '<tr><td colspan="2" class="text-center text-success py-4 fw-bold">Sin vencimientos cercanos</td></tr>';
            } else {
                data.alertas_vencimientos.forEach(p => {
                    listaVenc.innerHTML += `
                    <tr>
                        <td class="text-truncate" style="max-width: 150px;" title="${p.nombre}">
                            <div class="fw-bold text-white">${p.nombre}</div>
                            <div class="small text-muted">Lote: ${p.numero_lote_proveedor} | Disp: ${p.cantidad_disponible}</div>
                        </td>
                        <td class="text-end" style="width: 120px;">
                            <span class="badge bg-warning text-dark d-block mb-1">Vence: ${p.fecha_vencimiento}</span>
                            <button class="btn btn-sm btn-outline-info w-100 py-0" onclick="lanzarOfertaModal(${p.producto_id}, '${p.nombre.replace(/'/g, "\\'")}', 'Vencimiento Cercano')">Ofertar</button>
                        </td>
                    </tr>`;
                });
            }
        }
    } catch(e) { console.warn("Fallo alertas", e); }
}

// 5. BAJA ROTACIÓN
async function cargarBajaRotacion() {
    const lista = document.getElementById('lista-estancados');
    try {
        // RUTA CORREGIDA
        const res = await apiFetchSeguro('/reportes/baja_rotacion');
        const data = await res.json();
        lista.innerHTML = '';
        
        if (!data || data.length === 0 || data.error) {
            lista.innerHTML = '<tr><td colspan="2" class="text-center text-success py-4 fw-bold">Rotación excelente</td></tr>';
        } else {
            data.forEach(p => {
                let diasTexto = p.dias_clavado !== undefined ? p.dias_clavado : "varios";
                lista.innerHTML += `
                <tr>
                    <td class="text-truncate" style="max-width: 150px;" title="${p.nombre}">
                        <div class="fw-bold text-white">${p.nombre}</div>
                        <div class="small text-danger">Stock: ${p.stock_estancado} un. | <i class="bi bi-calendar-x"></i> Clavado: ${diasTexto} días</div>
                    </td>
                    <td class="text-end align-middle" style="width: 80px;">
                        <button class="btn btn-sm btn-outline-warning py-0 w-100" onclick="lanzarOfertaModal(${p.producto_id}, '${p.nombre.replace(/'/g, "\\'")}', 'Baja Rotación')">Liquidar</button>
                    </td>
                </tr>`;
            });
        }
    } catch(e) { console.warn("Fallo rotacion", e); }
}

// --- MODAL DE OFERTAS CON COSTOS ---
async function lanzarOfertaModal(id, nombre, motivo) {
    Swal.fire({ title: 'Analizando costos...', didOpen: () => Swal.showLoading() });
    
    try {
        // RUTA CORREGIDA: Apunta a la ruta real de productos para sacar el costo
        const resProd = await apiFetchSeguro(`/productos/ver/${id}`);
        const prod = await resProd.json();
        
        if (prod.error) throw new Error("No se pudo leer el costo");

        let costoNeto = prod.costo_sin_iva || 0;
        let precioActual = prod.precio_venta_final || 0;
        let margenActual = costoNeto > 0 ? (((precioActual / costoNeto) - 1) * 100).toFixed(1) : 0;

        const { value: descuento } = await Swal.fire({
            title: 'Liquidar Producto',
            html: `
                <h5 class="text-info fw-bold mb-3">${nombre}</h5>
                <div class="d-flex justify-content-around mb-3 p-2 bg-dark rounded border border-secondary">
                    <div><small class="d-block text-muted">Costo</small><b class="text-danger">$${costoNeto.toFixed(2)}</b></div>
                    <div><small class="d-block text-muted">P. Actual</small><b class="text-success">$${precioActual.toFixed(2)}</b></div>
                    <div><small class="d-block text-muted">Margen</small><b class="text-warning">${margenActual}%</b></div>
                </div>
                <small class="text-muted d-block mb-2">Motivo: ${motivo}</small>
            `,
            input: 'number',
            inputLabel: 'Descuento a aplicar (%)',
            inputPlaceholder: 'Ej: 20',
            showCancelButton: true,
            confirmButtonText: 'Lanzar Oferta',
            confirmButtonColor: '#d33',
            inputValidator: (value) => {
                if (!value || value <= 0 || value > 99) return 'Ingresá un porcentaje válido';
                let precioNuevo = precioActual * (1 - (value/100));
                if (precioNuevo <= costoNeto) return `¡Peligro! El precio quedaría en $${precioNuevo.toFixed(2)}, por debajo de tu costo ($${costoNeto.toFixed(2)}).`;
            }
        });

        if (descuento) {
            Swal.fire({ title: 'Actualizando precios...', didOpen: () => Swal.showLoading() });
            // RUTA CORREGIDA
            const res = await apiFetchSeguro('/reportes/lanzar_oferta', {
                method: 'POST',
                body: JSON.stringify({ producto_id: id, porcentaje_descuento: parseFloat(descuento), motivo: motivo })
            });
            const data = await res.json();
            Swal.fire('¡Oferta Lanzada!', data.mensaje, 'success');
            cargarDashboardCompleto(); 
        }
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    cargarDashboardCompleto();
    setInterval(cargarDashboardCompleto, 300000); 
});