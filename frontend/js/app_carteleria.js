let catalogoLocal = [];
let productoSeleccionado = null;
let colaImpresion = []; 
const colorInstitucional = "#1b365d";

let indiceBusqueda = -1;
let itemsBusquedaActuales = [];

async function apiFetch(recurso, config = {}) {
    if (!config.headers) config.headers = {};
    const token = localStorage.getItem('token') || localStorage.getItem('token_pos');
    if (token) config.headers['Authorization'] = `Bearer ${token}`;
    
    const respuesta = await fetch(recurso, config);
    if (respuesta.status === 401) {
        console.warn("Sesión expirada o sin permisos (401)");
        localStorage.clear();
        window.location.href = 'index.html'; 
        throw new Error("Acceso denegado (401)");
    }
    return respuesta;
}

/** Lee el JSON y corta con el mensaje del servidor ({detail} o {error}). */
async function leerRespuesta(res, porDefecto) {
    let data = {};
    try { data = await res.json(); } catch (e) { /* cuerpo vacío o no JSON */ }
    if (!res.ok || data.error) {
        const detalle = typeof data.detail === 'string' ? data.detail : '';
        throw new Error(data.error || detalle || porDefecto);
    }
    return data;
}

const COPIAS_MAX = 50;

// --- 1. ARRANQUE Y CARGA DE DATOS ---
document.addEventListener("DOMContentLoaded", async () => {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/sincronizar_catalogo`);
        const data = await leerRespuesta(res, 'No se pudo leer el catálogo.');
        catalogoLocal = data.productos || [];
    } catch (e) {
        Swal.fire('Error', `${e.message} El buscador queda vacío; recargá la página.`, 'error');
    }
    try {
        await refrescarConfigCarteleria();
        await cargarCategoriasCarteleria();
        await cargarColaDesdeDB();
        await cargarPromosVencidas();
        const inpPalabra = document.getElementById('palabraMasivoCarteleria');
        if (inpPalabra) {
            inpPalabra.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    encolarMasivoCarteleria();
                }
            });
        }
    } catch (e) { console.error("Error cargando cola o rubros", e); }

    document.addEventListener('click', (e) => {
        const panel = document.getElementById('panelBuscador');
        if (panel && !panel.contains(e.target)) cerrarResultadosBusqueda();
    });
    window.addEventListener('beforeunload', (e) => {
        if (colaImpresion.some((c) => c.esLibre)) { e.preventDefault(); e.returnValue = ''; }
    });
});

// --- PROMOS DEL PRODUCTO PARA EL CARTEL ---
function fechaHoyARCartel() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

function fmtDiaMes(iso) {
    if (!iso) return '';
    const [, m, d] = String(iso).split('-');
    return `${d}/${m}`;
}

/** Lo que vale hoy: oferta (volumen de 1), pack y volumen mayorista. */
function promoCartel(p) {
    const hoy = fechaHoyARCartel();
    const reglas = ((p && p.reglas_mayoristas) || []).filter((r) =>
        (!r.fecha_desde || r.fecha_desde <= hoy) && (!r.fecha_hasta || r.fecha_hasta >= hoy)
    );
    const volumenes = reglas.filter((r) => (r.tipo || 'VOLUMEN') === 'VOLUMEN');
    const oferta = volumenes.filter((r) => Number(r.cantidad_minima) <= 1)
        .sort((a, b) => a.precio_oferta_unitario - b.precio_oferta_unitario)[0] || null;
    const volumen = volumenes.filter((r) => Number(r.cantidad_minima) > 1)
        .sort((a, b) => a.cantidad_minima - b.cantidad_minima)[0] || null;
    const pack = reglas.find((r) => r.tipo === 'PACK' && Number(r.precio_pack) > 0) || null;
    return { oferta, volumen, pack };
}

function tienePromoCartel(p) {
    const pr = promoCartel(p);
    return !!(pr.pack || pr.volumen);
}

function nombrePackCartel(n, precioPack, lista) {
    if (lista > 0 && Math.abs(precioPack - lista * (n - 1)) < 0.005) return `${n}x${n - 1}`;
    return `${n} x $${fmtPrecioCartel(precioPack)}`;
}

/**
 * Arma el cartel de un producto del catálogo: precio de hoy, tachado, pack/volumen y "válido hasta".
 * precioAntesManual manda sobre el tachado automático de la oferta.
 */
function armarItemProducto(pReal, base) {
    const item = { ...base };
    const lista = Number(pReal ? pReal.precio_venta_final : item.precio) || 0;
    item.precio = lista;
    item.uxb = (pReal && pReal.unidades_por_bulto) || 1;
    delete item.precioMayo; delete item.cantMayo; delete item.pack; delete item.txtBulto; delete item.hasta;
    if (!pReal) return item;

    const pr = promoCartel(pReal);
    const fechas = [];
    let antesAuto = null;
    if (pr.oferta) {
        item.precio = Number(pr.oferta.precio_oferta_unitario);
        antesAuto = lista;
        if (pr.oferta.fecha_hasta) fechas.push(pr.oferta.fecha_hasta);
    }
    if (pr.pack) {
        const n = Number(pr.pack.cantidad_minima);
        item.pack = { n, precio: Number(pr.pack.precio_pack), nombre: nombrePackCartel(n, Number(pr.pack.precio_pack), lista) };
        if (pr.pack.fecha_hasta) fechas.push(pr.pack.fecha_hasta);
    } else if (pr.volumen) {
        item.precioMayo = Number(pr.volumen.precio_oferta_unitario);
        item.cantMayo = pr.volumen.cantidad_minima;
        if (pr.volumen.fecha_hasta) fechas.push(pr.volumen.fecha_hasta);
    }
    if (fechas.length) item.hasta = fechas.sort()[0];

    // Regla: A4 multiplica por bulto, Cenefas NO. El pack se anuncia por unidad.
    if (item.uxb > 1 && item.formato === 'Cartel_A4' && !item.pack) {
        item.precio = item.precio * item.uxb;
        if (antesAuto) antesAuto = antesAuto * item.uxb;
        item.txtBulto = `PRECIO X CAJA CERRADA (${item.uxb} un.)`;
        if (item.precioMayo) item.precioMayo = item.precioMayo * item.uxb;
    }
    if (!(Number(item.precio_falso) > 0) && antesAuto) item.precio_falso = antesAuto;
    return item;
}

function htmlHastaCartel(hasta, tam) {
    return hasta ? `<div style="font-size:${tam}; font-weight:bold; color:#dc3545; text-align:center;">Válido hasta el ${fmtDiaMes(hasta)}</div>` : '';
}

/** Filas viejas: "Cenefa" se vuelve doble si el producto tiene promo; cualquier otro texto es A4. */
function formatoDesdeDB(tipo, pReal) {
    if (tipo === 'Cenefa_Normal' || tipo === 'Cenefa_Doble' || tipo === 'Cartel_A4') return tipo;
    if (tipo === 'Cenefa') return tienePromoCartel(pReal) ? 'Cenefa_Doble' : 'Cenefa_Normal';
    return 'Cartel_A4';
}

async function cargarColaDesdeDB() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/etiquetas/listar`);
        const data = await leerRespuesta(res, 'No se pudo leer la cola de impresión.');
        const itemsDB = (data.cola || []).map(c => {
            const pReal = catalogoLocal.find(p => p.id === c.producto_id);
            return armarItemProducto(pReal, {
                id_db: c.cola_id, formato: formatoDesdeDB(c.formato, pReal), copias: c.cantidad,
                textoExtra: c.texto_personalizado || '', esLibre: false, nombre: c.nombre, precio: c.precio_venta_final,
                codigo_barras: c.codigo_barras, producto_id: c.producto_id,
                precio_falso: Number(c.precio_antes) > 0 ? Number(c.precio_antes) : null
            });
        });

        colaImpresion = colaImpresion.filter(c => c.esLibre); 
        colaImpresion = [...itemsDB, ...colaImpresion];
        dibujarCola();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function refrescarConfigCarteleria() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/config/leer`);
        if (res.ok) {
            const cfg = await res.json();
            localStorage.setItem('config_negocio', JSON.stringify(cfg));
        }
    } catch (e) { /* usa lo que haya en localStorage */ }
    const caja = document.getElementById('carteleriaMembrete');
    if (caja) caja.textContent = `Membrete: ${nombreNegocio()}`;
}

function htmlTxtCartel(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function fmtPrecioCartel(n) {
    return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function htmlPrecioAntesAhora(precioAhora, precioAntes, opts) {
    const ahora = fmtPrecioCartel(precioAhora);
    const antesN = Number(precioAntes);
    const ahoraN = Number(precioAhora);
    const tamAntes = (opts && opts.antes) || '12px';
    const tamAhora = (opts && opts.ahora) || '32px';
    const colorAhora = (opts && opts.colorAhora) || '#000';
    const bloqueAhora = `<div style="font-size:${tamAhora}; font-weight:900; color:${colorAhora}; line-height:1;">$${ahora}</div>`;
    if (!Number.isFinite(antesN) || antesN <= 0 || Math.abs(antesN - ahoraN) < 0.01) {
        return bloqueAhora;
    }
    return `<div style="text-decoration:line-through; color:#888; font-size:${tamAntes}; font-weight:600; line-height:1;">$${fmtPrecioCartel(antesN)}</div>
            ${bloqueAhora}`;
}

// ESCUDO DEL BUSCADOR
document.getElementById('inputBuscarEtiqueta').addEventListener('input', (e) => {
    buscarProductoEtiqueta(e.target.value);
});

function toggleModoLibre() {
    const esLibre = document.getElementById('switchModoLibre').checked;
    document.getElementById('panelBuscador').classList.toggle('d-none', esLibre);
    document.getElementById('panelLibre').classList.toggle('d-none', !esLibre);
    productoSeleccionado = null;
    document.getElementById('inputBuscarEtiqueta').value = "";
    actualizarPreview();
}

function buscarProductoEtiqueta(busqueda) {
    const contenedor = document.getElementById('resultadosEtiqueta');
    indiceBusqueda = -1; 
    if (busqueda.length < 2) { cerrarResultadosBusqueda(); return; }

    let palabras = busqueda.toLowerCase().split(" ").filter(p => p !== "");
    const filtrados = catalogoLocal.filter(p => {
        return palabras.every(pal => p.nombre.toLowerCase().includes(pal) || (p.codigo_barras && p.codigo_barras.includes(pal)));
    }).slice(0, 8);
    
    itemsBusquedaActuales = filtrados;
    if (filtrados.length === 0) {
        contenedor.innerHTML = '<div class="list-group-item small py-2 text-muted">Sin resultados.</div>';
    } else {
        contenedor.innerHTML = filtrados.map((p, idx) =>
            `<button type="button" id="btn-busq-${idx}" class="list-group-item list-group-item-action small py-2" onmouseenter="indiceBusqueda = ${idx}; resaltarBusqueda();" onclick="seleccionarProd(${Number(p.id)})"><b>${htmlTxtCartel(p.codigo_barras || 'S/C')}</b> - ${htmlTxtCartel(p.nombre)}</button>`
        ).join('');
    }
    contenedor.classList.remove('d-none');
}

function cerrarResultadosBusqueda() {
    const contenedor = document.getElementById('resultadosEtiqueta');
    if (contenedor) contenedor.classList.add('d-none');
    itemsBusquedaActuales = [];
    indiceBusqueda = -1;
}

document.getElementById('inputBuscarEtiqueta').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { cerrarResultadosBusqueda(); return; }
    if (itemsBusquedaActuales.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (indiceBusqueda < itemsBusquedaActuales.length - 1) indiceBusqueda++; resaltarBusqueda(); } 
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (indiceBusqueda > 0) indiceBusqueda--; resaltarBusqueda(); } 
    else if (e.key === 'Enter') { e.preventDefault(); if (indiceBusqueda >= 0) { seleccionarProd(itemsBusquedaActuales[indiceBusqueda].id); } else if (itemsBusquedaActuales.length === 1) { seleccionarProd(itemsBusquedaActuales[0].id); } }
});

function resaltarBusqueda() {
    document.querySelectorAll('#resultadosEtiqueta button').forEach(btn => btn.classList.remove('active', 'bg-primary', 'text-white'));
    if (indiceBusqueda >= 0) { const btnActivo = document.getElementById(`btn-busq-${indiceBusqueda}`); if (btnActivo) btnActivo.classList.add('active', 'bg-primary', 'text-white'); }
}

function seleccionarProd(id) {
    productoSeleccionado = catalogoLocal.find(p => p.id === id);
    if (!productoSeleccionado) return;
    document.getElementById('inputBuscarEtiqueta').value = productoSeleccionado.nombre;
    cerrarResultadosBusqueda();
    document.getElementById('selectFormato').value = tienePromoCartel(productoSeleccionado) ? 'Cenefa_Doble' : 'Cenefa_Normal';
    actualizarPreview();
}

function actualizarPreview() {
    const preview = document.getElementById('previewCanva');
    const formato = document.getElementById('selectFormato').value;
    const esLibre = document.getElementById('switchModoLibre').checked;
    const textoExtra = document.getElementById('inputTextoExtra').value.toUpperCase();
    const logo = urlLogoNegocio();
    const local = nombreNegocio();
    const precioManual = parseFloat(document.getElementById('inputPrecioFalso').value) || null;

    let it = { nombre: "SELECCIONE PRODUCTO", precio: 0, uxb: 1, formato, precio_falso: precioManual };
    if (esLibre) {
        it.nombre = document.getElementById('libreTitulo').value || "TÍTULO MANUAL";
        it.precio = parseFloat(document.getElementById('librePrecio').value) || 0;
    } else if (productoSeleccionado) {
        it = armarItemProducto(productoSeleccionado, { ...it, nombre: productoSeleccionado.nombre });
    }
    const { nombre, precio, uxb, pack } = it;
    const precioAntes = it.precio_falso;
    const esMayorista = !!it.cantMayo;
    const precioMayo = it.precioMayo || 0;
    const cantMayo = it.cantMayo || 0;

    const bloquePrecio = htmlPrecioAntesAhora(precio, precioAntes, { antes: '7px', ahora: '16px' });
    const hastaChico = htmlHastaCartel(it.hasta, '5px');
    let html = "";

    // LÓGICA DE UXB PARA VISTA PREVIA (Solo visible en Cenefa Doble)
    let previewPrecioBulto = esMayorista ? (precioMayo * uxb) : (precio * uxb);
    let htmlUxB_preview = (uxb > 1 && formato === "Cenefa_Doble" && !pack) ? `<div style="background:white; color:${colorInstitucional}; font-size:6px; font-weight:bold; padding:1px 4px; border-radius:3px; margin-top:2px;">UxB: ${uxb} | Caja: $${fmtPrecioCartel(previewPrecioBulto)}</div>` : '';

    if (formato === "Cenefa_Normal") {
        const etiquetaPack = pack ? `<div style="background:${colorInstitucional}; color:white; font-size:6px; font-weight:bold; padding:1px 5px; border-radius:3px; margin-top:2px;">${htmlTxtCartel(pack.nombre)}</div>` : '';
        html = `<div style="width: 150px; height: 70px; border: 1px solid #ccc; background: white; display:flex; flex-direction:column; align-items:center; position:relative;">
                    <div style="background:${colorInstitucional}; width:100%; color:white; font-size:5px; text-align:center; padding:1px 0;">${htmlTxtCartel(local.toUpperCase())}</div>
                    ${textoExtra ? `<div style="background:#dc3545; color:white; font-size:6px; padding:2px 5px; border-radius:3px; margin-top:2px;">${htmlTxtCartel(textoExtra)}</div>` : ''}
                    ${etiquetaPack}
                    <div style="font-size: 8px; font-weight:bold; margin-top:auto; text-align:center; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${htmlTxtCartel(nombre)}</div>
                    <div style="margin-top:auto; padding-bottom:2px; text-align:center;">${bloquePrecio}${hastaChico}</div>
                </div>`;
    } else if (formato === "Cenefa_Doble") {
        let mitadDerecha;
        if (pack) {
            mitadDerecha = `<div style="width:50%; background:${colorInstitucional}; color:white; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                <span style="background:#dc3545; border-radius:5px; padding:1px 4px; font-size:5px; margin-bottom:2px;">PROMO</span>
                <span style="font-size:16px; font-weight:900;">${htmlTxtCartel(pack.nombre)}</span>
                <span style="font-size:6px;">Llevando ${pack.n}: $${fmtPrecioCartel(pack.precio)}</span>
               </div>`;
        } else if (esMayorista) {
            mitadDerecha = `<div style="width:50%; background:${colorInstitucional}; color:white; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                <span style="background:#dc3545; border-radius:5px; padding:1px 4px; font-size:5px; margin-bottom:2px;">OFERTA MAYORISTA</span>
                <span style="font-size:14px; font-weight:bold;">$${fmtPrecioCartel(precioMayo)}</span>
                <span style="font-size:6px;">Llevando ${htmlTxtCartel(cantMayo)} o más</span>
                ${htmlUxB_preview}
               </div>`;
        } else {
            mitadDerecha = `<div style="width:50%; background:${colorInstitucional}; color:white; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                <span style="font-size:16px; font-weight:bold;">$${fmtPrecioCartel(precio)}</span>
                ${htmlUxB_preview}
               </div>`;
        }
            
        html = `<div style="width: 250px; height: 60px; border: 1px solid #333; display:flex; background:white;">
                    <div style="width:50%; padding:5px; text-align:center; display:flex; flex-direction:column; justify-content:center;">
                        ${textoExtra ? `<div style="font-size:6px; color:#dc3545; font-weight:bold;">${htmlTxtCartel(textoExtra)}</div>` : '<div style="font-size:6px; color:#666; font-weight:bold;">PRECIO NORMAL</div>'}
                        <div style="font-size:8px; font-weight:bold;">${htmlTxtCartel(nombre)}</div>
                        <div style="font-size:12px; font-weight:bold; text-align:center;">${htmlPrecioAntesAhora(precio, precioAntes, { antes: '6px', ahora: '12px' })}</div>
                        ${hastaChico}
                    </div>
                    ${mitadDerecha}
                </div>`;
    } else if (formato === "Cartel_A4") {
        const cabecera = logo
            ? `<img src="${logo}" style="max-height:36px; max-width:90%; object-fit:contain; margin-bottom:6px;">`
            : `<div style="font-size:9px; font-weight:bold; color:${colorInstitucional}; text-align:center;">${htmlTxtCartel(local)}</div>`;
        const bloquePromoA4 = pack
            ? `<div style="background:${colorInstitucional}; color:white; border-radius:6px; padding:4px 8px; margin-top:6px; text-align:center;"><div style="font-size:16px; font-weight:900;">${htmlTxtCartel(pack.nombre)}</div><div style="font-size:7px;">Llevando ${pack.n}: $${fmtPrecioCartel(pack.precio)}</div></div>`
            : (esMayorista ? `<div style="background:${colorInstitucional}; color:white; border-radius:6px; padding:4px 8px; margin-top:6px; text-align:center; font-size:7px;">LLEVANDO ${htmlTxtCartel(cantMayo)}: <b>$${fmtPrecioCartel(precioMayo)} c/u</b></div>` : '');
        html = `<div style="width: 170px; height: 240px; border: 3px solid ${colorInstitucional}; border-radius:8px; background:white; display:flex; flex-direction:column; align-items:center; padding:10px;">
                    ${cabecera}
                    <div style="font-size:11px; font-weight:bold; text-align:center; margin-top:8px;">${htmlTxtCartel(nombre)}</div>
                    ${it.txtBulto ? `<div style="font-size:6px; color:red; font-weight:bold;">${htmlTxtCartel(it.txtBulto)}</div>` : ''}
                    <div style="margin-top:auto; text-align:center; color:#198754;">${htmlPrecioAntesAhora(precio, precioAntes, { antes: '11px', ahora: '22px', colorAhora: '#198754' })}</div>
                    ${bloquePromoA4}
                    ${htmlHastaCartel(it.hasta, '7px')}
                </div>`;
    }
    preview.innerHTML = html;
}

const procesarFotoBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result); reader.onerror = reject;
});

async function agregarACola() {
    const esLibre = document.getElementById('switchModoLibre').checked;
    const formato = document.getElementById('selectFormato').value;
    const copiasTxt = String(document.getElementById('inputCopias').value || '').trim();
    const copias = Number(copiasTxt);
    if (!/^\d+$/.test(copiasTxt) || copias < 1 || copias > COPIAS_MAX) {
        return Swal.fire('Aviso', `Las copias van de 1 a ${COPIAS_MAX}.`, 'warning');
    }
    const textoExtra = document.getElementById('inputTextoExtra').value.trim();
    const pfNum = parseFloat(document.getElementById('inputPrecioFalso').value);
    const pf = Number.isFinite(pfNum) && pfNum > 0 ? pfNum : null;
    
    let item = { id: Date.now(), formato, copias, textoExtra, esLibre, uxb: 1, precio_falso: pf };

    if (esLibre) {
        item.nombre = document.getElementById('libreTitulo').value || "Cartel Manual";
        item.precio = document.getElementById('librePrecio').value || 0;
        item.codigo_barras = "";
        const inputFotoLibre = document.getElementById('libreFoto');
        if (inputFotoLibre && inputFotoLibre.files.length > 0) {
            item.fotoManual = await procesarFotoBase64(inputFotoLibre.files[0]);
        }
    } else if (!productoSeleccionado) {
        return Swal.fire('Aviso', 'Seleccioná un producto primero.', 'warning');
    }

    // Los de catálogo se guardan en el servidor; promo, bulto y fechas se arman al leer la cola.
    if (!esLibre) {
        try {
            const res = await apiFetch(`${obtenerBaseUrl()}/productos/etiquetas/encolar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    producto_id: productoSeleccionado.id,
                    tipo_cartel: formato,
                    cantidad_copias: copias,
                    texto_personalizado: textoExtra,
                    plantilla: 'Clasica',
                    color_tema: '#1a365d',
                    precio_antes: pf
                })
            });
            await leerRespuesta(res, 'No se pudo guardar en la cola.');
            await cargarColaDesdeDB();
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Agregado a la cola', showConfirmButton: false, timer: 1000 });
            return;
        } catch (e) {
            return Swal.fire('Error', e.message || 'No se pudo guardar en la cola.', 'error');
        }
    }

    colaImpresion.push(item); dibujarCola();
    Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Agregado. Es manual: se pierde si recargás la página.', showConfirmButton: false, timer: 2500 });
}

async function vaciarCola() { 
    if (colaImpresion.length === 0) return Swal.fire('Aviso', 'La cola ya está vacía.', 'info');
    const ok = await Swal.fire({
        title: `¿Vaciar la cola?`,
        text: `Se borran ${colaImpresion.length} carteles sin imprimir.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Sí, vaciar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#dc3545',
        reverseButtons: true
    });
    if (!ok.isConfirmed) return;
    try { 
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/etiquetas/vaciar`, { method: 'DELETE' }); 
        await leerRespuesta(res, 'No se pudo vaciar la cola.');
        colaImpresion = []; dibujarCola(); 
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    } 
}

async function borrarItemCola(idx) { 
    const item = colaImpresion[idx];
    if (!item) return;
    if (!item.esLibre && item.id_db) { 
        try { 
            const res = await apiFetch(`${obtenerBaseUrl()}/productos/etiquetas/eliminar/${item.id_db}`, { method: 'DELETE' }); 
            await leerRespuesta(res, 'No se pudo borrar el cartel.');
        } catch (e) {
            return Swal.fire('Error', e.message, 'error');
        } 
    }
    colaImpresion.splice(idx, 1); dibujarCola(); 
}

function dibujarCola() {
    const tbody = document.querySelector('#tablaCola tbody'); 
    tbody.innerHTML = '';
    
    if (colaImpresion.length === 0) { 
        tbody.innerHTML = '<tr><td colspan="5" class="text-muted py-5">No hay carteles en cola.</td></tr>'; 
        return; 
    }
    
    colaImpresion.forEach((c, idx) => {
        let badge = c.formato.includes("Normal") ? "bg-secondary" : (c.formato.includes("Doble") ? "bg-primary" : "bg-success");
        let txtDB = c.id_db ? '<i class="bi bi-robot text-primary" title="Automático"></i>' : '';
        let fotito = c.fotoManual ? '<i class="bi bi-image text-info ms-1"></i>' : '';
        const badgeFalso = c.precio_falso
            ? `<div class="small text-muted text-decoration-line-through">$${fmtPrecioCartel(c.precio_falso)}</div>`
            : '';
        const extraCola = [
            c.pack ? htmlTxtCartel(c.pack.nombre) : '',
            c.cantMayo ? `Llevando ${htmlTxtCartel(c.cantMayo)}` : '',
            c.hasta ? `Hasta ${fmtDiaMes(c.hasta)}` : ''
        ].filter(Boolean).join(' · ');

        tbody.innerHTML += `
        <tr>
            <td class="text-start ps-3 fw-bold">${txtDB} ${htmlTxtCartel(c.nombre)} ${fotito}${extraCola ? `<div class="small fw-normal text-muted">${extraCola}</div>` : ''}</td>
            <td class="text-success fw-bold">${badgeFalso}$${fmtPrecioCartel(c.precio)}</td>
            <td><span class="badge ${badge}">${c.formato.replace('_', ' ')}</span></td>
            <td class="fw-bold">${c.copias}</td>
            <td><button class="btn btn-sm text-danger border-0" onclick="borrarItemCola(${idx})"><i class="bi bi-trash"></i></button></td>
        </tr>`;
    });
}

function imprimirTodo(filtroSeleccionado) {
    if (colaImpresion.length === 0) return Swal.fire('Aviso', 'La cola está vacía.', 'warning');
    const zona = document.getElementById('zonaImpresion');
    const logo = urlLogoNegocio();
    const local = nombreNegocio();

    // FILTRADO INTELIGENTE (Ahora sí recibe el parámetro del botón)
    let listaAImprimir = colaImpresion;
    if (filtroSeleccionado === 'Cenefas') {
        listaAImprimir = colaImpresion.filter(i => i.formato.includes("Cenefa"));
    } else if (filtroSeleccionado === 'A4') {
        listaAImprimir = colaImpresion.filter(i => i.formato === "Cartel_A4");
    }

    if (listaAImprimir.length === 0) return Swal.fire('Aviso', `No hay carteles del tipo ${filtroSeleccionado} en la cola.`, 'info');
    
    let html = `
        <style>
            .hoja-cenefas { width: 210mm; display: flex; flex-wrap: wrap; justify-content: flex-start; align-content: flex-start; text-align: left; background: #fff; }
            .cenefa { page-break-after: auto; box-sizing: border-box; overflow: hidden; }
            .cenefa-normal { display: flex; flex-direction: column; width: 50%; height: 42mm; padding: 1.5mm; margin: 0; }
            .cenefa-doble { display: flex; width: 100%; height: 42mm; margin: 2mm 0; padding: 0 5mm; }
            .cenefa-normal > .cenefa-cuerpo, .cenefa-doble > .cenefa-cuerpo { width: 100%; height: 100%; }
            @media print {
                @page { size: A4 portrait; margin: 0; }
                body { margin: 0; background: white !important; font-family: Arial, sans-serif; }
                #app-container, .main-wrapper, .modal, .d-print-none, .swal2-container { display: none !important; }
                #zonaImpresion { display: block !important; visibility: visible !important; position: absolute; left: 0; top: 0; width: 210mm; }
                .cartel { page-break-inside: avoid; box-sizing: border-box; overflow: hidden; background: white !important; }
                .cartel:not(.cenefa) { page-break-after: always; margin: 0 auto; }
                .hoja-cenefas { width: 210mm; }
                .bg-print { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                .truncate-lines { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; }
            }
        </style>
    `;

    let htmlCenefas = '';
    let htmlA4s = '';

    listaAImprimir.forEach((item, idx) => {
        const pF = fmtPrecioCartel(item.precio);
        const bloquePrecioCenefa = htmlPrecioAntesAhora(item.precio, item.precio_falso, { antes: '11px', ahora: '32px' });
        const bloquePrecioDoble = htmlPrecioAntesAhora(item.precio, item.precio_falso, { antes: '12px', ahora: '28px' });
        const bloquePrecioA4 = htmlPrecioAntesAhora(item.precio, item.precio_falso, { antes: '28px', ahora: 'inherit', colorAhora: '#198754' });
        let txExtra = item.textoExtra ? `<div class="bg-print" style="background:#dc3545; color:white; font-size:10px; font-weight:bold; text-align:center; text-transform:uppercase; padding:2px 5px; border-radius:3px; margin-bottom:2px;">${htmlTxtCartel(item.textoExtra)}</div>` : '';
        
        let uxb = item.uxb || 1;
        let precioBultoNum = item.cantMayo ? (item.precioMayo * uxb) : (item.precio * uxb);
        let htmlUxB_print = (uxb > 1 && item.formato === "Cenefa_Doble" && !item.pack) ? `<div class="bg-print" style="background:white; color:${colorInstitucional}; font-size:10px; font-weight:bold; padding:2px 8px; border-radius:4px; margin-top:2px;">UxB: ${uxb} | Caja: $${fmtPrecioCartel(precioBultoNum)}</div>` : '';
        const hastaPrint = htmlHastaCartel(item.hasta, '9px');
        const packChico = item.pack ? `<div class="bg-print" style="background:${colorInstitucional}; color:white; font-size:11px; font-weight:900; text-align:center; padding:2px 8px; border-radius:4px; margin-bottom:2px;">${htmlTxtCartel(item.pack.nombre)}</div>` : '';

        let bultoHTML = item.txtBulto ? `<div style="font-size:12px; color:red; font-weight:bold; margin-bottom:2px; text-align:center;">${item.txtBulto}</div>` : '';

        for (let i = 0; i < item.copias; i++) {
            if (item.formato === "Cenefa_Normal") {
                htmlCenefas += `
                    <div class="cartel cenefa cenefa-normal">
                        <div class="cenefa-cuerpo" style="border: 1px solid #ddd; display:flex; flex-direction:column; align-items:center; justify-content:flex-start;">
                        <div class="bg-print" style="width: 100%; background: ${colorInstitucional}; color: white; font-size: 8px; font-weight: bold; text-align: center; text-transform: uppercase; padding: 1.5mm 0; letter-spacing: 1px;">${htmlTxtCartel(local)}</div>
                        <div style="padding: 1mm 2mm; width: 100%; display: flex; flex-direction: column; align-items: center; height: 100%;">
                            ${txExtra}
                            ${packChico}
                            <div class="truncate-lines" style="font-size: 11px; font-weight: bold; text-align: center; color: #333; line-height:1.1; margin-top:1mm; min-height: 8mm;">${htmlTxtCartel(item.nombre)}</div>
                            <div style="margin-top:auto; color: #000; padding-bottom:1mm; text-align:center;">${bloquePrecioCenefa}${hastaPrint}</div>
                            ${item.codigo_barras ? `<svg id="bc-${idx}-${i}" style="height:9mm; width:65mm; margin:0; margin-top:auto;"></svg>` : ''}
                        </div>
                        </div>
                    </div>
                `;
            } 
            else if (item.formato === "Cenefa_Doble") {
                let mitadDer;
                if (item.pack) {
                    mitadDer = `<div class="bg-print" style="width: 50%; background: ${colorInstitucional}; color: white; display:flex; flex-direction:column; justify-content:center; align-items:center; padding: 2mm;">
                           <div class="bg-print" style="background:#dc3545; color:white; font-size:11px; font-weight:bold; text-transform:uppercase; padding: 2px 10px; border-radius: 10px; margin-bottom: 1mm; letter-spacing: 1px;">PROMO</div>
                           <div style="font-size:38px; font-weight:900; line-height:1;">${htmlTxtCartel(item.pack.nombre)}</div>
                           <div style="font-size:10px; font-weight:bold; color: rgba(255,255,255,0.9); margin-top: 1mm;">Llevando ${item.pack.n}: $${fmtPrecioCartel(item.pack.precio)}</div>
                       </div>`;
                } else if (item.cantMayo) {
                    mitadDer = `<div class="bg-print" style="width: 50%; background: ${colorInstitucional}; color: white; display:flex; flex-direction:column; justify-content:center; align-items:center; padding: 2mm;">
                           <div class="bg-print" style="background:#dc3545; color:white; font-size:11px; font-weight:bold; text-transform:uppercase; padding: 2px 10px; border-radius: 10px; margin-bottom: 1mm; letter-spacing: 1px;">OFERTA MAYORISTA</div>
                           <div style="font-size:45px; font-weight:900; line-height:1;">$${fmtPrecioCartel(item.precioMayo)}</div>
                           <div style="font-size:10px; font-weight:bold; color: rgba(255,255,255,0.9); margin-top: 1mm; margin-bottom: 1mm;">Llevando ${item.cantMayo} un. o más</div>
                           ${htmlUxB_print}
                       </div>`;
                } else {
                    mitadDer = `<div class="bg-print" style="width: 50%; background: ${colorInstitucional}; color: white; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                           <div style="font-size:45px; font-weight:900;">$${pF}</div>
                           ${htmlUxB_print}
                       </div>`;
                }

                htmlCenefas += `
                    <div class="cartel cenefa cenefa-doble">
                        <div class="cenefa-cuerpo" style="border: 2px solid #333; display:flex; flex-direction: row; border-radius: 4px;">
                        <div style="width: 50%; padding: 2mm; display:flex; flex-direction:column; justify-content:center; align-items:center; border-right: 2px dashed #999; background: white;">
                            ${txExtra}
                            <div style="font-size: 10px; text-transform:uppercase; color: #666; font-weight:bold; background: #f0f0f0; padding: 2px 8px; border-radius: 4px; margin-bottom: 2mm;">PRECIO NORMAL</div>
                            <div class="truncate-lines" style="font-size: 14px; font-weight: bold; text-align: center; line-height:1.1; color:#333; margin-bottom: 1mm;">${htmlTxtCartel(item.nombre)}</div>
                            <div style="color: #000; margin-bottom: 1mm; text-align:center;">${bloquePrecioDoble}${hastaPrint}</div>
                            ${item.codigo_barras ? `<svg id="bc-${idx}-${i}" style="height:7mm; width:45mm; margin:0;"></svg>` : ''}
                        </div>
                        ${mitadDer}
                        </div>
                    </div>
                `;
            }
            else if (item.formato === "Cartel_A4") {
                let logoHTML = logo
                    ? `<img src="${logo}" style="max-height: 40mm; object-fit: contain;">`
                    : `<div style="font-size:30px; font-weight:900; color:${colorInstitucional}; text-transform:uppercase; letter-spacing: 2px;">${htmlTxtCartel(local)}</div>`;

                // LA LÓGICA DINÁMICA PARA RELLENAR ESPACIO
                let tieneFoto = (item.esLibre && item.fotoManual);
                let imagenManualHTML = tieneFoto ? `<img src="${item.fotoManual}" style="max-height: 80mm; max-width:100%; object-fit: contain; margin-bottom: 5mm; border-radius: 15px; box-shadow: 0 10px 20px rgba(0,0,0,0.1);">` : '';
                
                let justificacion = tieneFoto ? 'center' : 'space-evenly';
                let fontSizeNombre = tieneFoto ? '45px' : '75px';
                
                let fontSizePrecioBase = pF.length > 8 ? 100 : (pF.length > 6 ? 120 : 150);
                let fontSizePrecio = tieneFoto ? `${fontSizePrecioBase}px` : `${fontSizePrecioBase + 50}px`;

                htmlA4s += `
                    <div class="cartel" style="width: 195mm; height: 280mm; border: 6px solid ${colorInstitucional}; border-radius: 20px; display: flex; flex-direction: column; align-items: center; padding: 0; text-align:center; position:relative; box-shadow: 0 0 20px rgba(0,0,0,0.1);">
                        <div class="bg-print" style="width: 100%; padding: 10mm; border-bottom: 2px solid ${colorInstitucional}; display:flex; justify-content:center; align-items:center; background-color: #f8f9fa;">
                            ${logoHTML}
                        </div>
                        <div style="padding: 10mm; flex-grow: 1; display:flex; flex-direction:column; align-items:center; justify-content:${justificacion}; width:100%;">
                            ${txExtra ? `<div class="bg-print" style="background:#3586dc; color:white; font-size:35px; font-weight:900; padding:5mm 20mm; border-radius:15px; margin-bottom:10mm; text-transform:uppercase; letter-spacing:2px; box-shadow: 5px 5px 0px rgba(0,0,0,0.2);">${htmlTxtCartel(item.textoExtra)}</div>` : ''}
                            
                            ${imagenManualHTML}
                            
                            <div style="font-size: ${fontSizeNombre}; font-weight: 900; color: #333; line-height: 1.1;">${htmlTxtCartel(item.nombre)}</div>
                            ${bultoHTML}
                            
                            <div style="font-size: ${fontSizePrecio}; font-weight: 900; color: #198754; line-height: 0.9; text-shadow: 4px 4px 0px rgba(0,0,0,0.1); margin-top: ${tieneFoto ? 'auto' : '0'}; text-align:center;">${bloquePrecioA4}</div>
                            
                            ${item.pack ? `<div class="bg-print" style="margin-top:10mm; background:${colorInstitucional}; color:white; padding: 8mm; border-radius:15px; width:90%;"><div style="font-size:28px; font-weight:bold;">PROMO</div><div style="font-size:60px; font-weight:900; margin-top:2mm;">${htmlTxtCartel(item.pack.nombre)}</div><div style="font-size:22px; margin-top:2mm;">Llevando ${item.pack.n}: $${fmtPrecioCartel(item.pack.precio)}</div></div>` : (item.cantMayo ? `<div class="bg-print" style="margin-top:10mm; background:${colorInstitucional}; color:white; padding: 8mm; border-radius:15px; width:90%;"><div style="font-size:25px; font-weight:bold;">OFERTA MAYORISTA LLEVANDO ${item.cantMayo} UNIDADES</div><div style="font-size:60px; font-weight:900; margin-top:2mm;">$${fmtPrecioCartel(item.precioMayo)} c/u</div></div>` : '')}
                            ${item.hasta ? `<div style="margin-top:6mm; font-size:22px; font-weight:900; color:#dc3545;">Válido hasta el ${fmtDiaMes(item.hasta)}</div>` : ''}
                        </div>
                    </div>
                `;
            }
        }
    });

    if (htmlCenefas) html += `<div class="hoja-cenefas">${htmlCenefas}</div>`;
    html += htmlA4s;
    zona.innerHTML = html;
    zona.classList.remove('d-none');

    listaAImprimir.forEach((item, idx) => {
        if ((item.formato === "Cenefa_Normal" || item.formato === "Cenefa_Doble") && item.codigo_barras) {
            for (let i = 0; i < item.copias; i++) {
                try {
                    JsBarcode(`#bc-${idx}-${i}`, item.codigo_barras, {
                        format: "CODE128", width: 1.5, height: 30, displayValue: true, fontSize: 12, textMargin: 1, margin: 0
                    });
                } catch (e) {}
            }
        }
    });

    // MAGIA DE VISTA PREVIA: Le damos 100ms al navegador para dibujar los códigos de barra y lanzamos el Modal
    setTimeout(() => {
        Swal.fire({
            title: '<i class="bi bi-eye"></i> Vista Previa de Impresión',
            html: `
                <div style="background: #525659; padding: 12px; max-height: 60vh; overflow: auto; border-radius: 5px; text-align: left;">
                    <div style="width: 210mm; max-width: 100%; margin: 0; background: #fff; text-align: left;">
                    ${zona.innerHTML}
                    </div>
                </div>
                <div class="text-muted small mt-2">A4 sin márgenes. Las cenefas normales van de a dos por fila.</div>
            `,
            width: '860px',
            showCancelButton: true,
            confirmButtonText: '<i class="bi bi-printer"></i> Imprimir Ahora',
            cancelButtonText: 'Cancelar',
            confirmButtonColor: '#1b365d',
            cancelButtonColor: '#dc3545'
        }).then((result) => {
            if (result.isConfirmed) {
                window.print(); 
                zona.classList.add('d-none'); 
                zona.innerHTML = ''; 
                quitarImpresosDeCola(listaAImprimir);
            } else {
                zona.classList.add('d-none'); 
                zona.innerHTML = '';
            }
        });
    }, 100);
}

function payloadMasivoCarteleria() {
    const idCategoria = parseInt(document.getElementById('selectMasivoCarteleria').value, 10);
    const palabra = (document.getElementById('palabraMasivoCarteleria').value || '').trim();
    const formato = document.getElementById('formatoMasivoCarteleria').value;
    const hayRubro = Number.isFinite(idCategoria) && idCategoria > 0;
    return {
        tipo_filtro: hayRubro ? 'categoria' : 'todos',
        filtro_id: hayRubro ? idCategoria : 0,
        tipo_cartel: formato,
        plantilla: 'Clasica',
        color_tema: '#000000',
        palabra_clave: palabra
    };
}

async function encolarMasivoCarteleria() {
    const body = payloadMasivoCarteleria();
    if (!body.palabra_clave && body.filtro_id <= 0) {
        return Swal.fire('Aviso', 'Escribí una palabra (ej. yerba) o elegí un rubro.', 'warning');
    }

    try {
        const qs = new URLSearchParams({
            tipo_filtro: body.tipo_filtro,
            filtro_id: String(body.filtro_id),
            palabra_clave: body.palabra_clave
        });
        const prevRes = await apiFetch(`${obtenerBaseUrl()}/productos/etiquetas/previsualizar_masivo?${qs}`);
        const prev = await leerRespuesta(prevRes, 'No se pudo contar los productos.');
        if (!prev.cantidad) {
            return Swal.fire('Nada para encolar', 'No hay productos activos con ese filtro.', 'info');
        }

        const ejemplos = (prev.ejemplos || []).join(', ');
        const extra = prev.cantidad > (prev.ejemplos || []).length ? '…' : '';
        const ok = await Swal.fire({
            title: `¿Encolar ${prev.cantidad} carteles?`,
            html: `<div class="text-start small">${htmlTxtCartel(ejemplos)}${extra}</div>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Sí, a la cola',
            cancelButtonText: 'Cancelar',
            confirmButtonColor: '#1b365d',
            reverseButtons: true
        });
        if (!ok.isConfirmed) return;

        Swal.fire({ title: 'Encolando…', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/etiquetas/encolar_masivo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await leerRespuesta(res, 'No se pudo encolar.');

        await cargarColaDesdeDB();
        Swal.fire('Listo', data.mensaje, 'success');
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

async function quitarImpresosDeCola(impresos) {
    const impresosSet = new Set(impresos);
    colaImpresion = colaImpresion.filter((c) => !(c.esLibre && impresosSet.has(c)));
    let fallidos = 0;
    for (const item of impresos) {
        if (item.id_db) {
            try {
                const res = await apiFetch(`${obtenerBaseUrl()}/productos/etiquetas/eliminar/${item.id_db}`, { method: 'DELETE' });
                if (!res.ok) fallidos++;
            } catch (e) { fallidos++; }
        }
    }
    await cargarColaDesdeDB();
    if (fallidos) {
        Swal.fire('Aviso', `${fallidos} carteles ya impresos siguen en la cola porque no se pudieron quitar. Borralos a mano.`, 'warning');
    }
}

async function cargarCategoriasCarteleria() {
    const select = document.getElementById('selectMasivoCarteleria');
    if (!select) return;
    select.innerHTML = '<option value="">Todos los rubros</option>';
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/categorias`);
        const data = await leerRespuesta(res, 'No se pudieron leer los rubros.');
        (data.categorias || []).forEach(c => {
            const opt = document.createElement('option');
            opt.value = String(c.id);
            opt.textContent = c.nombre;
            select.appendChild(opt);
        });
    } catch (e) {
        console.error("Error cargando categorías", e);
        const opt = document.createElement('option');
        opt.disabled = true;
        opt.textContent = 'No se pudieron leer los rubros';
        select.appendChild(opt);
    }
}

function textoPromoVencida(p) {
    if (p.tipo === 'PACK') return nombrePackCartel(Number(p.cantidad_minima), Number(p.precio_pack), Number(p.precio_venta_final) || 0);
    if (Number(p.cantidad_minima) <= 1) return `Oferta $${fmtPrecioCartel(p.precio_oferta_unitario)}`;
    return `Llevando ${p.cantidad_minima}: $${fmtPrecioCartel(p.precio_oferta_unitario)}`;
}

async function cargarPromosVencidas() {
    const caja = document.getElementById('cajaPromosVencidas');
    const lista = document.getElementById('listaPromosVencidas');
    if (!caja || !lista) return;
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/promos/vencidas`);
        const data = await leerRespuesta(res, 'No se pudieron leer las promos vencidas.');
        const promos = data.promos || [];
        if (!promos.length) {
            caja.classList.add('d-none');
            lista.innerHTML = '';
            return;
        }
        caja.classList.remove('d-none');
        lista.innerHTML = promos.map((p) => `
            <div class="d-flex flex-column flex-sm-row justify-content-between align-items-sm-center gap-2 py-2 border-bottom border-warning">
                <div><b>${htmlTxtCartel(p.nombre)}</b> · ${htmlTxtCartel(textoPromoVencida(p))} · venció el ${fmtDiaMes(p.fecha_hasta)}</div>
                <button type="button" class="btn btn-sm btn-outline-dark fw-bold" onclick="marcarCartelRetirado(${Number(p.id)})">Ya lo saqué</button>
            </div>
        `).join('');
    } catch (e) {
        caja.classList.add('d-none');
        console.error('Promos vencidas', e);
    }
}

async function marcarCartelRetirado(promoId) {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/promos/${promoId}/cartel_retirado`, { method: 'POST' });
        await leerRespuesta(res, 'No se pudo marcar el cartel.');
        await cargarPromosVencidas();
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}