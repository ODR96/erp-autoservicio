let cacheRentabilidad = [];
let cacheRanking = [];
let cacheMix = [];
let cacheClavos = [];
let cacheDias = [];
let cacheCierres = [];

function mesActualAR() {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
    return partes.slice(0, 7);
}

function mesAnterior(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function plata(n) {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(n) || 0);
}

function mesElegido() {
    return document.getElementById('inputMesReporte').value || mesActualAR();
}

async function apiReportes(path) {
    const token = localStorage.getItem('token') || localStorage.getItem('token_pos');
    const res = await fetch(`${obtenerBaseUrl()}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
        localStorage.clear();
        window.location.href = 'index.html';
        throw new Error('401');
    }
    return res.json();
}

function cambiarTabReporte(id) {
    document.querySelectorAll('.tab-reporte').forEach((el) => el.classList.add('d-none'));
    document.getElementById(`tab-${id}`).classList.remove('d-none');
    document.querySelectorAll('#tabsReportes .nav-link').forEach((btn) => {
        const on = btn.dataset.tab === id;
        btn.classList.toggle('active', on);
        btn.classList.toggle('text-secondary', !on);
    });
}

function filaVacia(colspan, texto) {
    return `<tr><td colspan="${colspan}" class="text-center text-muted py-4">${texto}</td></tr>`;
}

function escHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function horaCorta(dt) {
    if (!dt) return '—';
    return String(dt).replace('T', ' ').slice(0, 16);
}

function bajarCsv(nombre, filas) {
    const csv = filas.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(a.href);
}

function resumenDe(data) {
    return (data && data.resumen_financiero) || {};
}

async function cargarRentabilidad() {
    const mes = mesElegido();
    const prev = mesAnterior(mes);
    document.getElementById('txtMesRentabilidad').innerText = `${mes} vs ${prev}`;
    const tbody = document.getElementById('tablaRentabilidad');
    tbody.innerHTML = filaVacia(4, 'Cargando...');
    const [actual, anterior] = await Promise.all([
        apiReportes(`/reportes/ganancia_neta?mes=${encodeURIComponent(mes)}`),
        apiReportes(`/reportes/ganancia_neta?mes=${encodeURIComponent(prev)}`),
    ]);
    if (actual.error) {
        tbody.innerHTML = filaVacia(4, actual.error);
        return;
    }
    const a = resumenDe(actual);
    const b = resumenDe(anterior.error ? {} : anterior);
    const lineas = [
        ['Ventas', a['1_ingresos_por_ventas'], b['1_ingresos_por_ventas']],
        ['CMV (costo mercadería)', a['2_costo_de_la_mercaderia'], b['2_costo_de_la_mercaderia']],
        ['Gastos del local', a['3_gastos_del_local'], b['3_gastos_del_local']],
        ['Mermas', a['8_mermas_del_mes'], b['8_mermas_del_mes']],
        ['Comisiones de cobro', a['9_comisiones_medios'], b['9_comisiones_medios']],
        ['Ganancia neta', a['4_GANANCIA_NETA_PURA'], b['4_GANANCIA_NETA_PURA']],
        ['Sueldos pendientes de liquidar', a['6_sueldos_comprometidos'], b['6_sueldos_comprometidos']],
        ['Piso operativo (gastos + sueldos)', a['7_piso_operativo_mes'], b['7_piso_operativo_mes']],
    ];
    cacheRentabilidad = [['Concepto', mes, prev, 'Dif.']];
    tbody.innerHTML = lineas.map(([nombre, va, vb]) => {
        const n = Number(va) || 0;
        const o = Number(vb) || 0;
        const d = n - o;
        const cls = d > 0 ? 'text-success' : (d < 0 ? 'text-danger' : 'text-muted');
        cacheRentabilidad.push([nombre, n.toFixed(2), o.toFixed(2), d.toFixed(2)]);
        return `<tr>
            <td class="fw-bold">${nombre}</td>
            <td class="text-end">${plata(n)}</td>
            <td class="text-end text-muted">${plata(o)}</td>
            <td class="text-end fw-bold ${cls}">${plata(d)}</td>
        </tr>`;
    }).join('');
    const rent = a['5_rentabilidad_del_mes'] || '0%';
    tbody.innerHTML += `<tr class="table-light"><td class="fw-bold">Rentabilidad sobre ventas</td><td class="text-end fw-bold" colspan="3">${rent}</td></tr>`;
}

async function cargarRanking() {
    const mes = mesElegido();
    const tbody = document.getElementById('tablaRanking');
    tbody.innerHTML = filaVacia(4, 'Cargando...');
    const data = await apiReportes(`/reportes/ranking_ventas?mes=${encodeURIComponent(mes)}&limit=50`);
    const lista = Array.isArray(data) ? data : [];
    cacheRanking = [['#', 'Producto', 'Unidades', 'Recaudacion']];
    if (!lista.length || data.error) {
        tbody.innerHTML = filaVacia(4, 'Sin ventas en ese mes.');
        return;
    }
    tbody.innerHTML = lista.map((p, i) => {
        cacheRanking.push([i + 1, p.nombre, p.total_vendido, Number(p.recaudacion || 0).toFixed(2)]);
        return `<tr>
            <td>${i + 1}</td>
            <td class="fw-bold">${p.nombre || ''}</td>
            <td class="text-end">${p.total_vendido}</td>
            <td class="text-end">${plata(p.recaudacion)}</td>
        </tr>`;
    }).join('');
}

async function cargarMix() {
    const mes = mesElegido();
    const tbody = document.getElementById('tablaMix');
    tbody.innerHTML = filaVacia(4, 'Cargando...');
    const data = await apiReportes(`/reportes/ventas_por_pago?mes=${encodeURIComponent(mes)}`);
    const lista = Array.isArray(data) ? data : [];
    cacheMix = [['Medio', 'Tickets', 'Importe', '%']];
    if (!lista.length || data.error) {
        tbody.innerHTML = filaVacia(4, 'Sin cobros en ese mes.');
        return;
    }
    const total = lista.reduce((s, r) => s + (Number(r.total_dinero) || 0), 0);
    tbody.innerHTML = lista.map((r) => {
        const imp = Number(r.total_dinero) || 0;
        const pct = total > 0 ? ((imp / total) * 100).toFixed(1) : '0.0';
        cacheMix.push([r.metodo_pago, r.cantidad_transacciones, imp.toFixed(2), pct]);
        return `<tr>
            <td class="fw-bold">${r.metodo_pago || ''}</td>
            <td class="text-end">${r.cantidad_transacciones}</td>
            <td class="text-end">${plata(imp)}</td>
            <td class="text-end">${pct}%</td>
        </tr>`;
    }).join('');
}

async function cargarClavos() {
    const tbody = document.getElementById('tablaClavos');
    tbody.innerHTML = filaVacia(3, 'Cargando...');
    const data = await apiReportes('/reportes/baja_rotacion');
    const lista = Array.isArray(data) ? data : [];
    cacheClavos = [['Producto', 'Stock', 'Dias clavado']];
    if (!lista.length || data.error) {
        tbody.innerHTML = filaVacia(3, 'No hay clavos de 30 días.');
        return;
    }
    tbody.innerHTML = lista.map((p) => {
        cacheClavos.push([p.nombre, p.stock_estancado, p.dias_clavado]);
        return `<tr>
            <td class="fw-bold">${p.nombre || ''}</td>
            <td class="text-end">${p.stock_estancado}</td>
            <td class="text-end">${p.dias_clavado}</td>
        </tr>`;
    }).join('');
}

async function cargarDias() {
    const mes = mesElegido();
    const tbody = document.getElementById('tablaDias');
    tbody.innerHTML = filaVacia(5, 'Cargando...');
    const data = await apiReportes(`/reportes/ventas_por_dia?mes=${encodeURIComponent(mes)}`);
    const lista = (data && data.dias) || [];
    cacheDias = [['Dia', 'Tickets', 'Total', 'Efectivo', 'Fiado']];
    if (data.error || !lista.length) {
        tbody.innerHTML = filaVacia(5, 'Sin ventas en ese mes.');
        return;
    }
    let totT = 0;
    let totI = 0;
    let totE = 0;
    let totF = 0;
    tbody.innerHTML = lista.map((r) => {
        const t = Number(r.tickets) || 0;
        const i = Number(r.total) || 0;
        const e = Number(r.efectivo) || 0;
        const f = Number(r.fiado) || 0;
        totT += t;
        totI += i;
        totE += e;
        totF += f;
        cacheDias.push([r.dia, t, i.toFixed(2), e.toFixed(2), f.toFixed(2)]);
        return `<tr>
            <td class="fw-bold">${escHtml(r.dia)}</td>
            <td class="text-end">${t}</td>
            <td class="text-end">${plata(i)}</td>
            <td class="text-end">${plata(e)}</td>
            <td class="text-end">${plata(f)}</td>
        </tr>`;
    }).join('');
    cacheDias.push(['TOTAL', totT, totI.toFixed(2), totE.toFixed(2), totF.toFixed(2)]);
    tbody.innerHTML += `<tr class="table-light fw-bold">
        <td>Total mes</td>
        <td class="text-end">${totT}</td>
        <td class="text-end">${plata(totI)}</td>
        <td class="text-end">${plata(totE)}</td>
        <td class="text-end">${plata(totF)}</td>
    </tr>`;
}

async function cargarCierres() {
    const mes = mesElegido();
    const tbody = document.getElementById('tablaCierres');
    const resumen = document.getElementById('resumenCierres');
    tbody.innerHTML = filaVacia(10, 'Cargando...');
    if (resumen) resumen.innerText = '—';
    const oficina = document.getElementById('chkCierresOficina')?.checked ? '1' : '0';
    const data = await apiReportes(`/reportes/cierres?mes=${encodeURIComponent(mes)}&incluir_oficina=${oficina}`);
    const lista = (data && data.cierres) || [];
    cacheCierres = [['Id', 'Cajero', 'Caja', 'Apertura', 'Cierre', 'Estado', 'Tickets', 'Ventas', 'CMV', 'Margen', 'Faltante']];
    if (data.error || !lista.length) {
        tbody.innerHTML = filaVacia(10, 'Sin turnos de caja en ese mes.');
        return;
    }
    let nPerdida = 0;
    let nFaltante = 0;
    let totMargen = 0;
    let totFaltante = 0;
    tbody.innerHTML = lista.map((t) => {
        const dif = Number(t.diferencia) || 0;
        const margen = Number(t.ganancia_bruta) || 0;
        const cmv = Number(t.cmv) || 0;
        const cerrado = t.estado_turno !== 'ABIERTO';
        const perdida = margen < 0;
        const faltante = cerrado && dif < 0;
        if (perdida) nPerdida += 1;
        if (faltante) nFaltante += 1;
        totMargen += margen;
        if (cerrado) totFaltante += Math.min(dif, 0);
        const caja = t.caja_nombre || (`Caja ${t.caja_id || ''}`);
        cacheCierres.push([
            t.id, t.cajero, caja, t.fecha_hora_apertura, t.fecha_hora_cierre || '',
            t.estado_turno, t.tickets, Number(t.ventas || 0).toFixed(2),
            cmv.toFixed(2), margen.toFixed(2), dif.toFixed(2),
        ]);
        const badge = t.estado_turno === 'ABIERTO'
            ? '<span class="badge text-bg-warning">ABIERTO</span>'
            : '<span class="badge text-bg-secondary">CERRADO</span>';
        const avisos = [
            Number(t.solo_admin) ? '<span class="badge text-bg-dark">OFICINA</span>' : '',
            perdida ? '<span class="badge text-bg-danger">PÉRDIDA</span>' : '',
            faltante ? '<span class="badge text-bg-danger">FALTANTE</span>' : '',
        ].join(' ');
        const clsMargen = perdida ? 'text-danger' : (margen > 0 ? 'text-success' : 'text-muted');
        const clsDif = faltante ? 'text-danger' : (cerrado && dif > 0 ? 'text-success' : 'text-muted');
        return `<tr>
            <td>${t.id}</td>
            <td class="fw-bold">${escHtml(t.cajero)} ${avisos}</td>
            <td class="small">${escHtml(horaCorta(t.fecha_hora_apertura))}</td>
            <td class="small">${escHtml(horaCorta(t.fecha_hora_cierre))}</td>
            <td>${badge}</td>
            <td class="text-end">${plata(t.ventas)} <span class="text-muted small">(${t.tickets || 0})</span></td>
            <td class="text-end">${plata(cmv)}</td>
            <td class="text-end fw-bold ${clsMargen}">${plata(margen)}</td>
            <td class="text-end fw-bold ${clsDif}">${cerrado ? plata(dif) : '—'}</td>
            <td class="text-end"><button type="button" class="btn btn-outline-primary btn-sm fw-bold" onclick="verCierre(${Number(t.id)})">Ver</button></td>
        </tr>`;
    }).join('');
    if (resumen) {
        const nOficina = Number(data.ocultos_oficina) || 0;
        const extra = nOficina ? ` · ${nOficina} de oficina ocultos` : '';
        resumen.innerHTML = `${lista.length} turnos · ${nPerdida} con margen negativo · ${nFaltante} con faltante · margen mes ${plata(totMargen)} · faltantes ${plata(totFaltante)}${extra}`;
        resumen.className = `small fw-bold mb-2 ${(nPerdida || nFaltante) ? 'text-danger' : 'text-muted'}`;
    }
}

async function verCierre(turnoId) {
    Swal.fire({ title: `Turno #${turnoId}`, html: 'Cargando línea de tiempo...', showConfirmButton: false, allowOutsideClick: false });
    try {
        const data = await apiReportes(`/caja/auditoria/${turnoId}`);
        if (data.error) throw new Error(data.error);
        const filas = (data.linea_tiempo || []).map((item) => {
            const tipo = String(item.tipo || '');
            const cls = tipo === 'RETIRO' || tipo === 'VENTA ANULADA' ? 'text-danger' : (tipo === 'VENTA' || tipo === 'INGRESO' || tipo === 'APERTURA' ? 'text-success' : '');
            return `<tr>
                <td class="small text-muted">${escHtml(item.hora)}</td>
                <td><b>${escHtml(item.accion)}</b><br><span class="small text-muted">${escHtml(item.detalle)}</span></td>
                <td class="small">${escHtml(item.metodo)}</td>
                <td class="text-end ${cls}">${plata(item.monto)}</td>
            </tr>`;
        }).join('') || `<tr><td colspan="4" class="text-muted">Sin movimientos.</td></tr>`;
        Swal.fire({
            title: `Turno #${turnoId} — ${escHtml(data.cajero || '')}`,
            width: 800,
            html: `<div class="table-responsive text-start" style="max-height:60vh">
                <table class="table table-sm mb-0">
                    <thead><tr><th>Hora</th><th>Acción</th><th>Medio</th><th class="text-end">Monto</th></tr></thead>
                    <tbody>${filas}</tbody>
                </table>
            </div>`,
        });
    } catch (e) {
        Swal.fire('Auditoría', e.message || 'No se pudo abrir el turno.', 'error');
    }
}

async function cargarReportes() {
    try {
        await Promise.all([
            cargarRentabilidad(),
            cargarRanking(),
            cargarMix(),
            cargarClavos(),
            cargarDias(),
            cargarCierres(),
        ]);
    } catch (e) {
        console.error(e);
        Swal.fire('Reportes', 'No se pudieron cargar los datos.', 'error');
    }
}

function exportarCsvRentabilidad() {
    bajarCsv(`rentabilidad_${mesElegido()}.csv`, cacheRentabilidad);
}
function exportarCsvRanking() {
    bajarCsv(`ranking_${mesElegido()}.csv`, cacheRanking);
}
function exportarCsvMix() {
    bajarCsv(`medios_pago_${mesElegido()}.csv`, cacheMix);
}
function exportarCsvClavos() {
    bajarCsv('clavos_30_dias.csv', cacheClavos);
}
function exportarCsvDias() {
    bajarCsv(`ventas_dia_${mesElegido()}.csv`, cacheDias);
}
function exportarCsvCierres() {
    bajarCsv(`cierres_${mesElegido()}.csv`, cacheCierres);
}

document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('inputMesReporte');
    if (input && !input.value) input.value = mesActualAR();
    cargarReportes();
});
