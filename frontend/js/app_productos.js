let productosGlobales = [];
let categoriasGlobales = []; // <-- NUEVO
let reglasMayoristas = [];
let productoEditandoId = null;
let colaEtiquetasActual = [];

// ==========================================
// ABM DE CATEGORÍAS (RUBROS)
// ==========================================
async function cargarCategoriasGlobales() {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/categorias`);
        const data = await res.json();
        categoriasGlobales = data.categorias || [];

        // 1. Selector Catálogo
        let selFiltro = document.getElementById('selectFiltroCategoria');
        if (selFiltro) {
            selFiltro.innerHTML = '<option value="">Todas las Categorías</option>';
            categoriasGlobales.forEach(c => selFiltro.innerHTML += `<option value="${c.id}">${c.nombre}</option>`);
        }

        // 2. Selector Modal ABM
        let selModal = document.getElementById('selectCategoria');
        if (selModal) {
            selModal.innerHTML = '';
            categoriasGlobales.forEach(c => selModal.innerHTML += `<option value="${c.id}">${c.nombre}</option>`);
        }

        // 3. PARCHE: Selectores Masivos (Necesitan el formato cat_ID para que no se rompan las búsquedas)
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
        const res = await fetch(`${obtenerBaseUrl()}/proveedores/listado`);
        const data = await res.json();
        const proveedoresReales = Array.isArray(data) ? data : (data.proveedores || []);

        let selModal = document.getElementById('selectProveedor');
        if (selModal) {
            // EL ARREGLO: Ponemos value="0" para que no choque con tu ID 1 ("El Molino")
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
    // Armamos una listita HTML con botón de borrar para cada categoría
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
        await fetch(`${obtenerBaseUrl()}/productos/categorias/crear`, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ nombre: nombre }) 
        });
        await cargarCategoriasGlobales(); // Recargamos la memoria
        gestionarCategoriasUI(); // Recargamos el cuadrito de SweetAlert
    } catch (e) { Swal.fire('Error', 'No se pudo crear.', 'error'); }
}

async function borrarCategoria(id, nombre) {
    if(!(await Swal.fire({title: `¿Borrar rubro ${nombre}?`, icon: 'warning', showCancelButton: true})).isConfirmed) return;
    try {
        await fetch(`${obtenerBaseUrl()}/productos/categorias/eliminar/${id}`, { method: 'DELETE' });
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

    // EL INTERRUPTOR CORRECTO PARA CADA PESTAÑA
    if (id === 'cat-pos') {
        cargarBotonesPOS();
    }
    if (id === 'combos') {
        cargarListadoCombos(); // <--- AHORA SÍ LLAMA A LOS COMBOS
    }
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
            // Si hay una alerta (Swal) abierta, ignoramos el Enter para que solo cierre la alerta
            if (typeof Swal !== 'undefined' && Swal.isVisible()) return;

            if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'TEXTAREA') { 
                e.preventDefault(); 
                
                // PARCHE LECTORA DE BARRAS: Si estamos en el código, pasamos al Nombre
                if (e.target.id === 'inputCodigo') {
                    document.getElementById('inputNombre').focus();
                    return; // Cortamos la orden acá para que no guarde
                }

                guardarProductoCompleto(); 
            }
        });

document.querySelector('[data-bs-target="#modalNuevoProducto"]').addEventListener('click', () => {
    // SACAMOS EL CANDADO
            document.querySelector('button[onclick="generarCodigoInterno()"]').disabled = false;
            document.getElementById('inputCodigo').removeAttribute('readonly');
            document.getElementById('inputCodigo').classList.remove('bg-light', 'text-muted');
            // Prendemos la varita mágica y liberamos el código
            productoEditandoId = null;
            document.querySelector('#modalNuevoProducto .modal-title').innerHTML = `<i class="bi bi-box-seam"></i> Alta de Producto`;
            cambiarPestanaAbm('precios');
            
            // LIMPIR TODO
            document.querySelectorAll('#modalNuevoProducto input').forEach(input => input.value = '');
            document.getElementById('selectUnidadMedida').value = 'Unidad'; 
            document.getElementById('selectCategoria').value = '1';
            document.getElementById('selectProveedor').value = '1';
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

async function cargarCatalogo() {
            try {
                let filtroElemento = document.getElementById('filtroEstado');
                let filtroSelect = filtroElemento ? filtroElemento.value : '1';
                
                let url = `${obtenerBaseUrl()}/productos/listar`;
                if (filtroSelect === 'critico') { 
                    url += '?estado=1&alerta_stock=true'; 
                } else if (filtroSelect === 'vencimiento') {
                    url += '?estado=1&alerta_vencimiento=true';
                } else { 
                    url += `?estado=${filtroSelect}`; 
                }
                
                const response = await fetch(url);
                const data = await response.json();
                productosGlobales = data.productos || [];
                
                if (typeof filtrarCatalogoFront === 'function') filtrarCatalogoFront(); 
                
                // PARCHE BLINDAJE: Llamamos a las demás funciones SOLO si existen 
                // y envueltas en un try para que nunca frenen la carga de la tabla principal
                try { if (typeof llenarSelectEtiquetas === 'function') llenarSelectEtiquetas(); } catch(e){}
                try { if (typeof llenarSelectComponentes === 'function') llenarSelectComponentes(); } catch(e){}
                
            } catch (error) { 
                console.error("Error crítico cargando catálogo:", error); 
            }
        }

// ========================================================
// 1. MAGIA EXPORTAR A EXCEL (CON SELECTOR DE COLUMNAS)
// ========================================================
function obtenerProductosFiltradosActuales() {
    let textoBusqueda = document.getElementById('inputBuscarCatalogo').value.toLowerCase().trim();
    let categoriaSeleccionada = document.getElementById('selectFiltroCategoria').value;
    let proveedorSeleccionado = document.getElementById('selectFiltroProveedor').value; 

    // 1. Separamos lo que tipeaste en palabras sueltas
    let palabras = textoBusqueda.split(" ").filter(p => p !== "");

    return productosGlobales.filter(p => {
        // 2. EL PARCHE INTELIGENTE: Verificamos que el producto contenga TODAS las palabras
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
                            <option value="todo">Catálogo completo (Todos)</option>
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
            // EL PARCHE DEL EXCEL: Le agregamos un ="..." para forzar a Excel a leerlo como Texto
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
        const res = await fetch(`${obtenerBaseUrl()}/productos/generar_codigo_interno`);
        const data = await res.json();
        if (data.codigo) { document.getElementById('inputCodigo').value = data.codigo; }
        else { Swal.fire('Error', 'Fallo al buscar código en la base.', 'warning'); }
    } catch (e) { Swal.fire('Error', 'Problema conectando con Python.', 'error'); }
}

function filtrarCatalogoFront() {
    // ¡ACÁ ESTÁ LA MAGIA! Cada vez que tocás una tecla o cambiás un filtro, volvemos a la página 1
    paginaActualProd = 1;

    let filtrados = obtenerProductosFiltradosActuales();
    let estSelect = document.getElementById('filtroEstado').value;
    
    // Le pasamos la lista filtrada a tu tabla para que dibuje solo los primeros 50
    dibujarTablaCatalogo(filtrados, estSelect);
}

// Variables globales para la paginación (ponelas arriba de todo en tu archivo)
let paginaActualProd = 1;
const itemsPorPagina = 50;
let ultimaListaFiltrada = []; // Guardamos la lista actual para poder cambiar de página
let ultimoEstadoSeleccionado = "1";

// TU FUNCIÓN FUSIONADA
function dibujarTablaCatalogo(listaProductos, estadoSeleccionado) {
    // Guardamos estos datos para cuando toquemos "Siguiente" o "Anterior"
    ultimaListaFiltrada = listaProductos;
    ultimoEstadoSeleccionado = estadoSeleccionado;

    const tbody = document.getElementById('tablaCatalogoBody');
    tbody.innerHTML = '';

    // --- 1. MATEMÁTICA DE PAGINACIÓN ---
    const totalPaginas = Math.ceil(listaProductos.length / itemsPorPagina);
    if (paginaActualProd > totalPaginas) paginaActualProd = totalPaginas;
    if (paginaActualProd < 1) paginaActualProd = 1;

    const inicio = (paginaActualProd - 1) * itemsPorPagina;
    const fin = inicio + itemsPorPagina;
    
    // Cortamos la lista para agarrar solo los 50 de esta página
    const listaPaginada = listaProductos.slice(inicio, fin);

    if(listaPaginada.length === 0) { 
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Sin resultados.</td></tr>'; 
        document.getElementById('paginacionProductos').innerHTML = ''; 
        return; 
    }

    const hoy = new Date();
    hoy.setHours(0,0,0,0);

    // --- 2. TU LÓGICA DE DIBUJO INTACTA ---
    listaPaginada.forEach(p => {
        let htmlPromo = p.cant_promo ? `<div class="text-success small mt-1 lh-1"><i class="bi bi-tags-fill"></i> Llevando ${p.cant_promo}: $${p.precio_promo} c/u</div>` : '';
        
        let stock = p.stock_total || 0;
        let minimo = p.stock_minimo_alerta || 0;
        
        // EL SEMÁFORO NORMAL
        let badgeClase = stock <= 0 ? 'bg-danger' : (stock <= minimo ? 'bg-warning text-dark' : 'bg-success');
        let textoStock = `${stock} ${p.unidad_medida === 'Unidad' ? 'un' : p.unidad_medida}`;
        let htmlLotes = p.cantidad_lotes > 1 ? `<div class="small text-muted mt-1 lh-1"><i class="bi bi-layers"></i> ${p.cantidad_lotes} Lotes</div>` : '';
        
        // --- LA INYECCIÓN PARA LOS COMBOS ---
        if (p.es_combo > 0) {
            badgeClase = 'bg-info text-dark border border-info shadow-sm';
            textoStock = '<i class="bi bi-boxes"></i> COMBO';
            htmlLotes = ''; // Ocultamos lo de los lotes porque el combo no tiene lote físico
        }
        // ------------------------------------
        
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

        // USAMOS textoStock EN VEZ DEL HARDCODEO
        tbody.innerHTML += `<tr class="${claseFila}"><td class="text-muted align-middle">${p.codigo_barras || 'S/C'}</td><td class="align-middle"><div class="fw-bold lh-1">${p.nombre}</div>${htmlPromo}${alertaVencHTML}</td><td class="align-middle"><span class="badge bg-primary">${nombreCat}</span></td><td class="text-end text-muted align-middle">$ ${costoF}</td><td class="text-end fw-bold text-success align-middle">$ ${precioF}</td><td class="text-center align-middle"><span class="badge ${badgeClase} rounded-pill px-3">${textoStock}</span>${htmlLotes}</td><td class="text-center align-middle">${botonesAccion}</td></tr>`;
    });

    // --- 3. DIBUJAR LOS BOTONES DE PÁGINA ---
    renderizarControlesPaginacion(totalPaginas);
}

// Dibuja los botones de Siguiente / Anterior
function renderizarControlesPaginacion(totalPaginas) {
    const contenedor = document.getElementById('paginacionProductos');
    if (!contenedor) return;

    if (totalPaginas <= 1) {
        contenedor.innerHTML = '';
        return;
    }

    let html = `<div class="btn-group shadow-sm">`;
    html += `<button class="btn btn-outline-primary ${paginaActualProd === 1 ? 'disabled' : ''}" 
                onclick="cambiarPaginaProd(${paginaActualProd - 1})"><i class="bi bi-chevron-left"></i> Anterior</button>`;
    
    html += `<span class="btn btn-light disabled text-dark fw-bold">Pág. ${paginaActualProd} de ${totalPaginas}</span>`;
    
    html += `<button class="btn btn-outline-primary ${paginaActualProd === totalPaginas ? 'disabled' : ''}" 
                onclick="cambiarPaginaProd(${paginaActualProd + 1})">Siguiente <i class="bi bi-chevron-right"></i></button>`;
    html += `</div>`;
    
    contenedor.innerHTML = html;
}

// Ejecuta el cambio de página y redibuja
function cambiarPaginaProd(nuevaPagina) {
    paginaActualProd = nuevaPagina;
    dibujarTablaCatalogo(ultimaListaFiltrada, ultimoEstadoSeleccionado);
    // Hacemos que la pantalla suba suavemente hasta el principio de la tabla
    document.querySelector('.content-area').scrollTo({ top: 0, behavior: 'smooth' });
}

// ==========================================
// CARTELERÍA Y ETIQUETAS
// ==========================================
function llenarSelectEtiquetas() {

    try {
    const select = document.getElementById('selectEtiquetaProducto');
    select.innerHTML = '<option value="">-- Seleccionar producto --</option>';
    productosGlobales.forEach(p => { select.innerHTML += `<option value="${p.id}">${p.nombre} ($${p.precio_venta_final.toFixed(2)})</option>`; });
    } catch (error) {
        console.warn("Se ignoró un error visual en cartelería:", error);
    }
}
function toggleOpcionesA4() {
    // Dejamos el panel extra SIEMPRE visible para poder escribir "Bulto x 6" en las cenefas
    document.getElementById('panelExtraA4').classList.remove('d-none');
    
    // Ocultamos solo la caja del "Precio Falso" si es una cenefa normal
    let inputFalso = document.getElementById('inputEtiquetaPrecioFalso');
    if (inputFalso && inputFalso.parentElement) {
        if (document.getElementById('selectEtiquetaFormato').value === "Oferta A4") { 
            inputFalso.parentElement.classList.remove('d-none'); 
        } else { 
            inputFalso.parentElement.classList.add('d-none'); 
            inputFalso.value = ""; 
        }
    }
}


async function cargarColaEtiquetas() { try { const data = await (await fetch(`${obtenerBaseUrl()}/productos/etiquetas/listar`)).json(); colaEtiquetasActual = data.cola || []; dibujarColaEtiquetas(); } catch (e) { } }

async function agregarEtiquetaManual() {
    // PARCHE: Ahora usamos la memoria del buscador inteligente
    const sId = etiquetaSeleccionadaTemporal;
    const form = document.getElementById('selectEtiquetaFormato').value;
    const cant = parseInt(document.getElementById('inputEtiquetaCant').value);
    const txt = document.getElementById('inputEtiquetaTexto').value;
    const pf = parseFloat(document.getElementById('inputEtiquetaPrecioFalso').value) || null;

    if (!sId || cant <= 0) return Swal.fire('Error', 'Busque y seleccione un producto primero.', 'warning');

    try {
        await fetch(`${obtenerBaseUrl()}/productos/etiquetas/encolar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ producto_id: sId, tipo_cartel: form, cantidad_copias: cant, texto_personalizado: txt }) });

        // Limpiamos los inputs y el buscador
        document.getElementById('inputEtiquetaTexto').value = "";
        document.getElementById('inputEtiquetaPrecioFalso').value = "";
        document.getElementById('inputBuscarEtiqueta').value = "";
        etiquetaSeleccionadaTemporal = null;

        await cargarColaEtiquetas();
        if (pf && form === "Oferta A4") { let u = colaEtiquetasActual[colaEtiquetasActual.length - 1]; if (u) u.precio_falso = pf; dibujarColaEtiquetas(); }
    } catch (e) {
        console.error("Error al encolar etiqueta", e);
    }
}
async function encolarMasivoCarteleria() {
    const ft = document.getElementById('etiquetaMasivaFiltro').value; const fId = parseInt(ft.split('_')[1]) || 0; const txt = document.getElementById('etiquetaMasivaPalabra').value.toLowerCase().trim();
    let fils = productosGlobales; if (ft.startsWith('cat')) fils = fils.filter(p => p.categoria_id === fId); if (txt) fils = fils.filter(p => p.nombre.toLowerCase().includes(txt));
    if (fils.length === 0) return Swal.fire('Sin resultados', '', 'info');
    Swal.fire({ title: 'Encolando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try { for (let p of fils) { await fetch(`${obtenerBaseUrl()}/productos/etiquetas/encolar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ producto_id: p.id, tipo_cartel: 'Cenefa', cantidad_copias: 1 }) }); } Swal.fire('¡Éxito!', `Encoladas.`, 'success'); cargarColaEtiquetas(); } catch (e) { }
}
async function vaciarColaEtiquetas() { try { await fetch(`${obtenerBaseUrl()}/productos/etiquetas/vaciar`, { method: 'DELETE' }); cargarColaEtiquetas(); } catch (e) { } }
async function eliminarDeColaFront(id) { try { await fetch(`${obtenerBaseUrl()}/productos/etiquetas/eliminar/${id}`, { method: 'DELETE' }); cargarColaEtiquetas(); } catch (e) { } }
function cargarFotoTemporal(event, idx) { const r = new FileReader(); r.onload = e => { colaEtiquetasActual[idx].foto_temporal = e.target.result; dibujarColaEtiquetas(); }; r.readAsDataURL(event.target.files[0]); }

function dibujarColaEtiquetas() {
    const tbody = document.querySelector('#tablaColaEtiquetas tbody'); tbody.innerHTML = '';
    if (colaEtiquetasActual.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="text-muted py-5">Cola vacía.</td></tr>'; return; }
    colaEtiquetasActual.forEach((item, idx) => {
        let p = item.precio_falso ? item.precio_falso : item.precio_venta_final;
        let b = item.formato === "Cenefa" ? "bg-secondary" : "bg-danger";
        let bp = item.precio_falso ? `<span class="badge bg-warning text-dark ms-2"><i class="bi bi-pencil"></i></span>` : '';
        let f = '';
        if (item.formato === "Oferta A4") {
            let tx = item.texto_personalizado ? `<div class="small mt-1 text-primary">${item.texto_personalizado}</div>` : '';
            let sub = item.foto_temporal ? `<span class="badge bg-success"><i class="bi bi-check"></i> Foto</span> <button class="btn btn-sm btn-outline-danger py-0 ms-1" onclick="colaEtiquetasActual[${idx}].foto_temporal=null; dibujarColaEtiquetas();"><i class="bi bi-trash"></i></button>` : `<label class="btn btn-sm btn-outline-primary py-0 mb-0" style="cursor:pointer;"><i class="bi bi-camera"></i> Foto <input type="file" class="d-none" accept="image/*" onchange="cargarFotoTemporal(event, ${idx})"></label>`;
            let pie = `<input type="text" class="form-control form-control-sm mt-1 text-center" style="font-size:0.75rem;" placeholder="Pie (Ej: Válido 24hs)" value="${item.leyenda_inferior || ''}" onchange="colaEtiquetasActual[${idx}].leyenda_inferior = this.value">`;
            f = sub + tx + pie;
        } else { f = '<span class="text-muted small">N/A</span>'; }
        tbody.innerHTML += `<tr><td class="text-start ps-3 fw-bold">${item.nombre}</td><td class="fw-bold text-success fs-5">$${p.toLocaleString('es-AR', { minimumFractionDigits: 2 })} ${bp}</td><td><span class="badge ${b}">${item.formato}</span></td><td class="text-center">${f}</td><td class="fw-bold fs-5">${item.cantidad}</td><td><button class="btn btn-sm text-danger border-0" onclick="eliminarDeColaFront(${item.cola_id})"><i class="bi bi-x-circle-fill"></i></button></td></tr>`;
    });
}
function lanzarImpresion(filtro) {
    let hay = colaEtiquetasActual.some(i => (filtro === "Solo Cenefas" && i.formato === "Cenefa") || (filtro === "Solo A4" && i.formato === "Oferta A4"));
    if (!hay) return Swal.fire('Aviso', `No hay etiquetas '${filtro}'.`, 'info');
    prepararHojaImpresion(filtro);
    Swal.fire({ title: 'Generando PDF', text: `Preparando ${filtro}...`, icon: 'info', timer: 800, showConfirmButton: false }).then(() => { window.print(); document.getElementById('hojaImpresionLimpia').innerHTML = ''; });
}
function prepararHojaImpresion(filtro) {
    const hoja = document.getElementById('hojaImpresionLimpia');
    hoja.innerHTML = ''; 

    let items = colaEtiquetasActual.filter(i => filtro === "Solo Cenefas" ? i.formato === "Cenefa" : i.formato === "Oferta A4");

    const columnas = parseInt(document.getElementById('selectColumnasCenefa').value) || 2;

    let contenedorHTML = `<div class="print-container" style="${filtro === 'Solo Cenefas' ? 
        `display: grid !important; grid-template-columns: repeat(${columnas}, 1fr) !important; gap: 4mm !important; width: 100% !important; max-width: 200mm !important; margin: 0 auto !important; padding-left: 12mm !important; padding-top: 5mm !important;` 
        : 'display: block !important;'}">`;

    // PRIMER BUCLE: Acá se dibuja el diseño HTML
    items.forEach((item, idxItem) => {
        let pMostrar = item.precio_falso ? item.precio_falso : item.precio_venta_final;
        let pMostrarF = pMostrar.toLocaleString('es-AR', {minimumFractionDigits: 2});
        let pRealF = item.precio_venta_final.toLocaleString('es-AR', {minimumFractionDigits: 2});

        let pG = productosGlobales.find(p => p.id === item.producto_id) || {}; 
        let tU = pG.unidad_medida && pG.unidad_medida !== "Unidad" ? ` x ${pG.unidad_medida}` : '';

        for(let i=0; i < item.cantidad; i++) {
            if(item.formato === "Cenefa") {
                // 1. Verificamos si hay texto personalizado (Ej: Bulto x 6)
                let txtBulto = item.texto_personalizado ? `<div style="font-size:9px; font-weight:bold; color:#1a365d; background:#e2e8f0; border-radius:3px; padding:1px 4px; display:inline-block; margin-bottom:2px;">📦 ${item.texto_personalizado}</div>` : '';
                
                // 2. Evaluamos qué diseño usar
                // 2. Evaluamos qué diseño usar
                        if (pG.cant_promo) {
                            // --- DISEÑO MAYORISTA BLINDADO (Posición Absoluta) ---
                            let pMayoristaF = pG.precio_promo.toLocaleString('es-AR', {minimumFractionDigits: 2});
                            
                            // Ajuste automático de fuente para que no desborde
                            let fontSizePromo = (columnas === 2) ? '26px' : '20px';
                            if (pMayoristaF.length > 7) fontSizePromo = (columnas === 2) ? '22px' : '16px';

                            contenedorHTML += `
                                <div class="print-cenefa" style="width: 100% !important; height: 38mm !important; border: 1px dashed #aaa; box-sizing: border-box !important; page-break-inside: avoid !important; background: white !important; font-family: Arial, sans-serif; position: relative; overflow: hidden;">
                                    
                                    <div style="position: absolute; top: 0; left: 0; width: 100%; height: 6mm; font-size:10px; font-weight:bold; text-align:center; background:white; color:#333; padding-top:1px; border-bottom: 2px solid #74acdf; box-sizing: border-box; white-space:nowrap; overflow:hidden;">
                                        ${item.nombre}${tU}
                                    </div>
                                    
                                    <div style="position: absolute; top: 6mm; left: 0; width: 55%; height: 32mm; background-color:#1a365d; color:white; display:flex; flex-direction:column; justify-content:center; align-items:center; border-right: 3px solid #eab308; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: 2px;">
                                        <div style="font-size:7px; text-transform:uppercase; color:#93c5fd; line-height: 1;">Precio Mayorista</div>
                                        <div style="font-size:${fontSizePromo}; font-weight:900; line-height:1.1; margin:2px 0; text-shadow: 1px 1px 0px rgba(0,0,0,0.3);">$${pMayoristaF}</div>
                                        <div style="font-size:8px; background:#dc2626; padding:1px 4px; border-radius:2px; font-weight:bold; line-height: 1;">Llevando ${pG.cant_promo} o más</div>
                                    </div>
                                    
                                    <div style="position: absolute; top: 6mm; left: 55%; width: 45%; height: 32mm; display:flex; flex-direction:column; justify-content:space-evenly; align-items:center; padding: 2px; box-sizing: border-box; background:white;">
                                        <div style="text-align:center; line-height: 1; margin-top:2px;">
                                            <div style="font-size:7px; color:#666;">Precio Minorista</div>
                                            <div style="font-size:11px; font-weight:bold; color:#333; text-decoration:line-through;">$${pMostrarF}</div>
                                        </div>
                                        ${txtBulto}
                                        <div style="width: 90%; height: 14px; margin-top:auto; margin-bottom: 2px;">
                                            <svg id="barcode-${idxItem}-${i}" style="width:100%; height:100%; margin:0;"></svg>
                                        </div>
                                    </div>
                                    
                                </div>
                            `;
                        } else {
                    // --- DISEÑO CLÁSICO (Sobrio y minimalista, sin promo) ---
                    let fontSizePrecio = (columnas === 2) ? '34px' : '26px';
                    if (pMostrarF.length > 8) fontSizePrecio = (columnas === 2) ? '28px' : '22px';

                    contenedorHTML += `
                        <div class="print-cenefa" style="width: 100% !important; height: 38mm !important; border: 1px dashed #aaa; padding: 2mm !important; text-align: center; overflow: hidden; box-sizing: border-box !important; page-break-inside: avoid !important; background: white !important;">
                            <div style="font-size:11px; font-weight:bold; white-space:nowrap; overflow:hidden;">${item.nombre}${tU}</div>
                            ${txtBulto}
                            <div style="font-size:${fontSizePrecio}; font-weight:900; line-height:1.1; margin-top:2px; letter-spacing:-0.5px; white-space:nowrap; overflow:hidden;">$${pMostrarF}</div>
                            <svg id="barcode-${idxItem}-${i}" style="height:22px; margin-top:0px;"></svg>
                        </div>
                    `;
                }
            } else if (item.formato === "Oferta A4") {
                let im = item.foto_temporal ? `<img src="${item.foto_temporal}" style="max-height:280px; max-width:100%; object-fit:contain; margin-bottom:20px; border-radius:15px;">` : '';
                let tx = item.texto_personalizado ? `<div style="font-size:40px; font-weight:bold; color:#0d6efd !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; margin-bottom:20px;">${item.texto_personalizado}</div>` : '';
                let lPie = item.leyenda_inferior ? `<div style="font-size:22px; color:#555 !important; margin-top:auto; padding-top:20px;">* ${item.leyenda_inferior}</div>` : '';
                
                let bloquePrecio = item.precio_falso ? `
                    <div style="font-size:50px; font-weight:bold; color:#888 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; text-decoration:line-through; margin-bottom:-10px;">$${pRealF}</div>
                    <div style="font-size:115px; font-weight:900; color:#dc3545 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; line-height:0.9; text-shadow:4px 4px 0px rgba(0,0,0,0.1);">$${pMostrarF}</div>
                ` : `<div style="font-size:115px; font-weight:900; color:#198754 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; line-height:0.8; text-shadow:3px 3px 0px rgba(0,0,0,0.1);">$${pMostrarF}</div>`;

                contenedorHTML += `
                    <div class="print-cartelA4" style="page-break-after: always !important; width: 100% !important; height: 95vh !important; display: flex !important; flex-direction: column !important; justify-content: center !important; align-items: center !important; text-align: center !important; border: 5px solid #198754 !important; padding: 40px !important; box-sizing: border-box !important; background: white !important; clear: both;">
                        <h1 style="font-size:110px; font-weight:900; color:#dc3545 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; text-transform:uppercase; margin-bottom:20px; line-height:0.9;">¡OFERTA!</h1>
                        ${tx}${im}<h2 style="font-size:65px; font-weight:bold; color:#333 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; margin-bottom:20px; line-height:1.1;">${item.nombre}${tU}</h2>
                        ${bloquePrecio}${lPie}
                    </div>
                `;
            }
        }
    });

    contenedorHTML += `</div>`;
    hoja.innerHTML = contenedorHTML;

    // SEGUNDO BUCLE: Acá se inyecta el código de barras real de la pistola
    items.forEach((item, idxItem) => { 
        if(item.formato === "Cenefa" && item.codigo_barras) { 
            for(let i=0; i < item.cantidad; i++) { 
                try { JsBarcode(`#barcode-${idxItem}-${i}`, item.codigo_barras, { format: "CODE128", width: 1.2, height: 22, displayValue: true, fontSize: 10, margin: 0 }); } catch (e) {} 
            } 
        } 
    });
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
        await fetch(`${obtenerBaseUrl()}/lotes/ingresar`, { 
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

        // 🧹 LIMPIEZA AUTOMÁTICA
        document.getElementById('inputNumLote').value = "";
        document.getElementById('inputCantLote').value = "";
        document.getElementById('inputCostoLote').value = "";
        
        // EL ARREGLO: Recargamos la tabla de lotes y el catálogo sin funciones inventadas
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

let idsExcluidosMasiva = []; // Memoria para la lista negra

// NUEVA FUNCION PARA EL ICONO
function cambiarIconoAjuste() {
    const esFijo = document.getElementById('masivaTipoFijo').checked;
    const icono = document.getElementById('iconoAjusteMasivo');
    icono.innerText = esFijo ? '$' : '%';
    icono.className = esFijo ? 'input-group-text fw-bold text-success' : 'input-group-text fw-bold text-primary';
}

async function simularAjusteMasivo() {
    idsExcluidosMasiva = []; // Reseteamos la lista negra cada vez que simulamos
    
    const valorAjuste = parseFloat(document.getElementById('masivaValor').value);
    const esFijo = document.getElementById('masivaTipoFijo').checked; 
    
    if (isNaN(valorAjuste)) return Swal.fire('Error', 'Ingresá un valor válido', 'warning');

    const tb = document.querySelector('#tablaSimulacion tbody');
    tb.innerHTML = '';

    const filtroVal = document.getElementById('masivaFiltro').value || "todo_0";
    const tipoFiltro = filtroVal.split('_')[0]; 
    const filtroId = parseInt(filtroVal.split('_')[1]) || 0;
    const busqueda = document.getElementById('masivaPalabra').value.toLowerCase().trim();

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
            if (afCosto) nC = valorAjuste;
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

// NUEVA FUNCIÓN: Al tocar la crucecita, lo borra visualmente y lo anota en la lista negra
function quitarDeSimulacion(id, btnElement) {
    idsExcluidosMasiva.push(id);
    btnElement.closest('tr').remove();
    
    // Restamos 1 al contador azul de arriba
    const contadorActual = parseInt(document.getElementById('simuladorContador').innerText);
    document.getElementById('simuladorContador').innerText = `${contadorActual - 1} productos afectados`;
    
    // Si borraste todos a mano, escondemos el botón de guardar
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
    const esFijo = document.getElementById('masivaTipoFijo').checked; 
    
    try { 
        await fetch(`${obtenerBaseUrl()}/productos/actualizacion_masiva`, { 
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                porcentaje: valorNum, 
                tipo_filtro: tF, 
                filtro_id: fId, 
                afectar_costo: afCosto, 
                palabra_clave: pal, 
                es_monto_fijo: esFijo,
                excluir_ids: idsExcluidosMasiva // <-- Mandamos la lista negra a Python
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
        const response = await fetch(`${obtenerBaseUrl()}/productos/ver/${id}`);
        const p = await response.json(); 
        if (p.error) throw new Error(p.error);

const codigoActual = p.codigo_barras || "";
        document.getElementById('inputCodigo').value = codigoActual;
        
        const btnGenerarCodigo = document.querySelector('button[onclick="generarCodigoInterno()"]');
        
        if (codigoActual.trim() !== "") {
            // Si YA TIENE código, ponemos el candado para que no lo rompan
            document.getElementById('inputCodigo').setAttribute('readonly', true);
            document.getElementById('inputCodigo').classList.add('bg-light', 'text-muted');
            if (btnGenerarCodigo) btnGenerarCodigo.disabled = true;
        } else {
            // Si está VACÍO, abrimos el candado para que lo puedas cargar
            document.getElementById('inputCodigo').removeAttribute('readonly');
            document.getElementById('inputCodigo').classList.remove('bg-light', 'text-muted');
            if (btnGenerarCodigo) btnGenerarCodigo.disabled = false;
        }
        document.getElementById('inputNombre').value = p.nombre;
        
        // REFUERZO: Esperamos pacientemente a que la lista cargue antes de asignar
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
        document.getElementById('inputCosto').value = p.costo_sin_iva;
// --- BLINDAJE DEL IVA ---
        let ivaLimpio = p.porcentaje_iva;
        if (ivaLimpio === null || ivaLimpio === undefined || ivaLimpio === "") ivaLimpio = 21; // Si viene vacío, asume 21
        if (ivaLimpio > 0 && ivaLimpio <= 1) ivaLimpio = ivaLimpio * 100;  // Si Python manda 0.21, lo convierte a 21

        let ivaFinal = parseFloat(ivaLimpio);
        let campoIva = document.getElementById('inputIva');
        
        // Intento 1: Buscar como número entero/limpio (Ej: "21" o "10.5")
        campoIva.value = ivaFinal; 
        
        // Intento 2: Si falló y quedó vacío, buscar con un decimal (Ej: "21.0")
        if (campoIva.value === "" || campoIva.selectedIndex === -1) {
            campoIva.value = ivaFinal.toFixed(1); 
        }
        
        // Intento 3: Si sigue fallando, buscar con dos decimales (Ej: "21.00")
        if (campoIva.value === "" || campoIva.selectedIndex === -1) {
            campoIva.value = ivaFinal.toFixed(2); 
        }

        document.getElementById('inputPrecioVenta').value = p.precio_venta_final;

        // ---> LA MATEMÁTICA CORRECTA DEL MARGEN <---
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

                // EL CANDADO DE SEGURIDAD: Solo el ADMIN ve los botones de Lápiz y Tacho
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
            const resHist = await fetch(`${obtenerBaseUrl()}/productos/movimientos/${id}`);
            const dataHist = await resHist.json();
            
            const tbHist = document.getElementById('tablaHistorialProd');
            tbHist.innerHTML = '';
            
            // EL DETECTOR DE MENTIRAS: Si Python tira error, frenamos todo y lo mostramos
            if (dataHist.error) throw new Error(dataHist.error);
            
            if (dataHist.movimientos && dataHist.movimientos.length > 0) {
                dataHist.movimientos.forEach(m => {
                    let color = m.tipo_movimiento.toLowerCase().includes('ingreso') ? 'text-success' : 'text-danger';
                    let signo = m.tipo_movimiento.toLowerCase().includes('ingreso') ? '+' : '-';
                    
                    // EL ARREGLO: Leemos "m.motivo"
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

    // Aseguramos que los IDs sean números reales y no "NaN" (que rompen el guardado)
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
            res = await fetch(`${obtenerBaseUrl()}/productos/crear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
        } else { 
            res = await fetch(`${obtenerBaseUrl()}/productos/actualizar/${productoEditandoId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); 
        }
        
        const data = await res.json();
        if (data.error) throw new Error(data.error); 
        
        await Swal.fire('¡Éxito!', 'Guardado correctamente.', 'success'); 
        cargarCatalogo(); 
        cargarColaEtiquetas();
        bootstrap.Modal.getInstance(document.getElementById('modalNuevoProducto')).hide();
    } catch (e) {
        Swal.fire('Error al guardar', e.message, 'error');
    }
}

async function desactivarProducto(id, n) { if ((await Swal.fire({ title: '¿Ocultar?', icon: 'warning', showCancelButton: true })).isConfirmed) { await fetch(`${obtenerBaseUrl()}/productos/eliminar/${id}`, { method: 'DELETE' }); cargarCatalogo(); cargarListadoCombos(); } }
async function restaurarProducto(id, n) { if ((await Swal.fire({ title: '¿Restaurar?', icon: 'question', showCancelButton: true })).isConfirmed) { await fetch(`${obtenerBaseUrl()}/productos/restaurar/${id}`, { method: 'PUT' }); cargarCatalogo(); cargarListadoCombos(); } }

// ==========================================
// SISTEMA DE MERMAS (RECUPERADO)
// ==========================================
async function abrirModalMerma(id, nombre) {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/ver/${id}`);
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
        
        // ¡ACÁ ESTABA EL ERROR! Borramos la línea que pedía el mermaPin.

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

    // Ya no le pegamos el texto del PIN, solo la observación
    const motivoCompleto = obs ? `${motivo} - Obs: ${obs}` : motivo;
    const usuarioId = localStorage.getItem('usuario_id') || 1;

    try {
        const res = await fetch(`${obtenerBaseUrl()}/lotes/baja_manual`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lote_id: loteId, cantidad_a_bajar: cantidad, motivo: motivoCompleto, usuario_id: parseInt(usuarioId) })
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        await Swal.fire('¡Merma Registrada!', 'El stock fue descontado y registrado en la auditoría.', 'success');
        bootstrap.Modal.getInstance(document.getElementById('modalMerma')).hide();
        cargarCatalogo();
    } catch (error) {
        Swal.fire('Error', error.message || 'No se pudo procesar la baja.', 'error');
    }
}

async function forzarDescargaRapida() {
    try {
        Swal.fire({ title: 'Descargando...', text: 'Buscando cambios en la nube', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        
        // Acá ponés la ruta exacta que usaba la flechita de tu POS
        const res = await fetch(`${obtenerBaseUrl()}/sync/actualizar-rapido`, { method: 'POST' }); 
        
        if (!res.ok) throw new Error("Fallo en la descarga");
        
        // Recargamos las memorias para que la tabla muestre los precios nuevos
        await cargarCategoriasGlobales();
        await cargarCatalogo(); 
        
        Swal.fire('¡Actualizado!', 'Tu catálogo ya tiene los datos de la nube.', 'success');
    } catch (e) {
        Swal.fire('Error', 'No se pudo conectar rápido con la nube.', 'error');
    }
}

// --- CARGAR BOTONES POS ---
async function cargarBotonesPOS() {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/categorias_pos`);
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
        await fetch(`${obtenerBaseUrl()}/productos/categorias_pos/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nombre, palabra_clave: clave, icono: iconoActual, color_fondo: color })
        });
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Botón actualizado', showConfirmButton: false, timer: 1500 });
        cargarBotonesPOS(); // Recarga la tablita
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

    const filtrados = productosGlobales.filter(p =>
        p.nombre.toLowerCase().includes(busqueda.toLowerCase()) ||
        (p.codigo_barras && p.codigo_barras.includes(busqueda))
    ).slice(0, 10);

    contenedor.innerHTML = '';
    filtrados.forEach(p => {
        contenedor.innerHTML += `
            <button type="button" class="list-group-item list-group-item-action small py-1" 
                onclick="seleccionarComponente(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')">
                <b>${p.codigo_barras || 'S/C'}</b> - ${p.nombre} ($${p.precio_venta_final})
            </button>`;
    });
    contenedor.classList.remove('d-none');
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
        dibujarTablaComponentes(); // <-- Esto era lo que faltaba y no dejaba que se vea!

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

    let costoSugerido = 0;
    let precioSugerido = 0;

    if (componentesComboActual.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">Este producto no es un combo.</td></tr>';
        return;
    }

    componentesComboActual.forEach((c, idx) => {
        // Buscamos el producto real en la memoria para saber su costo/precio
        const pReal = productosGlobales.find(p => p.id === c.id);
        if (pReal) {
            costoSugerido += (pReal.costo_sin_iva * c.cantidad);
            precioSugerido += (pReal.precio_venta_final * c.cantidad);
        }

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

    // PARCHE: Autocompletar la pestaña de Precios para que no de error
    document.getElementById('inputCosto').value = costoSugerido.toFixed(2);
    // Sugerimos el precio sin descuento, el usuario después lo baja a mano
    if (!productoEditandoId) {
        document.getElementById('inputPrecioVenta').value = precioSugerido.toFixed(2);
        calcularPrecioAutomatico(); // Esto calcula el margen automáticamente
    }
}

// --- CARGAR PESTAÑA CENTRAL DE COMBOS ---
async function cargarListadoCombos() {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/listar_combos`);
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

// ==========================================
// BUSCADOR INTELIGENTE PARA CARTELERÍA
// ==========================================
let etiquetaSeleccionadaTemporal = null;

function buscarParaEtiqueta(q) {
    const res = document.getElementById('resultadosEtiqueta');
    if (q.length < 2) { res.classList.add('d-none'); return; }
    const filtrados = productosGlobales.filter(p => p.nombre.toLowerCase().includes(q.toLowerCase()) || (p.codigo_barras && p.codigo_barras.includes(q))).slice(0, 10);
    res.innerHTML = '';
    filtrados.forEach(p => {
        res.innerHTML += `<button type="button" class="list-group-item list-group-item-action small" onclick="seleccionarParaEtiqueta(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')"><b>${p.codigo_barras || 'S/C'}</b> - ${p.nombre}</button>`;
    });
    res.classList.remove('d-none');
}

function seleccionarParaEtiqueta(id, nombre) {
    etiquetaSeleccionadaTemporal = id;
    document.getElementById('inputBuscarEtiqueta').value = nombre;
    document.getElementById('resultadosEtiqueta').classList.add('d-none');
}

function limpiarFiltrosCatalogo() {
    // Vaciamos todos los campos visuales
    if(document.getElementById('inputBuscarCatalogo')) document.getElementById('inputBuscarCatalogo').value = '';
    if(document.getElementById('selectFiltroCategoria')) document.getElementById('selectFiltroCategoria').value = '';
    if(document.getElementById('selectFiltroProveedor')) document.getElementById('selectFiltroProveedor').value = '';
    
    // Dejamos el estado en "Activos" por defecto
    if(document.getElementById('filtroEstado')) document.getElementById('filtroEstado').value = '1';
    
    // Recargamos el catálogo desde cero
    cargarCatalogo();
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
            // ARREGLO: La ruta correcta es /productos/lotes/actualizar
            const res = await fetch(`${obtenerBaseUrl()}/productos/lotes/actualizar/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formValues)
            });
            const data = await res.json();
            
            // DETECTOR DE MENTIRAS: Si algo falló en Python, tiramos error real
            if (!res.ok || data.error) throw new Error(data.error || 'Error en el servidor');

            Swal.fire({ title: '¡Corregido!', icon: 'success', timer: 1500, showConfirmButton: false });
            abrirEditarProducto(productoEditandoId, 'lotes'); // Recargamos el fondo
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
            // ARREGLO: La ruta correcta es /productos/lotes/eliminar
            const res = await fetch(`${obtenerBaseUrl()}/productos/lotes/eliminar/${id}`, { method: 'DELETE' });
            const data = await res.json();
            
            // DETECTOR DE MENTIRAS
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
    // 1. Reutilizamos tu función para que llene todo el formulario
    await abrirEditarProducto(id, 'precios'); 
    
    // 2. LA TRAMPA: Le borramos la memoria para que crea que es un producto nuevo
    productoEditandoId = null; 
    
    // 3. Limpiamos la identidad (código, nombre y lotes viejos)
    document.querySelector('#modalNuevoProducto .modal-title').innerHTML = `<i class="bi bi-files text-info"></i> Clonando Producto...`;
    document.getElementById('inputCodigo').value = ''; 
    document.getElementById('inputNombre').value += ' (Copia)';
    document.getElementById('inputNombre').select(); // Selecciona el texto para que escribas rápido
    
    // 4. Liberamos los candados
    document.getElementById('inputCodigo').removeAttribute('readonly');
    document.getElementById('inputCodigo').classList.remove('bg-light', 'text-muted');
    document.querySelector('button[onclick="generarCodigoInterno()"]').disabled = false;
    
    // 5. Ocultamos los lotes del producto viejo
    document.getElementById('btnAgregarLoteRapido').style.display = 'none';
    document.getElementById('msgLoteNuevo').style.display = 'block';
    document.querySelector('#tab-abm-lotes table tbody').innerHTML = '<tr><td colspan="6" class="text-muted">Ingresá el stock inicial aquí arriba.</td></tr>';
}

// ==========================================
// NAVEGACIÓN POR FLECHAS (PAGINACIÓN)
// ==========================================
document.addEventListener('keydown', (e) => {
    // Si el usuario está escribiendo en el buscador o en algún formulario, frenamos para no molestarlo
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    
    // Si hay alguna ventana flotante abierta (como la de Nuevo Producto), frenamos
    if (document.querySelector('.modal.show')) return;

    // Solo navegamos si estamos en la pestaña del catálogo
    if (!document.getElementById('tab-catalogo').classList.contains('active')) return;

    const totalPaginas = Math.ceil(ultimaListaFiltrada.length / itemsPorPagina);

    if (e.key === 'ArrowRight') {
        e.preventDefault(); // Evita que la pantalla se mueva a la derecha
        if (paginaActualProd < totalPaginas) cambiarPaginaProd(paginaActualProd + 1);
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault(); // Evita que la pantalla se mueva a la izquierda
        if (paginaActualProd > 1) cambiarPaginaProd(paginaActualProd - 1);
    }
});

// ==========================================
// ESCANEO DIRECTO CON PISTOLA EN EL CATÁLOGO
// ==========================================
let bufferEscaneo = '';
let timeoutEscaneo = null;

document.addEventListener('keydown', async (e) => {
    // Si estás escribiendo o hay ventanas abiertas, la pistola no interrumpe
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (document.querySelector('.modal.show')) return;
    if (!document.getElementById('tab-catalogo').classList.contains('active')) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') return;

    // La pistola escribe rapidísimo (menos de 50ms). Si tardás más, asumimos que fue un humano y borramos la memoria.
    clearTimeout(timeoutEscaneo);
    timeoutEscaneo = setTimeout(() => { bufferEscaneo = ''; }, 50);

    if (e.key === 'Enter') {
        e.preventDefault();
        if (bufferEscaneo.length > 2) { 
            try {
                Swal.fire({ title: 'Buscando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
                const resp = await fetch(`${obtenerBaseUrl()}/productos/buscar?termino=${bufferEscaneo}`);
                const prod = await res.json();

                if (prod.error) {
                    Swal.fire('No encontrado', 'El código escaneado no existe.', 'warning');
                } else {
                    Swal.close();
                    abrirEditarProducto(prod.id, 'precios'); // Abre la ventanita mágica automáticamente
                }
            } catch (err) {
                Swal.fire('Error', 'Problema al buscar con la pistola.', 'error');
            }
        }
        bufferEscaneo = ''; 
    } else if (e.key.length === 1) { 
        bufferEscaneo += e.key; // Guarda la letra/número en la memoria rápida
    }
});

// ARRANQUE FINAL DEL SCRIPT
document.addEventListener("DOMContentLoaded", () => {
    cargarCategoriasGlobales();
    cargarProveedoresGlobales();
    cargarCatalogo();
    cargarColaEtiquetas();
    cargarBotonesPOS();
});