// --- ENVOLTORIO CORPORATIVO PARA PETICIONES (REEMPLAZA AL apiFetch GLOBAL) ---
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

let productosGlobales = [];
let categoriasGlobales = [];
let reglasMayoristas = [];
let productoEditandoId = null;
let colaEtiquetasActual = [];

// ==========================================
// Paginación y Buscador (NUEVO MOTOR BACKEND)
// ==========================================
let paginaActualProd = 1;
const itemsPorPagina = 50;
let timeoutFiltro = null;
let totalPaginasGlobal = 1; // Guarda el total de páginas que dijo Python

async function cargarCatalogo(pagina = null) {
    if (pagina !== null) {
        paginaActualProd = pagina;
    }
    const loader = document.getElementById('loaderServidor');
    const contenedor = document.getElementById('productTabsContent');
    const tbody = document.getElementById('tablaCatalogoBody');
    
    if (tbody) {
        let skeletonHtml = '';
        for (let i = 0; i < 8; i++) {
            skeletonHtml += `<tr class="placeholder-glow"><td colspan="7"><span class="placeholder col-12 bg-secondary opacity-25" style="height:35px;"></span></td></tr>`;
        }
        tbody.innerHTML = skeletonHtml;
    }

    if (loader) loader.style.display = 'none';
    if (contenedor) contenedor.style.display = 'block';

    try {
        let estadoSelect = document.getElementById('filtroEstado') ? document.getElementById('filtroEstado').value : '1';
        let buscarTexto = document.getElementById('inputBuscarCatalogo') ? document.getElementById('inputBuscarCatalogo').value.trim() : '';
        let catId = document.getElementById('selectFiltroCategoria') ? document.getElementById('selectFiltroCategoria').value : '';
        let provId = document.getElementById('selectFiltroProveedor') ? document.getElementById('selectFiltroProveedor').value : '';

        let offset = (paginaActualProd - 1) * itemsPorPagina;

        let url = new URL(`${obtenerBaseUrl()}/productos/listar`);
        url.searchParams.append('limit', itemsPorPagina);
        url.searchParams.append('offset', offset);

        if (estadoSelect === 'critico') { 
            url.searchParams.append('estado', '1'); url.searchParams.append('alerta_stock', 'true'); 
        } else if (estadoSelect === 'vencimiento') {
            url.searchParams.append('estado', '1'); url.searchParams.append('alerta_vencimiento', 'true');
        } else if (estadoSelect === 'sincodigo') {
            url.searchParams.append('estado', '1'); url.searchParams.append('sin_codigo', 'true');
        } else { 
            url.searchParams.append('estado', estadoSelect); 
        }

        if (buscarTexto) url.searchParams.append('buscar', buscarTexto);
        if (catId) url.searchParams.append('categoria_id', catId);
        if (provId) url.searchParams.append('proveedor_id', provId);

        const response = await apiFetch(url);
        const data = await response.json();
        
        productosGlobales = data.productos || []; 
        totalPaginasGlobal = data.total_paginas || 1;
        
        dibujarTablaCatalogo(data.productos, estadoSelect);
        renderizarControlesPaginacion(totalPaginasGlobal);
        
        let alturaGuardada = sessionStorage.getItem('alturaScroll');
        if (alturaGuardada) {
            setTimeout(() => { window.scrollTo(0, parseInt(alturaGuardada)); }, 100);
            sessionStorage.removeItem('alturaScroll');
        }
        
    } catch (error) { 
        console.error("Error cargando catálogo:", error); 
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-5 fw-bold"><i class="bi bi-wifi-off display-6 d-block mb-2"></i> Sin conexión al catálogo.<br><small class="text-muted">Revisá la red y recargá (F5)</small></td></tr>`;
        }
    }
}

function filtrarCatalogoFront() {
    clearTimeout(timeoutFiltro);
    timeoutFiltro = setTimeout(() => {
        cargarCatalogo(1); 
    }, 300);
}

function dibujarTablaCatalogo(listaProductos, estadoSeleccionado) {
    const tbody = document.getElementById('tablaCatalogoBody');
    tbody.innerHTML = '';

    if(!listaProductos || listaProductos.length === 0) { 
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Sin resultados.</td></tr>'; 
        return; 
    }

    const hoy = new Date();
    hoy.setHours(0,0,0,0);

    listaProductos.forEach(p => {
        let htmlPromo = p.cant_promo ? `<div class="text-success small mt-1 lh-1"><i class="bi bi-tags-fill"></i> Llevando ${p.cant_promo}: $${p.precio_promo} c/u</div>` : '';
        
        let stock = p.stock_total || 0;
        let minimo = p.stock_minimo_alerta || 0;
        
        let badgeClase = stock <= 0 ? 'bg-danger' : (stock <= minimo ? 'bg-warning text-dark' : 'bg-success');
        let textoStock = `${stock} ${p.unidad_medida === 'Unidad' ? 'un' : p.unidad_medida}`;
        let htmlLotes = p.cantidad_lotes > 1 ? `<div class="small text-muted mt-1 lh-1"><i class="bi bi-layers"></i> ${p.cantidad_lotes} Lotes</div>` : '';
        
        if (p.es_combo > 0) {
            badgeClase = 'bg-info text-dark border border-info shadow-sm';
            textoStock = '<i class="bi bi-boxes"></i> COMBO';
            htmlLotes = ''; 
        }
        
        let alertaVencHTML = '';
        if (p.prox_vencimiento && p.dias_alerta_vencimiento > 0) {
            const fechaV = new Date(p.prox_vencimiento + "T00:00:00");
            const difDias = Math.ceil((fechaV - hoy) / (1000 * 60 * 60 * 24));
            if (difDias < 0) {
                alertaVencHTML = `<div class="text-danger small mt-1 fw-bold"><i class="bi bi-exclamation-triangle-fill"></i> ¡Vencido hace ${Math.abs(difDias)} días!</div>`;
            } else if (difDias <= p.dias_alerta_vencimiento) {
                alertaVencHTML = `<div class="text-warning small mt-1 fw-bold" style="color: #d97706!important;"><i class="bi bi-clock-history"></i> Vence en ${difDias} días</div>`;
            }
        }

        let catReal = categoriasGlobales.find(c => c.id === p.categoria_id);
        let nombreCat = catReal ? catReal.nombre : 'Sin Rubro';

        let costoF = (p.costo_sin_iva || 0).toLocaleString('es-AR', {minimumFractionDigits: 2});
        let unidad = p.unidad_medida && p.unidad_medida !== 'Unidad' ? `x ${p.unidad_medida}` : '';
        let precioF = (p.precio_venta_final || 0).toLocaleString('es-AR', {minimumFractionDigits: 2}) + ` <span class="small text-muted">${unidad}</span>`;
        
        let claseFila = estadoSeleccionado === "0" ? 'producto-inactivo' : '';
        
        let botonesAccion = estadoSeleccionado !== "0" ? `
            <button class="btn btn-sm btn-outline-primary py-0" title="Editar" onclick="abrirEditarProducto(${p.id})"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-outline-info py-0" title="Clonar (Copiar)" onclick="clonarProducto(${p.id})"><i class="bi bi-files"></i></button>
            <button class="btn btn-sm btn-outline-warning py-0" title="Merma" onclick="abrirModalMerma(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')"><i class="bi bi-box-arrow-down-right"></i></button>
            <button class="btn btn-sm btn-outline-danger py-0 ms-1" title="Desactivar" onclick="desactivarProducto(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')"><i class="bi bi-trash"></i></button>
        ` : `<button class="btn btn-sm btn-success py-0 fw-bold shadow-sm" title="Restaurar" onclick="restaurarProducto(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')"><i class="bi bi-arrow-counterclockwise"></i> Restaurar</button>`;

        tbody.innerHTML += `<tr class="${claseFila}"><td class="text-muted align-middle">${p.codigo_barras || 'S/C'}</td><td class="align-middle"><div class="fw-bold lh-1">${p.nombre}</div>${htmlPromo}${alertaVencHTML}</td><td class="align-middle"><span class="badge bg-primary">${nombreCat}</span></td><td class="text-end text-muted align-middle">$ ${costoF}</td><td class="text-end fw-bold text-success align-middle">$ ${precioF}</td><td class="text-center align-middle"><span class="badge ${badgeClase} rounded-pill px-3">${textoStock}</span>${htmlLotes}</td><td class="text-center align-middle">${botonesAccion}</td></tr>`;
    });
}

function renderizarControlesPaginacion(totalPaginas) {
    const contenedor = document.getElementById('paginacionProductos');
    if (!contenedor) return;

    if (!totalPaginas || totalPaginas <= 1) {
        contenedor.innerHTML = '';
        return;
    }

    let html = `<div class="btn-group shadow-sm">`;
    html += `<button class="btn btn-outline-primary ${paginaActualProd <= 1 ? 'disabled' : ''}" 
                onclick="cambiarPaginaProd(${paginaActualProd - 1})"><i class="bi bi-chevron-left"></i> Anterior</button>`;
    
    html += `<span class="btn btn-light disabled text-dark fw-bold px-3">Pág. ${paginaActualProd} de ${totalPaginas}</span>`;
    
    html += `<button class="btn btn-outline-primary ${paginaActualProd >= totalPaginas ? 'disabled' : ''}" 
                onclick="cambiarPaginaProd(${paginaActualProd + 1})">Siguiente <i class="bi bi-chevron-right"></i></button>`;
    html += `</div>`;
    
    contenedor.innerHTML = html;
}

function cambiarPaginaProd(nuevaPagina) {
    cargarCatalogo(nuevaPagina);
    document.querySelector('.content-area').scrollTo({ top: 0, behavior: 'smooth' });
}

// Navegación por flechas (Vinculada al nuevo motor)
document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (document.querySelector('.modal.show')) return;
    if (!document.getElementById('tab-catalogo').classList.contains('active')) return;

    if (e.key === 'ArrowRight') {
        e.preventDefault(); 
        if (paginaActualProd < totalPaginasGlobal) cambiarPaginaProd(paginaActualProd + 1);
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault(); 
        if (paginaActualProd > 1) cambiarPaginaProd(paginaActualProd - 1);
    }
});

// ==========================================
// ABM DE CATEGORÍAS (RUBROS)
// ==========================================
async function cargarCategoriasGlobales() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/categorias`);
        const data = await res.json();
        categoriasGlobales = data.categorias || [];

        let selFiltro = document.getElementById('selectFiltroCategoria');
        if (selFiltro) {
            selFiltro.innerHTML = '<option value="">Todas las Categorías</option>';
            categoriasGlobales.forEach(c => selFiltro.innerHTML += `<option value="${c.id}">${c.nombre}</option>`);
        }

        let selModal = document.getElementById('selectCategoria');
        if (selModal) {
            selModal.innerHTML = '';
            categoriasGlobales.forEach(c => selModal.innerHTML += `<option value="${c.id}">${c.nombre}</option>`);
        }

        const selectsMasivos = ['masivaFiltro', 'etiquetaMasivaFiltro'];
        selectsMasivos.forEach(id_elemento => {
            let sel = document.getElementById(id_elemento);
            if (sel) {
                sel.innerHTML = '<option value="todo_0">Todo el Catálogo</option>';
                let optGroup = document.createElement('optgroup');
                optGroup.label = "Por Rubro / Categoría";
                categoriasGlobales.forEach(c => {
                    optGroup.innerHTML += `<option value="cat_${c.id}">${c.nombre}</option>`;
                });
                sel.appendChild(optGroup);
            }
        });
    } catch (e) { console.error("Error cargando categorías:", e); }
}

async function cargarProveedoresGlobales() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/proveedores/listado`);
        const data = await res.json();
        const proveedoresReales = Array.isArray(data) ? data : (data.proveedores || []);

        let selModal = document.getElementById('selectProveedor');
        if (selModal) {
            selModal.innerHTML = '<option value="0">-- Sin Proveedor --</option>';
            proveedoresReales.filter(p => p.activo !== 0).forEach(p => {
                selModal.innerHTML += `<option value="${p.id}">${p.nombre_comercial}</option>`;
            });
        }

        let selFiltro = document.getElementById('selectFiltroProveedor');
        if (selFiltro) {
            selFiltro.innerHTML = '<option value="">Todos los Proveedores</option>';
            proveedoresReales.forEach(p => {
                selFiltro.innerHTML += `<option value="${p.id}">${p.nombre_comercial}</option>`;
            });
        }
    } catch (e) { console.error("Error cargando proveedores:", e); }
}

async function gestionarCategoriasUI() {
    let htmlLista = categoriasGlobales.map(c => `
        <div class="d-flex justify-content-between align-items-center p-2 border-bottom">
            <span class="fw-bold text-start">${c.nombre}</span>
            <button class="btn btn-sm btn-outline-danger py-0" onclick="borrarCategoria(${c.id}, '${c.nombre}')"><i class="bi bi-trash"></i></button>
        </div>
    `).join('');

    Swal.fire({
        title: 'Gestión de Rubros',
        html: `
            <div class="mb-3 d-flex gap-2">
                <input type="text" id="nuevaCatNombre" class="form-control" placeholder="Ej: Bazar, Limpieza...">
                <button class="btn btn-success fw-bold" onclick="crearCategoriaUI()">Agregar</button>
            </div>
            <div style="max-height: 250px; overflow-y: auto; border: 1px solid #ccc; border-radius: 5px;">
                ${htmlLista || '<div class="p-3 text-muted">No hay rubros activos.</div>'}
            </div>
        `,
        showConfirmButton: false,
        showCloseButton: true
    });
}

async function crearCategoriaUI() {
    const nombre = document.getElementById('nuevaCatNombre').value.trim();
    if (!nombre) return;
    try {
        await apiFetch(`${obtenerBaseUrl()}/productos/categorias/crear`, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ nombre: nombre }) 
        });
        await cargarCategoriasGlobales(); 
        gestionarCategoriasUI(); 
    } catch (e) { Swal.fire('Error', 'No se pudo crear.', 'error'); }
}

async function borrarCategoria(id, nombre) {
    if(!(await Swal.fire({title: `¿Borrar rubro ${nombre}?`, icon: 'warning', showCancelButton: true})).isConfirmed) return;
    try {
        await apiFetch(`${obtenerBaseUrl()}/productos/categorias/eliminar/${id}`, { method: 'DELETE' });
        await cargarCategoriasGlobales();
        gestionarCategoriasUI();
    } catch (e) { Swal.fire('Error', 'No se pudo borrar.', 'error'); }
}

function cambiarPestana(id, evento = null) {
    document.querySelectorAll('#productTabs .nav-link').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#productTabsContent .tab-pane').forEach(el => el.classList.remove('active'));

    if (evento) {
        evento.target.classList.add('active');
    } else {
        let boton = document.querySelector(`[onclick="cambiarPestana('${id}', event)"]`);
        if (boton) boton.classList.add('active');
    }
    document.getElementById('tab-' + id).classList.add('active');

    if (id === 'cat-pos') cargarBotonesPOS();
    if (id === 'combos') cargarListadoCombos(); 
}

function cambiarPestanaAbm(id) {
    document.querySelectorAll('#abmTabs .nav-link').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#abmTabsContent .tab-pane-abm').forEach(el => el.style.display = 'none');
    let btnActivo = document.querySelector(`[onclick="cambiarPestanaAbm('${id}')"]`); if (btnActivo) btnActivo.classList.add('active');
    document.getElementById('tab-abm-' + id).style.display = 'block';
}

function toggleAlertaDias() {
    let control = document.getElementById('selectControlVenc').value;
    document.getElementById('cajaDiasAlerta').style.display = control === 'NO' ? 'none' : 'block';
}

document.getElementById('modalNuevoProducto').addEventListener('keypress', function(e) {
    if (typeof Swal !== 'undefined' && Swal.isVisible()) return;

    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'TEXTAREA') { 
        e.preventDefault(); 
        
        if (e.target.id === 'inputCodigo') {
            document.getElementById('inputNombre').focus();
            return; 
        }

        guardarProductoCompleto(); 
    }
});

document.querySelector('[data-bs-target="#modalNuevoProducto"]').addEventListener('click', () => {
    document.querySelector('button[onclick="generarCodigoInterno()"]').disabled = false;
    document.getElementById('inputCodigo').removeAttribute('readonly');
    document.getElementById('inputCodigo').classList.remove('bg-light', 'text-muted');
    productoEditandoId = null;
    document.querySelector('#modalNuevoProducto .modal-title').innerHTML = `<i class="bi bi-box-seam"></i> Alta de Producto`;
    cambiarPestanaAbm('precios');
    
    document.getElementById('inputUnidadesBulto').value = '1';
    document.querySelectorAll('#modalNuevoProducto input').forEach(input => input.value = '');
    document.getElementById('selectUnidadMedida').value = 'Unidad'; 
    document.getElementById('selectCategoria').value = '1';
    document.getElementById('selectProveedor').value = '0';
    document.getElementById('inputMargen').value = '40'; 
    let campoNuevoIva = document.getElementById('inputIva');
        campoNuevoIva.value = '21.0'; 
        if (campoNuevoIva.selectedIndex === -1) {
            campoNuevoIva.value = '21'; 
        }
    document.getElementById('inputAlertaStock').value = '5'; 
    document.getElementById('inputDiasAlerta').value = '10';
    
    reglasMayoristas = []; dibujarTablaReglas();
    componentesComboActual = []; dibujarTablaComponentes();
    document.querySelector('#tab-abm-lotes table tbody').innerHTML = '<tr><td colspan="6" class="text-muted">Aún no hay lotes ingresados.</td></tr>';
    
    document.getElementById('btnAgregarLoteRapido').style.display = 'none';
    document.getElementById('msgLoteNuevo').style.display = 'block';
});

// ========================================================
// 1. MAGIA EXPORTAR A EXCEL 
// ========================================================
function obtenerProductosFiltradosActuales() {
    let textoBusqueda = document.getElementById('inputBuscarCatalogo').value.toLowerCase().trim();
    let categoriaSeleccionada = document.getElementById('selectFiltroCategoria').value;
    let proveedorSeleccionado = document.getElementById('selectFiltroProveedor').value; 

    let palabras = textoBusqueda.split(" ").filter(p => p !== "");

    return productosGlobales.filter(p => {
        let coincideTexto = palabras.every(palabra => 
            p.nombre.toLowerCase().includes(palabra) || 
            (p.codigo_barras && p.codigo_barras.toLowerCase().includes(palabra))
        );

        let coincideCategoria = categoriaSeleccionada === "" || p.categoria_id == categoriaSeleccionada;
        let coincideProveedor = proveedorSeleccionado === "" || p.proveedor_habitual_id == proveedorSeleccionado;

        return coincideTexto && coincideCategoria && coincideProveedor;
    });
}

async function abrirModalExportar() {
    if (productosGlobales.length === 0) return Swal.fire('Aviso', 'No hay productos para exportar.', 'info');

    const { value: opciones } = await Swal.fire({
        title: 'Exportar a Excel',
        html: `
                    <div class="text-start">
                        <label class="form-label fw-bold small text-primary">1. ¿Qué productos exportar?</label>
                        <select id="swal-export-rango" class="form-select form-select-sm mb-3 border-primary">
                            <option value="filtrado">Solo los que se ven en la tabla ahora</option>
                            <option value="todo">Catálogo completo (Aviso: Si está paginado, solo exporta la página actual)</option>
                        </select>

                        <label class="form-label fw-bold small text-primary">2. ¿Qué columnas incluir?</label>
                        <div class="row g-2 mb-2">
                            <div class="col-6"><div class="form-check"><input class="form-check-input col-export" type="checkbox" value="codigo" checked> <label class="form-check-label small">Código</label></div></div>
                            <div class="col-6"><div class="form-check"><input class="form-check-input col-export" type="checkbox" value="nombre" checked> <label class="form-check-label small">Nombre</label></div></div>
                            <div class="col-6"><div class="form-check"><input class="form-check-input col-export" type="checkbox" value="rubro" checked> <label class="form-check-label small">Rubro</label></div></div>
                            <div class="col-6"><div class="form-check"><input class="form-check-input col-export" type="checkbox" value="stock"> <label class="form-check-label small">Stock Actual</label></div></div>
                            <div class="col-6"><div class="form-check"><input class="form-check-input col-export" type="checkbox" value="costo"> <label class="form-check-label small text-danger">Costo Neto</label></div></div>
                            <div class="col-6"><div class="form-check"><input class="form-check-input col-export" type="checkbox" value="precio" checked> <label class="form-check-label small text-success">Precio Público</label></div></div>
                            <div class="col-6"><div class="form-check"><input class="form-check-input col-export" type="checkbox" value="mayorista"> <label class="form-check-label small">Precio Mayorista</label></div></div>
                        </div>
                    </div>
                `,
        focusConfirm: false, showCancelButton: true, confirmButtonColor: '#198754', confirmButtonText: '<i class="bi bi-file-earmark-excel"></i> Descargar CSV',
        preConfirm: () => {
            let columnas = [];
            document.querySelectorAll('.col-export:checked').forEach(c => columnas.push(c.value));
            if (columnas.length === 0) { Swal.showValidationMessage('Elegí al menos una columna'); return false; }
            return { rango: document.getElementById('swal-export-rango').value, columnas: columnas }
        }
    });

    if (opciones) {
        let listaAExportar = opciones.rango === 'filtrado' ? obtenerProductosFiltradosActuales() : productosGlobales;
        let cols = opciones.columnas;

        let csvContent = "\uFEFF";

        let headers = [];
        if (cols.includes('codigo')) headers.push("Código");
        if (cols.includes('nombre')) headers.push("Producto");
        if (cols.includes('rubro')) headers.push("Rubro ID");
        if (cols.includes('costo')) headers.push("Costo Neto");
        if (cols.includes('precio')) headers.push("Precio Final");
        if (cols.includes('mayorista')) headers.push("Precio Oferta/Mayorista");
        if (cols.includes('stock')) headers.push("Stock");

        csvContent += headers.join(";") + "\n";

        listaAExportar.forEach(p => {
            let row = [];
            if (cols.includes('codigo')) row.push(p.codigo_barras ? `="${p.codigo_barras}"` : "");
            if (cols.includes('nombre')) row.push(`"${p.nombre}"`);
            if (cols.includes('rubro')) row.push(p.categoria_id);
            if (cols.includes('costo')) row.push((p.costo_sin_iva || 0).toFixed(2).replace('.', ','));
            if (cols.includes('precio')) row.push((p.precio_venta_final || 0).toFixed(2).replace('.', ','));
            if (cols.includes('mayorista')) { let pm = p.precio_promo || p.precio_venta_final; row.push(pm.toFixed(2).replace('.', ',')); }
            if (cols.includes('stock')) row.push(p.stock_total || 0);

            csvContent += row.join(";") + "\n";
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a"); link.setAttribute("href", URL.createObjectURL(blob));
        link.setAttribute("download", `catalogo_${opciones.rango}.csv`);
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
    }
}

// ========================================================
// 2. GENERADOR DE CÓDIGO INTERNO
// ========================================================
async function generarCodigoInterno() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/generar_codigo_interno`);
        const data = await res.json();
        if (data.codigo) { document.getElementById('inputCodigo').value = data.codigo; }
        else { Swal.fire('Error', 'Fallo al buscar código en la base.', 'warning'); }
    } catch (e) { Swal.fire('Error', 'Problema conectando con Python.', 'error'); }
}


// ==========================================
// 3. ABM Y CÁLCULOS
// ==========================================
function calcularPrecioAutomatico() {
    let c = parseFloat(document.getElementById('inputCosto').value) || 0; let i = parseFloat(document.getElementById('inputIva').value) || 0; let m = parseFloat(document.getElementById('inputMargen').value) || 0;
    document.getElementById('inputPrecioVenta').value = ((c + (c * i / 100)) * (1 + m / 100)).toFixed(2);
}
function agregarReglaUI() { let c = parseFloat(document.getElementById('inputCantMayorista').value); let p = parseFloat(document.getElementById('inputPrecioMayorista').value); if (c && p) { reglasMayoristas.push({ cantidad: c, precio: p }); dibujarTablaReglas(); document.getElementById('inputCantMayorista').value = ""; document.getElementById('inputPrecioMayorista').value = ""; } }
function borrarReglaUI(i) { reglasMayoristas.splice(i, 1); dibujarTablaReglas(); }
function dibujarTablaReglas() { const tb = document.getElementById('tablaReglasBody'); tb.innerHTML = ''; if (reglasMayoristas.length === 0) { tb.innerHTML = '<tr><td colspan="3" class="text-center text-muted">No hay reglas</td></tr>'; return; } reglasMayoristas.forEach((r, i) => { tb.innerHTML += `<tr><td class="text-center fw-bold">${r.cantidad} un.</td><td class="text-center text-success fw-bold">$${r.precio.toFixed(2)}</td><td class="text-center"><button class="btn btn-sm text-danger border-0" type="button" onclick="borrarReglaUI(${i})"><i class="bi bi-trash"></i></button></td></tr>`; }); }

async function agregarLoteRapido() {
    if (!productoEditandoId) return Swal.fire('Aviso', 'Guardá el producto primero.', 'info');
    
    const cant = parseFloat(document.getElementById('inputCantLote').value) || 0; 
    
    if (cant <= 0) {
        return Swal.fire({
            target: document.getElementById('modalNuevoProducto'),
            title: 'Cantidad Inválida',
            text: 'Tenés que ingresar cuántas unidades entran en este lote.',
            icon: 'warning',
            confirmButtonColor: '#ffc107',
            confirmButtonText: 'Entendido'
        });
    }

    const lote = document.getElementById('inputNumLote').value || "INICIAL"; 
    const v = document.getElementById('inputVencimiento').value || "2099-12-31"; 
    const c = parseFloat(document.getElementById('inputCostoLote').value) || 0;
    
    try { 
        await apiFetch(`${obtenerBaseUrl()}/lotes/ingresar`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ producto_id: productoEditandoId, numero_lote_proveedor: lote, fecha_vencimiento: v, cantidad_inicial: cant, costo_real_ingreso: c }) 
        }); 
        
        Swal.fire({ 
            target: document.getElementById('modalNuevoProducto'),
            title: '¡Lote agregado!', 
            icon: 'success', 
            timer: 1000, 
            showConfirmButton: false 
        }); 

        document.getElementById('inputNumLote').value = "";
        document.getElementById('inputCantLote').value = "";
        document.getElementById('inputCostoLote').value = "";
        
        abrirEditarProducto(productoEditandoId, 'lotes'); 
        cargarCatalogo(); 
    } catch (e) { 
        Swal.fire({
            target: document.getElementById('modalNuevoProducto'),
            title: 'Error',
            text: 'No se pudo guardar el lote.',
            icon: 'error'
        });
    }
}

let idsExcluidosMasiva = []; 

function cambiarIconoAjuste() {
    const esPorcentaje = document.getElementById('masivaTipoPorcentaje').checked;
    const icono = document.getElementById('iconoAjusteMasivo');
    icono.innerText = esPorcentaje ? '%' : '$';
    icono.className = esPorcentaje ? 'input-group-text fw-bold text-primary' : 'input-group-text fw-bold text-success';
}

async function simularAjusteMasivo() {
    idsExcluidosMasiva = []; 
    
    const valorAjuste = parseFloat(document.getElementById('masivaValor').value);
    const esFijo = document.getElementById('masivaTipoFijo').checked; 
    const esSumar = document.getElementById('masivaTipoSumar').checked; 
    
    if (isNaN(valorAjuste)) return Swal.fire('Error', 'Ingresá un valor válido', 'warning');

    const tb = document.querySelector('#tablaSimulacion tbody');
    tb.innerHTML = '';

    const filtroVal = document.getElementById('masivaFiltro').value || "todo_0";
    const tipoFiltro = filtroVal.split('_')[0]; 
    const filtroId = parseInt(filtroVal.split('_')[1]) || 0;
    const busqueda = document.getElementById('masivaPalabra').value.toLowerCase().trim();

    // Acá usamos productosGlobales que tiene la memoria de LA PÁGINA ACTUAL
    const filtrados = productosGlobales.filter(p => {
        let coincideFiltro = true;
        if (tipoFiltro === 'cat') coincideFiltro = (p.categoria_id === filtroId);
        const coincideTxt = p.nombre.toLowerCase().includes(busqueda) || (p.codigo_barras && p.codigo_barras.includes(busqueda));
        return coincideFiltro && coincideTxt;
    });

    if (filtrados.length === 0) {
        tb.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No se encontraron productos con esos filtros.</td></tr>';
        document.getElementById('simuladorContador').innerText = "0 productos";
        document.getElementById('footerSimulador').classList.add('d-none');
        return;
    }

    document.getElementById('simuladorContador').innerText = `${filtrados.length} productos afectados`;
    document.getElementById('footerSimulador').classList.remove('d-none');

    filtrados.forEach(p => {
        let v = p.precio_venta_final || 0;
        let c = p.costo_sin_iva || 0;
        let n = 0; let nC = c;
        let afCosto = document.getElementById('masivaCostoYVenta').checked;

        if (esFijo) {
            n = valorAjuste;
            if (afCosto) nC = c; 
        } else if (esSumar) {
            n = v + valorAjuste;
            if (afCosto) nC = c + valorAjuste;
        } else {
            const fac = 1 + (valorAjuste / 100);
            n = v * fac;
            if (afCosto) nC = c * fac;
        }

        let dif = n - v;

        tb.innerHTML += `
            <tr>
                <td class="text-start ps-3 fw-bold">${p.nombre}</td>
                <td class="text-muted small">$${c.toFixed(2)} ➔ <b>$${nC.toFixed(2)}</b></td>
                <td class="text-muted small">$${v.toFixed(2)} ➔ <b><span class="fs-6 text-dark">$${n.toFixed(2)}</span></b></td>
                <td class="${dif>0?'text-success':'text-danger'} fw-bold">${dif>0?'+':''}$${dif.toFixed(2)}</td>
                <td class="text-center">
                    <button class="btn btn-sm text-danger border-0" title="No aumentar este" onclick="quitarDeSimulacion(${p.id}, this)">
                        <i class="bi bi-x-circle-fill fs-5"></i>
                    </button>
                </td>
            </tr>`;
    });
}

function quitarDeSimulacion(id, btnElement) {
    idsExcluidosMasiva.push(id);
    btnElement.closest('tr').remove();
    
    const contadorActual = parseInt(document.getElementById('simuladorContador').innerText);
    document.getElementById('simuladorContador').innerText = `${contadorActual - 1} productos afectados`;
    
    if(contadorActual - 1 === 0) {
        document.getElementById('footerSimulador').classList.add('d-none');
        document.querySelector('#tablaSimulacion tbody').innerHTML = '<tr><td colspan="5" class="text-muted py-5">No quedaron productos en la lista.</td></tr>';
    }
}

function limpiarSimulacion() { document.querySelector('#tablaSimulacion tbody').innerHTML = '<tr><td colspan="5" class="text-muted py-5">Usá el panel para simular.</td></tr>'; document.getElementById('footerSimulador').classList.add('d-none'); document.getElementById('simuladorContador').innerText = "0 productos"; document.getElementById('masivaPalabra').value = ""; idsExcluidosMasiva = []; }

async function confirmarAjusteMasivo() { 
    const tF = document.getElementById('masivaFiltro').value.split('_')[0]; 
    const fId = parseInt(document.getElementById('masivaFiltro').value.split('_')[1]) || 0; 
    const pal = document.getElementById('masivaPalabra').value.trim(); 
    const valorNum = parseFloat(document.getElementById('masivaValor').value); 
    const afCosto = document.getElementById('masivaCostoYVenta').checked; 
    
    const tAjuste = document.getElementById('masivaTipoPorcentaje').checked ? 'porcentaje' : (document.getElementById('masivaTipoSumar').checked ? 'sumar' : 'fijo');
    
    try { 
        await apiFetch(`${obtenerBaseUrl()}/productos/actualizacion_masiva`, { 
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                valor: valorNum, 
                tipo_ajuste: tAjuste, 
                tipo_filtro: tF, 
                filtro_id: fId, 
                afectar_costo: afCosto, 
                palabra_clave: pal, 
                excluir_ids: idsExcluidosMasiva 
            }) 
        }); 
        Swal.fire('¡Aplicado!', '', 'success'); limpiarSimulacion(); cargarCatalogo(); cambiarPestana('catalogo'); 
    } catch (e) { } 
}

async function abrirEditarProducto(id, pestana = 'precios') {
    productoEditandoId = id;
    cambiarPestanaAbm(pestana); 
    
    document.querySelectorAll('#modalNuevoProducto input').forEach(i => i.value = '');

    try {
        const response = await apiFetch(`${obtenerBaseUrl()}/productos/ver/${id}`);
        const p = await response.json(); 
        if (p.error) throw new Error(p.error);

        const codigoActual = p.codigo_barras || "";
        document.getElementById('inputCodigo').value = codigoActual;
        
        const btnGenerarCodigo = document.querySelector('button[onclick="generarCodigoInterno()"]');
        
        if (codigoActual.trim() !== "") {
            document.getElementById('inputCodigo').setAttribute('readonly', true);
            document.getElementById('inputCodigo').classList.add('bg-light', 'text-muted');
            if (btnGenerarCodigo) btnGenerarCodigo.disabled = true;
        } else {
            document.getElementById('inputCodigo').removeAttribute('readonly');
            document.getElementById('inputCodigo').classList.remove('bg-light', 'text-muted');
            if (btnGenerarCodigo) btnGenerarCodigo.disabled = false;
        }
        document.getElementById('inputNombre').value = p.nombre;
        
        let intentos = 0;
        const interval = setInterval(() => {
            const selProv = document.getElementById('selectProveedor');
            const selCat = document.getElementById('selectCategoria');
            
            if ((selProv && selProv.options.length > 1) || intentos > 40) {
                selProv.value = p.proveedor_habitual_id || 0;
                selCat.value = p.categoria_id || 0;
                clearInterval(interval);
            }
            intentos++;
        }, 50);

        document.getElementById('selectUnidadMedida').value = p.unidad_medida || 'Unidad';
        document.getElementById('inputUnidadesBulto').value = p.unidades_por_bulto || 1;
        document.getElementById('inputCosto').value = p.costo_sin_iva;

        let ivaLimpio = p.porcentaje_iva;
        if (ivaLimpio === null || ivaLimpio === undefined || ivaLimpio === "") ivaLimpio = 21; 
        if (ivaLimpio > 0 && ivaLimpio <= 1) ivaLimpio = ivaLimpio * 100;  

        let ivaFinal = parseFloat(ivaLimpio);
        let campoIva = document.getElementById('inputIva');
        
        campoIva.value = ivaFinal; 
        
        if (campoIva.value === "" || campoIva.selectedIndex === -1) {
            campoIva.value = ivaFinal.toFixed(1); 
        }
        
        if (campoIva.value === "" || campoIva.selectedIndex === -1) {
            campoIva.value = ivaFinal.toFixed(2); 
        }

        document.getElementById('inputPrecioVenta').value = p.precio_venta_final;

        let costoConIva = p.costo_sin_iva * (1 + (ivaFinal / 100));
        
        if (costoConIva > 0) {
            document.getElementById('inputMargen').value = (((p.precio_venta_final / costoConIva) - 1) * 100).toFixed(2);
        } else {
            document.getElementById('inputMargen').value = 0;
        }
        document.getElementById('inputAlertaStock').value = p.stock_minimo_alerta || 5;
        document.getElementById('inputDiasAlerta').value = p.dias_alerta_vencimiento || 10;
        
        const tieneVenc = p.dias_alerta_vencimiento > 0;
        document.getElementById('selectControlVenc').value = tieneVenc ? 'SI' : 'NO';
        document.getElementById('cajaDiasAlerta').style.display = tieneVenc ? 'block' : 'none';
        
        reglasMayoristas = p.reglas_mayoristas || [];
        dibujarTablaReglas();

        document.getElementById('btnAgregarLoteRapido').style.display = 'block';
        const tbodyLotes = document.querySelector('#tab-abm-lotes table tbody');
        tbodyLotes.innerHTML = '';
        
        if(p.lotes && p.lotes.length > 0) {
            const diasAlertaSeteado = p.dias_alerta_vencimiento || 10;
            const hoy = new Date(); hoy.setHours(0,0,0,0); 

            const rolActual = localStorage.getItem('usuario_rol');

            p.lotes.forEach(l => {
                let cartelVenc = '<span class="badge bg-secondary">Seco</span>';
                if (p.dias_alerta_vencimiento > 0 && l.vence !== "2099-12-31") {
                    const fechaVenc = new Date(l.vence + "T00:00:00");
                    const difDias = Math.ceil((fechaVenc - hoy) / (1000 * 60 * 60 * 24));
                    if (difDias < 0) cartelVenc = `<br><span class="badge bg-danger mt-1">¡Vencido hace ${Math.abs(difDias)} días!</span>`;
                    else if (difDias <= diasAlertaSeteado) cartelVenc = `<br><span class="badge bg-warning text-dark mt-1">⚠️ Vence en ${difDias} días</span>`;
                    else cartelVenc = `<br><span class="badge bg-success mt-1">Ok (${difDias} días)</span>`;
                }

                let botonesAccionLote = '';
                if (rolActual === 'ADMIN') {
                    botonesAccionLote = `
                        <button class="btn btn-sm btn-outline-primary py-0" title="Corregir" type="button" onclick="corregirLoteUI(${l.lote_id}, '${l.lote || ''}', '${l.vence}', ${l.stock}, ${l.costo})"><i class="bi bi-pencil"></i></button>
                        <button class="btn btn-sm btn-outline-danger py-0 ms-1" title="Eliminar" type="button" onclick="eliminarLoteUI(${l.lote_id})"><i class="bi bi-trash"></i></button>
                    `;
                } else {
                    botonesAccionLote = `<span class="badge bg-light text-muted border"><i class="bi bi-lock-fill"></i> Solo Admin</span>`;
                }

                tbodyLotes.innerHTML += `
                    <tr>
                        <td class="align-middle">${l.lote || 'S/N'}</td>
                        <td class="align-middle">${l.ingreso}</td>
                        <td class="align-middle"><b>${l.vence}</b> ${cartelVenc}</td>
                        <td class="align-middle fs-6"><strong>${l.stock}</strong></td>
                        <td class="align-middle">$${l.costo.toFixed(2)}</td>
                        <td class="align-middle">${botonesAccionLote}</td>
                    </tr>`;
            });
        } else {
            tbodyLotes.innerHTML = '<tr><td colspan="6" class="text-muted py-4">No hay stock disponible.</td></tr>';
        }

        componentesComboActual = p.componentes_combo || [];
        dibujarTablaComponentes();
        
        try {
            const resHist = await apiFetch(`${obtenerBaseUrl()}/productos/movimientos/${id}`);
            const dataHist = await resHist.json();
            
            const tbHist = document.getElementById('tablaHistorialProd');
            tbHist.innerHTML = '';
            
            if (dataHist.error) throw new Error(dataHist.error);
            
            if (dataHist.movimientos && dataHist.movimientos.length > 0) {
                dataHist.movimientos.forEach(m => {
                    let color = m.tipo_movimiento.toLowerCase().includes('ingreso') ? 'text-success' : 'text-danger';
                    let signo = m.tipo_movimiento.toLowerCase().includes('ingreso') ? '+' : '-';
                    
                    let detalle = m.motivo ? `<br><small class="text-muted fw-normal">${m.motivo}</small>` : '';

                    tbHist.innerHTML += `<tr>
                        <td class="text-muted">${m.fecha_hora}</td>
                        <td class="fw-bold">${m.tipo_movimiento} ${detalle}</td>
                        <td class="fw-bold ${color}">${signo}${m.cantidad}</td>
                        <td class="small"><i class="bi bi-person-fill"></i> ${m.responsable || 'Sistema'}</td>
                    </tr>`;
                });
            } else {
                tbHist.innerHTML = '<tr><td colspan="4" class="text-muted py-3">No hay movimientos registrados para este producto.</td></tr>';
            }
        } catch (e) {
            console.error("Error del historial:", e);
            document.getElementById('tablaHistorialProd').innerHTML = `<tr><td colspan="4" class="text-danger py-3">Error al cargar historial: ${e.message}</td></tr>`;
        }

        document.querySelector('#modalNuevoProducto .modal-title').innerHTML = `<i class="bi bi-pencil-square"></i> Editando: ${p.nombre}`;
        bootstrap.Modal.getOrCreateInstance(document.getElementById('modalNuevoProducto')).show();
    } catch (e) {
        Swal.fire('Error', 'No se pudo cargar el producto: ' + e.message, 'error');
    }
}

async function guardarProductoCompleto() {
    const controlVenc = document.getElementById('selectControlVenc').value;
    const diasAlerta = controlVenc === 'SI' ? (parseInt(document.getElementById('inputDiasAlerta').value) || 10) : 0;
    const alertaStock = parseFloat(document.getElementById('inputAlertaStock').value) || 0;

    const provId = parseInt(document.getElementById('selectProveedor').value);
    const catId = parseInt(document.getElementById('selectCategoria').value);
    const nombreLoteIngresado = document.getElementById('inputNumLote').value.trim();

    const p = { 
        codigo_barras: document.getElementById('inputCodigo').value, 
        nombre: document.getElementById('inputNombre').value, 
        categoria_id: isNaN(catId) ? 1 : catId, 
        proveedor_habitual_id: isNaN(provId) ? 0 : provId, 
        costo_sin_iva: parseFloat(document.getElementById('inputCosto').value) || 0, 
        porcentaje_iva: parseFloat(document.getElementById('inputIva').value) || 0,
        precio_venta_final: parseFloat(document.getElementById('inputPrecioVenta').value) || 0, 
        stock_minimo_alerta: alertaStock, 
        dias_alerta_vencimiento: diasAlerta, 
        unidad_medida: document.getElementById('selectUnidadMedida').value, 
        unidades_por_bulto: parseInt(document.getElementById('inputUnidadesBulto').value) || 1,
        componentes_combo: componentesComboActual,
        reglas_mayoristas: reglasMayoristas,
        cantidad_inicial: productoEditandoId === null ? (parseFloat(document.getElementById('inputCantLote').value) || 0) : 0,
        numero_lote_proveedor: productoEditandoId === null ? (nombreLoteIngresado !== "" ? nombreLoteIngresado : "INICIAL") : "",
        fecha_vencimiento: productoEditandoId === null ? (document.getElementById('inputVencimiento').value || "2099-12-31") : "2099-12-31",
        costo_real_ingreso: productoEditandoId === null ? (parseFloat(document.getElementById('inputCostoLote').value) || 0) : 0
    };
    
    if(!p.nombre || p.precio_venta_final <= 0) return Swal.fire('Error', 'Faltan datos importantes.', 'warning');
    
    try {
        let res;
        if (productoEditandoId === null) {
            res = await apiFetch(`${obtenerBaseUrl()}/productos/crear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
        } else { 
            res = await apiFetch(`${obtenerBaseUrl()}/productos/actualizar/${productoEditandoId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); 
        }
        
        const data = await res.json();
        if (data.error) throw new Error(data.error); 
        
        bootstrap.Modal.getInstance(document.getElementById('modalNuevoProducto')).hide();
        sessionStorage.setItem('paginaRetorno', paginaActualProd);
        sessionStorage.setItem('alturaScroll', window.scrollY);
        cargarCatalogo(); 
        
        const idGuardado = productoEditandoId || data.producto_id || data.id;

        if (idGuardado) {
            const confirmEtiqueta = await Swal.fire({
                title: '¡Producto Guardado!',
                text: '¿Querés mandar una Cenefa actualizada a la cola de impresión?',
                icon: 'success',
                showCancelButton: true,
                confirmButtonText: '<i class="bi bi-printer"></i> Sí, a la cola',
                cancelButtonText: 'No hace falta',
                confirmButtonColor: '#198754',
                cancelButtonColor: '#6c757d'
            });

            if (confirmEtiqueta.isConfirmed) {
                await apiFetch(`${obtenerBaseUrl()}/productos/etiquetas/encolar`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        producto_id: idGuardado, 
                        tipo_cartel: 'Cenefa', 
                        cantidad_copias: 1, 
                        texto_personalizado: '',
                        plantilla: 'Clasica',
                        color_tema: '#000000'
                    })
                });
                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Añadido a la cola', showConfirmButton: false, timer: 1500 });
            }
        } else {
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Guardado correctamente', showConfirmButton: false, timer: 1500 });
        }

    } catch (e) {
        Swal.fire('Error al guardar', e.message, 'error');
    }
}

async function desactivarProducto(id, n) { if ((await Swal.fire({ title: '¿Ocultar?', icon: 'warning', showCancelButton: true })).isConfirmed) { await apiFetch(`${obtenerBaseUrl()}/productos/eliminar/${id}`, { method: 'DELETE' }); sessionStorage.setItem('paginaRetorno', paginaActualProd); cargarCatalogo(); cargarListadoCombos(); } }
async function restaurarProducto(id, n) { if ((await Swal.fire({ title: '¿Restaurar?', icon: 'question', showCancelButton: true })).isConfirmed) { await apiFetch(`${obtenerBaseUrl()}/productos/restaurar/${id}`, { method: 'PUT' }); cargarCatalogo(); cargarListadoCombos(); } }

// ==========================================
// SISTEMA DE MERMAS (RECUPERADO)
// ==========================================
async function abrirModalMerma(id, nombre) {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/ver/${id}`);
        const prod = await res.json();

        document.getElementById('mermaNombreProducto').innerText = nombre;
        const selectLote = document.getElementById('mermaSelectLote');
        selectLote.innerHTML = '';

        if (!prod.lotes || prod.lotes.length === 0) {
            return Swal.fire('Sin stock', 'Este producto no tiene lotes con stock para descontar.', 'info');
        }

        prod.lotes.forEach(l => {
            selectLote.innerHTML += `<option value="${l.lote_id}">Lote: ${l.lote || 'S/N'} - Disp: ${l.stock} un. (Venc: ${l.vence})</option>`;
        });

        document.getElementById('mermaCantidad').value = "1";
        document.getElementById('mermaObservaciones').value = "";
        
        bootstrap.Modal.getOrCreateInstance(document.getElementById('modalMerma')).show();
    } catch (e) {
        Swal.fire('Error', 'No se pudieron cargar los lotes.', 'error');
    }
}

async function confirmarMerma() {
    const loteId = parseInt(document.getElementById('mermaSelectLote').value);
    const cantidad = parseFloat(document.getElementById('mermaCantidad').value);
    const motivo = document.getElementById('mermaMotivo').value;
    const obs = document.getElementById('mermaObservaciones').value;

    if (cantidad <= 0 || !loteId) return Swal.fire('Error', 'Faltan datos válidos.', 'error');

    const motivoCompleto = obs ? `${motivo} - Obs: ${obs}` : motivo;
    const usuarioId = localStorage.getItem('usuario_id') || 1;

    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/lotes/baja_manual`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lote_id: loteId, cantidad_a_bajar: cantidad, motivo: motivoCompleto, usuario_id: parseInt(usuarioId) })
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        await Swal.fire('¡Merma Registrada!', 'El stock fue descontado y registrado en la auditoría.', 'success');
        bootstrap.Modal.getInstance(document.getElementById('modalMerma')).hide();
        
        sessionStorage.setItem('paginaRetorno', paginaActualProd);
        sessionStorage.setItem('alturaScroll', window.scrollY);
        
        cargarCatalogo();
    } catch (error) {
        Swal.fire('Error', error.message || 'No se pudo procesar la baja.', 'error');
    }
}

async function forzarDescargaRapida(evento) {
    if (evento) evento.preventDefault();
    else if (window.event) window.event.preventDefault();

    let paginaSegura = paginaActualProd;
    let scrollSeguro = window.scrollY;

    try {
        Swal.fire({ title: 'Descargando...', text: 'Buscando cambios en la nube', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        
        const res = await apiFetch(`${obtenerBaseUrl()}/sync/actualizar-rapido`, { method: 'POST' }); 
        if (!res.ok) throw new Error("Fallo en la descarga");
        
        await cargarCategoriasGlobales();
        
        sessionStorage.setItem('paginaRetorno', paginaSegura);
        sessionStorage.setItem('alturaScroll', scrollSeguro);
        
        await cargarCatalogo(); 
        
        Swal.fire('¡Actualizado!', 'Tu catálogo ya tiene los datos de la nube.', 'success');
    } catch (e) {
        Swal.fire('Error', 'No se pudo conectar rápido con la nube.', 'error');
    }
}

// --- CARGAR BOTONES POS ---
async function cargarBotonesPOS() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/categorias_pos`);
        const data = await res.json();
        const tbody = document.getElementById('tablaCategoriasPOS');
        tbody.innerHTML = '';

        data.categorias.forEach(cat => {
            tbody.innerHTML += `
                <tr>
                    <td>
                        <div class="p-2 rounded text-center fw-bold" style="background-color: ${cat.color_fondo}; width: 100px;">
                            <i class="bi ${cat.icono}"></i><br>${cat.nombre}
                        </div>
                    </td>
                    <td><input type="text" id="nombrePOS_${cat.id}" class="form-control" value="${cat.nombre}"></td>
                    <td><input type="text" id="clavePOS_${cat.id}" class="form-control" value="${cat.palabra_clave}"></td>
                    <td><input type="color" id="colorPOS_${cat.id}" class="form-control form-control-color" value="${cat.color_fondo}"></td>
                    <td>
                        <button class="btn btn-primary btn-sm fw-bold" onclick="guardarBotonPOS(${cat.id}, '${cat.icono}')">
                            <i class="bi bi-save"></i> Guardar
                        </button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        console.error("Error cargando botones POS");
    }
}

async function guardarBotonPOS(id, iconoActual) {
    const nombre = document.getElementById(`nombrePOS_${id}`).value;
    const clave = document.getElementById(`clavePOS_${id}`).value;
    const color = document.getElementById(`colorPOS_${id}`).value;

    try {
        await apiFetch(`${obtenerBaseUrl()}/productos/categorias_pos/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nombre, palabra_clave: clave, icono: iconoActual, color_fondo: color })
        });
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Botón actualizado', showConfirmButton: false, timer: 1500 });
        cargarBotonesPOS(); 
    } catch (e) {
        Swal.fire('Error', 'No se pudo guardar', 'error');
    }
}
// ==========================================
// MOTOR DE COMBOS CORREGIDO Y LIMPIO
// ==========================================
let componentesComboActual = [];
let componenteSeleccionadoTemporal = null;

function buscarComponenteCombo(busqueda) {
    const contenedor = document.getElementById('resultadosBusquedaCombo');
    if (busqueda.length < 2) { contenedor.classList.add('d-none'); return; }

    // PARCHE: Para el combo buscamos en el servidor (la memoria solo tiene 50)
    apiFetch(`${obtenerBaseUrl()}/productos/buscar?termino=${busqueda}`)
        .then(res => res.json())
        .then(data => {
            const filtrados = data.productos || [];
            contenedor.innerHTML = '';
            filtrados.forEach(p => {
                contenedor.innerHTML += `
                    <button type="button" class="list-group-item list-group-item-action small py-1" 
                        onclick="seleccionarComponente(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')">
                        <b>${p.codigo_barras || 'S/C'}</b> - ${p.nombre} ($${p.precio_venta_final})
                    </button>`;
            });
            contenedor.classList.remove('d-none');
        });
}

function seleccionarComponente(id, nombre) {
    componenteSeleccionadoTemporal = { id, nombre };
    document.getElementById('inputBuscarComponente').value = nombre;
    document.getElementById('resultadosBusquedaCombo').classList.add('d-none');
}

function agregarComponenteUI() {
    const cant = parseFloat(document.getElementById('inputCantComponente').value);

    if (componenteSeleccionadoTemporal && cant > 0) {
        componentesComboActual.push({
            id: componenteSeleccionadoTemporal.id,
            nombre: componenteSeleccionadoTemporal.nombre,
            cantidad: cant
        });
        dibujarTablaComponentes(); 

        componenteSeleccionadoTemporal = null;
        document.getElementById('inputBuscarComponente').value = "";
        document.getElementById('inputCantComponente').value = "1";
    } else {
        Swal.fire('Atención', 'Seleccione un producto del buscador primero.', 'info');
    }
}

function borrarComponenteUI(idx) {
    componentesComboActual.splice(idx, 1);
    dibujarTablaComponentes();
}

function dibujarTablaComponentes() {
    const tbody = document.getElementById('tablaComponentesCombo');
    tbody.innerHTML = '';

    if (componentesComboActual.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">Este producto no es un combo.</td></tr>';
        return;
    }

    componentesComboActual.forEach((c, idx) => {
        tbody.innerHTML += `
            <tr>
                <td>${c.nombre}</td>
                <td class="text-center fw-bold">${c.cantidad}</td>
                <td class="text-center">
                    <button type="button" class="btn btn-sm text-danger border-0" onclick="borrarComponenteUI(${idx})"><i class="bi bi-trash"></i></button>
                </td>
            </tr>
        `;
    });
}

// --- CARGAR PESTAÑA CENTRAL DE COMBOS ---
async function cargarListadoCombos() {
    try {
        const res = await apiFetch(`${obtenerBaseUrl()}/productos/listar_combos`);
        const data = await res.json();
        const tbody = document.getElementById('tablaListadoCombos');
        tbody.innerHTML = '';

        if (data.combos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No hay Combos ni Promociones armadas.</td></tr>';
            return;
        }

        data.combos.forEach(combo => {
            let componentesHtml = combo.componentes.map(c => `<span class="badge bg-secondary me-1">${c}</span>`).join('');
            tbody.innerHTML += `
                <tr>
                    <td class="fw-bold text-success">${combo.nombre}</td>
                    <td>${componentesHtml}</td>
                    <td class="fw-bold fs-6">$${combo.precio_venta_final.toFixed(2)}</td>
                    <td class="text-center">
                        <button class="btn btn-outline-primary btn-sm fw-bold" onclick="abrirEditarProducto(${combo.id})">
                            <i class="bi bi-pencil"></i> Editar
                        </button>
                        <button class="btn btn-outline-danger btn-sm fw-bold ms-1" onclick="desactivarProducto(${combo.id}, '${combo.nombre}')">
                            <i class="bi bi-trash"></i> Eliminar
                        </button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        console.error("Error cargando combos:", e);
    }
}

function limpiarFiltrosCatalogo() {
    if(document.getElementById('inputBuscarCatalogo')) document.getElementById('inputBuscarCatalogo').value = '';
    if(document.getElementById('selectFiltroCategoria')) document.getElementById('selectFiltroCategoria').value = '';
    if(document.getElementById('selectFiltroProveedor')) document.getElementById('selectFiltroProveedor').value = '';
    
    if(document.getElementById('filtroEstado')) document.getElementById('filtroEstado').value = '1';
    
    cargarCatalogo(1);
}

async function corregirLoteUI(id, lote, vence, stock, costo) {
    const { value: formValues } = await Swal.fire({
        target: document.getElementById('modalNuevoProducto'), 
        title: '<i class="bi bi-pencil-square text-primary"></i> Editar Lote',
        html: `
            <div class="text-start px-3 mt-2">
                <label class="form-label fw-bold small text-muted mb-1">N° Lote / Código Proveedor</label>
                <input id="swal-lote" class="form-control mb-3 border-primary shadow-sm" value="${lote}">

                <label class="form-label fw-bold small text-muted mb-1">Fecha de Vencimiento</label>
                <input id="swal-vence" type="date" class="form-control mb-3 border-primary shadow-sm" value="${vence}">

                <div class="row g-2">
                    <div class="col-6">
                        <label class="form-label fw-bold small text-muted mb-1">Stock Disp.</label>
                        <input id="swal-stock" type="number" class="form-control border-primary shadow-sm text-center fw-bold fs-5" value="${stock}">
                    </div>
                    <div class="col-6">
                        <label class="form-label fw-bold small text-muted mb-1">Costo Real</label>
                        <div class="input-group shadow-sm">
                            <span class="input-group-text border-primary bg-primary text-white">$</span>
                            <input id="swal-costo" type="number" class="form-control border-primary text-end fw-bold fs-5" value="${costo}">
                        </div>
                    </div>
                </div>
            </div>
        `,
        customClass: { popup: 'rounded-4 shadow-lg border-0', confirmButton: 'btn btn-success fw-bold px-4 me-2 fs-5', cancelButton: 'btn btn-secondary fw-bold px-4 fs-5' },
        buttonsStyling: false, focusConfirm: false, showCancelButton: true, confirmButtonText: '<i class="bi bi-check-circle"></i> Guardar', cancelButtonText: 'Cancelar',
        didOpen: () => {
            const popup = Swal.getPopup();
            const inputs = popup.querySelectorAll('input');
            inputs.forEach(input => { input.addEventListener('keypress', (e) => { if (e.key === 'Enter') Swal.clickConfirm(); }); });
            document.getElementById('swal-lote').focus();
        },
        preConfirm: () => {
            return {
                lote: document.getElementById('swal-lote').value,
                vence: document.getElementById('swal-vence').value,
                stock: parseFloat(document.getElementById('swal-stock').value),
                costo: parseFloat(document.getElementById('swal-costo').value)
            }
        }
    });

    if (formValues) {
        try {
            const res = await apiFetch(`${obtenerBaseUrl()}/productos/lotes/actualizar/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formValues)
            });
            const data = await res.json();
            
            if (!res.ok || data.error) throw new Error(data.error || 'Error en el servidor');

            Swal.fire({ title: '¡Corregido!', icon: 'success', timer: 1500, showConfirmButton: false });
            abrirEditarProducto(productoEditandoId, 'lotes'); 
        } catch (e) { 
            Swal.fire('Error', e.message || 'No se pudo actualizar.', 'error'); 
        }
    }
}

async function eliminarLoteUI(id) {
    const confirm = await Swal.fire({
        target: document.getElementById('modalNuevoProducto'),
        title: '¿Eliminar este lote?',
        text: "Esta acción no se puede deshacer y borrará el stock físicamente.",
        icon: 'warning', showCancelButton: true, confirmButtonColor: '#d33', confirmButtonText: 'SÍ, BORRAR'
    });

    if (confirm.isConfirmed) {
        try {
            const res = await apiFetch(`${obtenerBaseUrl()}/productos/lotes/eliminar/${id}`, { method: 'DELETE' });
            const data = await res.json();
            
            if (!res.ok || data.error) throw new Error(data.error || 'Error en el servidor');

            await Swal.fire({title: 'Eliminado', text: 'El lote desapareció del sistema.', icon: 'success', target: document.getElementById('modalNuevoProducto')});
            abrirEditarProducto(productoEditandoId, 'lotes'); 
            cargarCatalogo(); 
        } catch (e) { 
            Swal.fire('Error', e.message || 'No se pudo eliminar.', 'error'); 
        }
    }
}

async function clonarProducto(id) {
    await abrirEditarProducto(id, 'precios'); 
    
    productoEditandoId = null; 
    
    document.querySelector('#modalNuevoProducto .modal-title').innerHTML = `<i class="bi bi-files text-info"></i> Clonando Producto...`;
    document.getElementById('inputCodigo').value = ''; 
    document.getElementById('inputNombre').value += ' (Copia)';
    document.getElementById('inputNombre').select(); 
    
    document.getElementById('inputCodigo').removeAttribute('readonly');
    document.getElementById('inputCodigo').classList.remove('bg-light', 'text-muted');
    document.querySelector('button[onclick="generarCodigoInterno()"]').disabled = false;
    
    document.getElementById('btnAgregarLoteRapido').style.display = 'none';
    document.getElementById('msgLoteNuevo').style.display = 'block';
    document.querySelector('#tab-abm-lotes table tbody').innerHTML = '<tr><td colspan="6" class="text-muted">Ingresá el stock inicial aquí arriba.</td></tr>';
}

// ==========================================
// ESCANEO DIRECTO CON PISTOLA EN EL CATÁLOGO
// ==========================================
let bufferEscaneo = '';
let timeoutEscaneo = null;

document.addEventListener('keydown', async (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (document.querySelector('.modal.show')) return;
    if (!document.getElementById('tab-catalogo').classList.contains('active')) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') return;

    clearTimeout(timeoutEscaneo);
    timeoutEscaneo = setTimeout(() => { bufferEscaneo = ''; }, 50);

    if (e.key === 'Enter') {
        e.preventDefault();
        if (bufferEscaneo.length > 2) { 
            try {
                Swal.fire({ title: 'Buscando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
                
                const resp = await apiFetch(`${obtenerBaseUrl()}/productos/buscar?termino=${bufferEscaneo}`);
                const dataBusqueda = await resp.json();

                if (dataBusqueda.error || !dataBusqueda.productos || dataBusqueda.productos.length === 0) {
                    Swal.fire('No encontrado', 'El código escaneado no existe o el producto está inactivo.', 'warning');
                } else {
                    Swal.close();
                    abrirEditarProducto(dataBusqueda.productos[0].id, 'precios'); 
                }
            } catch (err) {
                Swal.fire('Error', 'Problema al buscar con la pistola.', 'error');
            }
        }
        bufferEscaneo = ''; 
    } else if (e.key.length === 1) { 
        bufferEscaneo += e.key; 
    }
});

// ARRANQUE FINAL DEL SCRIPT
document.addEventListener("DOMContentLoaded", () => {
    cargarCategoriasGlobales();
    cargarProveedoresGlobales();
    cargarCatalogo();
    cargarBotonesPOS();
});