async function apiFetch(recurso, config = {}) {
    if (!config.headers) config.headers = {};
    const token = localStorage.getItem('token') || localStorage.getItem('token_pos');
    if (token) config.headers['Authorization'] = `Bearer ${token}`;
    const respuesta = await fetch(recurso, config);
    if (respuesta.status === 401) {
        localStorage.clear();
        window.location.href = 'index.html';
        throw new Error('Acceso denegado (401)');
    }
    return respuesta;
}

function htmlTxt(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function fmtCant(n) {
    const v = Number(n || 0);
    return v.toLocaleString('es-AR', { maximumFractionDigits: 3 });
}

function unidadDe(p) {
    return p.unidad_medida === 'Unidad' || !p.unidad_medida ? 'un' : p.unidad_medida;
}

let pestanaInventario = 'negativos';
let productoConteo = null;
let negativosPorId = {};
let busquedaPorId = {};

function cambiarPestanaInventario(id) {
    pestanaInventario = id;
    document.getElementById('tab-negativos').classList.toggle('d-none', id !== 'negativos');
    document.getElementById('tab-conteo').classList.toggle('d-none', id !== 'conteo');
    document.getElementById('btn-tab-negativos').classList.toggle('active', id === 'negativos');
    document.getElementById('btn-tab-conteo').classList.toggle('active', id === 'conteo');
    if (id === 'conteo') {
        cargarHistorialConteo();
        const inp = document.getElementById('inputBuscarConteo');
        if (inp) inp.focus();
    } else {
        cargarNegativos();
    }
}

async function leerJson(res) {
    const data = await res.json();
    if (!res.ok || data.error || data.detail) {
        const det = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
        throw new Error(data.error || det || 'No se pudo completar la operación.');
    }
    return data;
}

async function cargarNegativos() {
    const tbody = document.getElementById('tablaNegativosBody');
    const resumen = document.getElementById('negativosResumen');
    tbody.innerHTML = '<tr><td colspan="3" class="text-muted py-4 text-center">Cargando…</td></tr>';
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/lotes/inventario/negativos`);
        const data = await leerJson(res);
        const lista = data.productos || [];
        negativosPorId = {};
        lista.forEach((p) => { negativosPorId[p.id] = p; });
        resumen.textContent = lista.length ? `${lista.length} producto(s) con stock negativo` : 'No hay negativos';
        if (!lista.length) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-muted py-4 text-center">Nada en negativo. El libro no debe stock.</td></tr>';
            return;
        }
        const filas = lista.map((p) => {
            const stock = Number(p.stock_total || 0);
            return `<tr>
                <td>
                    <div class="fw-bold">${htmlTxt(p.nombre)}</div>
                    <div class="small text-muted">${htmlTxt(p.codigo_barras || 'Sin código')}</div>
                </td>
                <td class="text-end">
                    <span class="badge bg-danger inv-stock-neg">${fmtCant(stock)} ${htmlTxt(unidadDe(p))}</span>
                </td>
                <td>
                    <div class="inv-acciones d-flex flex-wrap justify-content-center gap-2 align-items-center">
                        <button type="button" class="btn btn-outline-dark btn-sm fw-bold" onclick="regularizarCero(${p.id})">Pasar a 0</button>
                        <input type="number" min="0" step="0.01" class="form-control form-control-sm inv-fisico text-center fw-bold" id="fisico-${p.id}" placeholder="Físico">
                        <button type="button" class="btn btn-success btn-sm fw-bold" onclick="regularizarFisico(${p.id})">Dejar físico</button>
                    </div>
                </td>
            </tr>`;
        });
        tbody.innerHTML = filas.join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-danger py-4 text-center">${htmlTxt(e.message)}</td></tr>`;
        resumen.textContent = 'Error al cargar';
    }
}

async function regularizarCero(productoId) {
    const p = negativosPorId[productoId];
    if (!p) return;
    const stockSistema = Number(p.stock_total || 0);
    const ok = await Swal.fire({
        title: '¿Borrar la deuda?',
        html: `<div class="text-start small">Sistema: <b>${fmtCant(stockSistema)}</b> en <b>${htmlTxt(p.nombre)}</b>.<br>
            Se eliminan los lotes <code>VENTA_SIN_STOCK</code>. Si hay lotes reales, quedan.<br>
            <b>Si después cargás la factura vieja de esta mercadería, duplicás stock.</b></div>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Sí, pasar a 0',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#1b365d',
        reverseButtons: true
    });
    if (!ok.isConfirmed) return;
    await enviarAjuste({ producto_id: productoId, tipo: 'NEGATIVO_CERO' }, true);
}

async function regularizarFisico(productoId) {
    const p = negativosPorId[productoId];
    if (!p) return;
    const stockSistema = Number(p.stock_total || 0);
    const inp = document.getElementById(`fisico-${productoId}`);
    const contado = parseFloat(inp && inp.value);
    if (!Number.isFinite(contado) || contado < 0) {
        return Swal.fire('Atención', 'Indicá cuánto hay en el piso (0 o más).', 'info');
    }
    const ok = await Swal.fire({
        title: '¿Dejar este físico?',
        html: `<div class="text-start small"><b>${htmlTxt(p.nombre)}</b><br>
            Sistema: <b>${fmtCant(stockSistema)}</b> → físico: <b>${fmtCant(contado)}</b><br>
            <b>No cargues después la factura vieja de estas unidades.</b></div>`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Confirmar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#198754',
        reverseButtons: true
    });
    if (!ok.isConfirmed) return;
    await enviarAjuste({ producto_id: productoId, tipo: 'NEGATIVO_FISICO', cantidad_contada: contado }, true);
}

async function buscarParaConteo() {
    const q = (document.getElementById('inputBuscarConteo').value || '').trim();
    const caja = document.getElementById('resultadosConteo');
    productoConteo = null;
    document.getElementById('fichaConteo').classList.add('d-none');
    if (!q) {
        caja.innerHTML = '<div class="text-muted small">Escribí o escaneá un código.</div>';
        return;
    }
    caja.innerHTML = '<div class="text-muted small">Buscando…</div>';
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/lotes/inventario/buscar?q=${encodeURIComponent(q)}`);
        const data = await leerJson(res);
        const lista = data.productos || [];
        busquedaPorId = {};
        lista.forEach((p) => { busquedaPorId[p.id] = p; });
        if (!lista.length) {
            caja.innerHTML = '<div class="text-muted">No hay productos con esa búsqueda.</div>';
            return;
        }
        if (lista.length === 1 && String(lista[0].codigo_barras || '') === q) {
            caja.innerHTML = '';
            mostrarFichaConteo(lista[0]);
            document.getElementById('inputBuscarConteo').select();
            return;
        }
        const items = lista.map((p) => {
            const stock = Number(p.stock_total || 0);
            const cls = stock < 0 ? 'text-danger' : 'text-dark';
            return `<button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                onclick="elegirProductoConteo(${p.id})">
                <span><b>${htmlTxt(p.nombre)}</b><br><small class="text-muted">${htmlTxt(p.codigo_barras || 'Sin código')}</small></span>
                <span class="fw-bold ${cls}">${fmtCant(stock)} ${htmlTxt(unidadDe(p))}</span>
            </button>`;
        });
        caja.innerHTML = `<div class="list-group shadow-sm">${items.join('')}</div>`;
    } catch (e) {
        caja.innerHTML = `<div class="text-danger">${htmlTxt(e.message)}</div>`;
    }
}

function elegirProductoConteo(id) {
    const p = busquedaPorId[id];
    if (p) mostrarFichaConteo(p);
}

function mostrarFichaConteo(p) {
    productoConteo = p;
    const stock = Number(p.stock_total || 0);
    const cls = stock < 0 ? 'bg-danger' : 'bg-secondary';
    document.getElementById('resultadosConteo').innerHTML = '';
    const ficha = document.getElementById('fichaConteo');
    ficha.classList.remove('d-none');
    ficha.innerHTML = `
        <div class="d-flex flex-column flex-md-row justify-content-between gap-3">
            <div>
                <div class="fw-bold fs-5">${htmlTxt(p.nombre)}</div>
                <div class="text-muted small mb-2">${htmlTxt(p.codigo_barras || 'Sin código')}</div>
                <span class="badge ${cls}">Sistema: ${fmtCant(stock)} ${htmlTxt(unidadDe(p))}</span>
                ${stock < 0 ? '<div class="small text-danger mt-2">Está en negativo. Este conteo también limpia la deuda.</div>' : ''}
            </div>
            <div class="d-flex flex-column gap-2" style="min-width: 220px;">
                <label class="form-label fw-bold small mb-0">¿Cuánto hay?</label>
                <input type="number" min="0" step="0.01" class="form-control form-control-lg text-center fw-bold" id="inputCantidadConteo" placeholder="0">
                <button type="button" class="btn btn-primary fw-bold" onclick="confirmarConteo()">Emparejar al físico</button>
            </div>
        </div>`;
    const inp = document.getElementById('inputCantidadConteo');
    if (inp) inp.focus();
}

async function confirmarConteo() {
    if (!productoConteo) return;
    const contado = parseFloat(document.getElementById('inputCantidadConteo').value);
    if (!Number.isFinite(contado) || contado < 0) {
        return Swal.fire('Atención', 'Indicá la cantidad contada.', 'info');
    }
    const sistema = Number(productoConteo.stock_total || 0);
    const dif = contado - sistema;
    let extra = 'Sin diferencia.';
    if (dif < 0) extra = `Faltan ${fmtCant(Math.abs(dif))}: se registra merma de conteo.`;
    if (dif > 0) extra = `Sobran ${fmtCant(dif)}: entra un lote de ajuste.`;
    const ok = await Swal.fire({
        title: '¿Confirmar conteo?',
        html: `<div class="text-start small"><b>${htmlTxt(productoConteo.nombre)}</b><br>
            Sistema <b>${fmtCant(sistema)}</b> → contado <b>${fmtCant(contado)}</b><br>${htmlTxt(extra)}</div>`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Confirmar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#1b365d',
        reverseButtons: true
    });
    if (!ok.isConfirmed) return;
    await enviarAjuste({
        producto_id: productoConteo.id,
        tipo: 'CONTEO',
        cantidad_contada: contado
    }, false);
}

async function enviarAjuste(body, recargarNegativos) {
    Swal.fire({ title: 'Ajustando stock…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/lotes/inventario/ajustar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await leerJson(res);
        const aviso = data.aviso_factura
            ? '<br><small>No cargues la factura vieja de esta mercadería: duplicaría el stock.</small>'
            : '';
        await Swal.fire({
            icon: 'success',
            title: data.mensaje || 'Listo',
            html: `<div class="small">Quedó en <b>${fmtCant(data.stock_nuevo)}</b> (antes ${fmtCant(data.stock_anterior)}).${aviso}</div>`
        });
        if (recargarNegativos) cargarNegativos();
        else {
            productoConteo = null;
            document.getElementById('fichaConteo').classList.add('d-none');
            document.getElementById('inputBuscarConteo').value = '';
            document.getElementById('inputBuscarConteo').focus();
            cargarHistorialConteo();
        }
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function cargarHistorialConteo() {
    const tbody = document.getElementById('tablaHistorialConteo');
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted py-3 text-center">Cargando…</td></tr>';
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/lotes/inventario/historial`);
        const data = await leerJson(res);
        const lista = data.movimientos || [];
        if (!lista.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-muted py-3 text-center">Todavía no hay conteos.</td></tr>';
            return;
        }
        const tipos = {
            NEGATIVO_CERO: 'Deuda a 0',
            NEGATIVO_FISICO: 'Físico (neg.)',
            CONTEO: 'Conteo'
        };
        const filas = lista.map((m) => {
            const dif = Number(m.diferencia || 0);
            const cls = dif < 0 ? 'text-danger' : (dif > 0 ? 'text-success' : 'text-muted');
            return `<tr>
                <td class="small">${htmlTxt(m.fecha_hora || '')}</td>
                <td><div class="fw-bold">${htmlTxt(m.nombre)}</div><div class="small text-muted">${htmlTxt(m.codigo_barras || '')}</div></td>
                <td class="small">${htmlTxt(tipos[m.tipo] || m.tipo)}</td>
                <td class="text-end">${fmtCant(m.stock_sistema)}</td>
                <td class="text-end">${fmtCant(m.cantidad_contada)}</td>
                <td class="text-end fw-bold ${cls}">${dif > 0 ? '+' : ''}${fmtCant(dif)}</td>
                <td class="small">${htmlTxt(m.usuario || '')}</td>
            </tr>`;
        });
        tbody.innerHTML = filas.join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-danger py-3 text-center">${htmlTxt(e.message)}</td></tr>`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    cargarNegativos();
    const inp = document.getElementById('inputBuscarConteo');
    if (inp) {
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                buscarParaConteo();
            }
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (document.activeElement && document.activeElement.id === 'inputCantidadConteo') {
            e.preventDefault();
            confirmarConteo();
        }
    });
});
