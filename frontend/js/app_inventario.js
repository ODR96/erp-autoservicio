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
        cargarCicloConteo();
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

async function cargarRubrosConteo() {
    const sel = document.getElementById('filtroRubroConteo');
    if (!sel || sel.dataset.listo === '1') return;
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/categorias`);
        const data = await leerJson(res);
        const opciones = (data.categorias || []).map((c) =>
            `<option value="${Number(c.id)}">${htmlTxt(c.nombre)}</option>`
        );
        sel.insertAdjacentHTML('beforeend', opciones.join(''));
        sel.dataset.listo = '1';
    } catch (e) {
        /* el filtro queda en todos los rubros */
    }
}

async function cargarCicloConteo() {
    const tbody = document.getElementById('tablaCicloConteo');
    const resumen = document.getElementById('cicloResumen');
    if (!tbody) return;
    await cargarRubrosConteo();
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted py-3 text-center">Cargando…</td></tr>';
    const rubro = document.getElementById('filtroRubroConteo')?.value || '';
    const qs = rubro ? `?categoria_id=${encodeURIComponent(rubro)}` : '';
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/lotes/inventario/ciclo${qs}`);
        const data = await leerJson(res);
        const lista = data.productos || [];
        const aviso = Number(data.dias_aviso || 0);
        if (resumen) {
            resumen.textContent = aviso
                ? `Marcado si hace ${aviso} días o más, o si nunca se contó.`
                : 'Sin aviso por días. Primero lo nunca contado.';
        }
        if (!lista.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-muted py-3 text-center">No hay productos en ese rubro.</td></tr>';
            return;
        }
        const muestraStock = lista.some((p) => Object.prototype.hasOwnProperty.call(p, 'stock_total'));
        const colSistema = document.getElementById('colSistemaCiclo');
        if (colSistema) colSistema.classList.toggle('d-none', !muestraStock);
        tbody.innerHTML = lista.map((p) => {
            const cuando = p.nunca ? 'Nunca' : htmlTxt(String(p.ultimo_conteo || '').slice(0, 16));
            const marca = p.vencido ? ' <span class="badge text-bg-warning">Toca contar</span>' : '';
            busquedaPorId[p.id] = p;
            return `<tr>
                <td><b>${htmlTxt(p.nombre)}</b><br><small class="text-muted">${htmlTxt(p.codigo_barras || 'Sin código')} · ${htmlTxt(p.categoria || '')}</small></td>
                <td class="small">${cuando}${marca}</td>
                ${muestraStock ? `<td class="text-end">${fmtCant(p.stock_total)} ${htmlTxt(unidadDe(p))}</td>` : '<td class="d-none"></td>'}
                <td class="text-end"><button type="button" class="btn btn-sm btn-primary fw-bold" onclick="elegirProductoConteo(${Number(p.id)})">Contar</button></td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-danger py-3">${htmlTxt(e.message)}</td></tr>`;
    }
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
            const ve = Object.prototype.hasOwnProperty.call(p, 'stock_total');
            const stock = ve ? Number(p.stock_total || 0) : null;
            const cls = stock < 0 ? 'text-danger' : 'text-dark';
            return `<button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                onclick="elegirProductoConteo(${p.id})">
                <span><b>${htmlTxt(p.nombre)}</b><br><small class="text-muted">${htmlTxt(p.codigo_barras || 'Sin código')}</small></span>
                ${ve ? `<span class="fw-bold ${cls}">${fmtCant(stock)} ${htmlTxt(unidadDe(p))}</span>` : ''}
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
    const veSistema = Object.prototype.hasOwnProperty.call(p, 'stock_total');
    const stock = veSistema ? Number(p.stock_total || 0) : null;
    const cls = stock < 0 ? 'bg-danger' : 'bg-secondary';
    document.getElementById('resultadosConteo').innerHTML = '';
    const ficha = document.getElementById('fichaConteo');
    ficha.classList.remove('d-none');
    ficha.innerHTML = `
        <div class="d-flex flex-column flex-md-row justify-content-between gap-3">
            <div>
                <div class="fw-bold fs-5">${htmlTxt(p.nombre)}</div>
                <div class="text-muted small mb-2">${htmlTxt(p.codigo_barras || 'Sin código')}</div>
                ${veSistema
                    ? `<span class="badge ${cls}">Sistema: ${fmtCant(stock)} ${htmlTxt(unidadDe(p))}</span>
                       ${stock < 0 ? '<div class="small text-danger mt-2">Está en negativo. Este conteo también limpia la deuda.</div>' : ''}`
                    : '<div class="small text-muted">Contá sin mirar el sistema. El resultado se ve al confirmar.</div>'}
            </div>
            <div class="d-flex flex-column gap-2" style="min-width: 220px;">
                <label class="form-label fw-bold small mb-0">¿Cuánto hay en total?</label>
                <input type="number" min="0" step="0.01" class="form-control form-control-lg text-center fw-bold" id="inputCantidadConteo" placeholder="Un solo número">
                <div class="small text-muted">O sumá zonas. El stock no se toca hasta confirmar.</div>
                <div class="input-group">
                    <input type="text" id="inputZonaConteo" class="form-control" maxlength="40" placeholder="Zona" autocomplete="off">
                    <input type="number" min="0" step="0.01" id="inputCantZona" class="form-control" placeholder="Cant.">
                    <button type="button" class="btn btn-outline-primary" onclick="guardarZonaConteo()">Sumar</button>
                </div>
                <div id="listaZonasConteo"></div>
                <div id="totalZonasConteo" class="fw-bold small"></div>
                <button type="button" class="btn btn-primary fw-bold" onclick="confirmarConteo()">Emparejar al físico</button>
            </div>
        </div>`;
    const inp = document.getElementById('inputCantidadConteo');
    if (inp) inp.focus();
    refrescarZonasConteo();
}

let zonasConteo = [];

async function refrescarZonasConteo() {
    if (!productoConteo) return;
    const res = await apiFetch(`${obtenerBaseUrl()}/lotes/inventario/zonas/${productoConteo.id}`);
    const data = await leerJson(res);
    zonasConteo = data.zonas || [];
    const caja = document.getElementById('listaZonasConteo');
    const tot = document.getElementById('totalZonasConteo');
    if (!caja) return;
    if (!zonasConteo.length) {
        caja.innerHTML = '';
        if (tot) tot.textContent = '';
        return;
    }
    caja.innerHTML = zonasConteo.map((z) => `
        <div class="d-flex justify-content-between align-items-center border-bottom py-1 small">
            <span>${htmlTxt(z.zona)}${z.vieja ? ' <span class="badge text-bg-warning">Otro día</span>' : ''}<br><span class="text-muted">${htmlTxt(String(z.fecha_hora || '').slice(0, 16))}</span></span>
            <span><b>${fmtCant(z.cantidad)}</b>
                <button type="button" class="btn btn-sm btn-link text-danger p-0 ms-2" onclick="borrarZonaConteo(${Number(z.id)})">Quitar</button>
            </span>
        </div>`).join('');
    if (tot) tot.textContent = `Total zonas: ${fmtCant(data.total)}`;
}

async function guardarZonaConteo() {
    if (!productoConteo) return;
    const zona = (document.getElementById('inputZonaConteo').value || '').trim();
    const cantidad = parseFloat(document.getElementById('inputCantZona').value);
    if (!zona) return Swal.fire('Atención', 'Escribí el nombre de la zona.', 'info');
    if (!Number.isFinite(cantidad) || cantidad < 0) return Swal.fire('Atención', 'Indicá la cantidad de esa zona.', 'info');
    const res = await apiFetch(`${obtenerBaseUrl()}/lotes/inventario/zona`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ producto_id: productoConteo.id, zona, cantidad })
    });
    await leerJson(res);
    document.getElementById('inputZonaConteo').value = '';
    document.getElementById('inputCantZona').value = '';
    await refrescarZonasConteo();
}

async function borrarZonaConteo(id) {
    const res = await apiFetch(`${obtenerBaseUrl()}/lotes/inventario/zona/${id}`, { method: 'DELETE' });
    await leerJson(res);
    await refrescarZonasConteo();
}

async function confirmarConteo() {
    if (!productoConteo) return;
    if (zonasConteo.length) {
        const okZ = await Swal.fire({
            title: '¿Confirmar la suma de las zonas?',
            html: `<div class="text-start small"><b>${htmlTxt(productoConteo.nombre)}</b><br>Total contado <b>${fmtCant(zonasConteo.reduce((a, z) => a + Number(z.cantidad || 0), 0))}</b></div>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Confirmar',
            cancelButtonText: 'Cancelar',
            confirmButtonColor: '#1b365d',
            reverseButtons: true
        });
        if (!okZ.isConfirmed) return;
        await enviarAjuste({ producto_id: productoConteo.id, tipo: 'CONTEO' }, false);
        return;
    }
    const contado = parseFloat(document.getElementById('inputCantidadConteo').value);
    if (!Number.isFinite(contado) || contado < 0) {
        return Swal.fire('Atención', 'Indicá la cantidad contada.', 'info');
    }
    const veSistema = Object.prototype.hasOwnProperty.call(productoConteo, 'stock_total');
    const sistema = veSistema ? Number(productoConteo.stock_total || 0) : null;
    const dif = veSistema ? contado - sistema : null;
    let extra = 'Sin diferencia.';
    if (dif === null) extra = 'El sistema se compara al confirmar.';
    else if (dif < 0) extra = `Faltan ${fmtCant(Math.abs(dif))}: se registra merma de conteo.`;
    else if (dif > 0) extra = `Sobran ${fmtCant(dif)}: entra un lote de ajuste.`;
    const ok = await Swal.fire({
        title: '¿Confirmar conteo?',
        html: `<div class="text-start small"><b>${htmlTxt(productoConteo.nombre)}</b><br>
            ${veSistema ? `Sistema <b>${fmtCant(sistema)}</b> → ` : ''}contado <b>${fmtCant(contado)}</b><br>${htmlTxt(extra)}</div>`,
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
            cargarCicloConteo();
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
