let catalogoLocal = [];
let productoSeleccionado = null;
let colaImpresion = []; 
const colorInstitucional = "#1b365d";

let indiceBusqueda = -1;
let itemsBusquedaActuales = [];

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const token = localStorage.getItem('token') || localStorage.getItem('token_pos');
        const res = await fetch(`${obtenerBaseUrl()}/productos/listar`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        catalogoLocal = data.productos || [];
        await cargarColaDesdeDB();
    } catch (e) { console.error("Error cargando catálogo", e); }
});

async function cargarColaDesdeDB() {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/productos/etiquetas/listar`);
        const data = await res.json();
        const itemsDB = (data.cola || []).map(c => {
            return {
                id_db: c.cola_id, formato: c.formato === 'Cenefa' ? 'Cenefa_Normal' : 'Cartel_A4', copias: c.cantidad,
                textoExtra: c.texto_personalizado || '', esLibre: false, nombre: c.nombre, precio: c.precio_venta_final,
                codigo_barras: c.codigo_barras, producto_id: c.producto_id
            };
        });
        itemsDB.forEach(item => {
            const pReal = catalogoLocal.find(p => p.id === item.producto_id);
            if (pReal) {
                if (pReal.unidades_por_bulto > 1) {
                    item.precio = item.precio * pReal.unidades_por_bulto;
                    item.txtBulto = `PRECIO X CAJA CERRADA (${pReal.unidades_por_bulto} un.)`;
                }
                if (pReal.cant_promo) {
                    item.formato = item.formato === 'Cenefa_Normal' ? 'Cenefa_Doble' : item.formato;
                    item.precioMayo = pReal.precio_promo; item.cantMayo = pReal.cant_promo;
                }
            }
        });
        colaImpresion = colaImpresion.filter(c => c.esLibre); 
        colaImpresion = [...itemsDB, ...colaImpresion];
        dibujarCola();
    } catch (e) { console.error("Error cargando cola DB", e); }
}

function guardarLogoLocal(event) {
    const reader = new FileReader();
    reader.onload = (e) => {
        localStorage.setItem('logo_empresa_b64', e.target.result);
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Logo guardado en memoria', showConfirmButton: false, timer: 2000 });
        actualizarPreview();
    };
    reader.readAsDataURL(event.target.files[0]);
}

    function borrarLogoLocal() {
    localStorage.removeItem('logo_empresa_b64');
    Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'Logo eliminado', showConfirmButton: false, timer: 2000 });
    actualizarPreview();
}

// ESCUDO CONTRA EL BUG DE LAS FLECHAS
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
    if (busqueda.length < 2) { contenedor.classList.add('d-none'); itemsBusquedaActuales = []; return; }

    let palabras = busqueda.toLowerCase().split(" ").filter(p => p !== "");
    const filtrados = catalogoLocal.filter(p => {
        return palabras.every(pal => p.nombre.toLowerCase().includes(pal) || (p.codigo_barras && p.codigo_barras.includes(pal)));
    }).slice(0, 8);
    
    itemsBusquedaActuales = filtrados;
    contenedor.innerHTML = '';
    filtrados.forEach((p, idx) => {
        contenedor.innerHTML += `<button type="button" id="btn-busq-${idx}" class="list-group-item list-group-item-action small py-2" onmouseenter="indiceBusqueda = ${idx}; resaltarBusqueda();" onclick="seleccionarProd(${p.id})"><b>${p.codigo_barras || 'S/C'}</b> - ${p.nombre}</button>`;
    });
    contenedor.classList.remove('d-none');
}

document.getElementById('inputBuscarEtiqueta').addEventListener('keydown', (e) => {
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
    document.getElementById('inputBuscarEtiqueta').value = productoSeleccionado.nombre;
    document.getElementById('resultadosEtiqueta').classList.add('d-none');
    if (productoSeleccionado.cant_promo) document.getElementById('selectFormato').value = 'Cenefa_Doble';
    else document.getElementById('selectFormato').value = 'Cenefa_Normal';
    actualizarPreview();
}

function actualizarPreview() {
    const preview = document.getElementById('previewCanva');
    const formato = document.getElementById('selectFormato').value;
    const esLibre = document.getElementById('switchModoLibre').checked;
    const textoExtra = document.getElementById('inputTextoExtra').value.toUpperCase();
    const logo = localStorage.getItem('logo_empresa_b64');

    let nombre = "SELECCIONE PRODUCTO"; let precio = "0.00"; let esMayorista = false; let precioMayo = 0; let cantMayo = 0; let txtBulto = "";

    if (esLibre) {
        nombre = document.getElementById('libreTitulo').value || "TÍTULO MANUAL";
        precio = document.getElementById('librePrecio').value || "0.00";
    } else if (productoSeleccionado) {
        nombre = productoSeleccionado.nombre; precio = productoSeleccionado.precio_venta_final;
        if (productoSeleccionado.unidades_por_bulto > 1) { txtBulto = `X CAJA/BULTO CERRADO`; precio = precio * productoSeleccionado.unidades_por_bulto; }
        if (productoSeleccionado.cant_promo) { esMayorista = true; precioMayo = productoSeleccionado.precio_promo; cantMayo = productoSeleccionado.cant_promo; }
    }

    let pF = parseFloat(precio).toLocaleString('es-AR', {minimumFractionDigits: 2});
    let html = "";

    if (formato === "Cenefa_Normal") {
        html = `<div style="width: 150px; height: 60px; border: 1px solid #ccc; background: white; display:flex; flex-direction:column; align-items:center; position:relative;">
                    <div style="background:${colorInstitucional}; width:100%; color:white; font-size:5px; text-align:center; padding:1px 0;">AUTOSERVICIO 20 DE JUNIO</div>
                    ${textoExtra ? `<div style="background:#dc3545; color:white; font-size:6px; padding:2px 5px; border-radius:3px; margin-top:2px;">${textoExtra}</div>` : ''}
                    <div style="font-size: 8px; font-weight:bold; margin-top:auto; text-align:center; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${nombre}</div>
                    <div style="font-size: 16px; font-weight:900; margin-top:auto; padding-bottom:2px;">$${pF}</div>
                </div>`;
    } else if (formato === "Cenefa_Doble") {
        let mitadDerecha = esMayorista 
            ? `<div style="width:50%; background:${colorInstitucional}; color:white; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                <span style="background:#dc3545; border-radius:5px; padding:1px 4px; font-size:5px; margin-bottom:2px;">OFERTA MAYORISTA</span><span style="font-size:14px; font-weight:bold;">$${precioMayo}</span><span style="font-size:6px;">Llevando ${cantMayo} o más</span></div>` 
            : `<div style="width:50%; background:${colorInstitucional}; color:white; display:flex; align-items:center; justify-content:center; font-size:16px; font-weight:bold;">$${pF}</div>`;
            
        html = `<div style="width: 250px; height: 60px; border: 1px solid #333; display:flex; background:white;">
                    <div style="width:50%; padding:5px; text-align:center; display:flex; flex-direction:column; justify-content:center;">
                        ${textoExtra ? `<div style="font-size:6px; color:#dc3545; font-weight:bold;">${textoExtra}</div>` : '<div style="font-size:6px; color:#666; font-weight:bold;">PRECIO NORMAL</div>'}
                        <div style="font-size:8px; font-weight:bold;">${nombre}</div>
                        ${txtBulto ? `<div style="font-size:6px; color:red;">${txtBulto}</div>` : ''}
                        <div style="font-size:12px; font-weight:bold;">$${pF}</div>
                    </div>
                    ${mitadDerecha}
                </div>`;
    } else if (formato === "Cartel_A4") {
        html = `<div style="width: 100px; height: 140px; border: 3px solid ${colorInstitucional}; border-radius:8px; background:white; display:flex; flex-direction:column; align-items:center; padding:10px;">
                    ${logo ? `<img src="${logo}" style="max-height:20px; margin-bottom:5px;">` : `<div style="font-size:8px; font-weight:bold; color:${colorInstitucional};">Autoservicio</div>`}
                    <div style="font-size:8px; font-weight:bold; text-align:center; margin-top:10px;">${nombre}</div>
                    <div style="font-size:18px; font-weight:900; color:#198754; margin-top:auto;">$${pF}</div>
                </div>`;
    }
    preview.innerHTML = html;
}

// Lector de Base64 para la foto manual
const procesarFotoBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result); reader.onerror = reject;
});

async function agregarACola() {
    const esLibre = document.getElementById('switchModoLibre').checked;
    const formato = document.getElementById('selectFormato').value;
    const copias = parseInt(document.getElementById('inputCopias').value);
    const textoExtra = document.getElementById('inputTextoExtra').value;

    let item = { id: Date.now(), formato, copias, textoExtra, esLibre };

    if (esLibre) {
        item.nombre = document.getElementById('libreTitulo').value || "Cartel Manual";
        item.precio = document.getElementById('librePrecio').value || 0;
        item.codigo_barras = "";
        
        // Procesamos la foto si subió una
        const inputFotoLibre = document.getElementById('libreFoto');
        if (inputFotoLibre && inputFotoLibre.files.length > 0) {
            item.fotoManual = await procesarFotoBase64(inputFotoLibre.files[0]);
        }
    } else {
        if (!productoSeleccionado) return Swal.fire('Aviso', 'Seleccioná un producto primero.', 'warning');
        item.nombre = productoSeleccionado.nombre; item.precio = productoSeleccionado.precio_venta_final; item.codigo_barras = productoSeleccionado.codigo_barras;
        
        if (productoSeleccionado.unidades_por_bulto > 1) { item.precio = item.precio * productoSeleccionado.unidades_por_bulto; item.txtBulto = `PRECIO X CAJA CERRADA (${productoSeleccionado.unidades_por_bulto} un.)`; }
        if (productoSeleccionado.cant_promo) { item.precioMayo = productoSeleccionado.precio_promo; item.cantMayo = productoSeleccionado.cant_promo; }
    }

    colaImpresion.push(item); dibujarCola();
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Agregado a la cola', showConfirmButton: false, timer: 1000 });
}

async function vaciarCola() { try { await fetch(`${obtenerBaseUrl()}/productos/etiquetas/vaciar`, { method: 'DELETE' }); colaImpresion = []; dibujarCola(); } catch (e) { } }
async function borrarItemCola(idx) { 
    const item = colaImpresion[idx];
    if (!item.esLibre && item.id_db) { try { await fetch(`${obtenerBaseUrl()}/productos/etiquetas/eliminar/${item.id_db}`, { method: 'DELETE' }); } catch(e){} }
    colaImpresion.splice(idx, 1); dibujarCola(); 
}

function dibujarCola() {
    const tbody = document.querySelector('#tablaCola tbody'); tbody.innerHTML = '';
    if (colaImpresion.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="text-muted py-5">No hay carteles en cola.</td></tr>'; return; }
    colaImpresion.forEach((c, idx) => {
        let badge = c.formato.includes("Normal") ? "bg-secondary" : (c.formato.includes("Doble") ? "bg-primary" : "bg-success");
        let txtDB = c.id_db ? '<i class="bi bi-robot text-primary" title="Generado Automáticamente"></i>' : '';
        let fotito = c.fotoManual ? '<i class="bi bi-image text-info ms-1"></i>' : '';
        tbody.innerHTML += `<tr><td class="text-start ps-3 fw-bold">${txtDB} ${c.nombre} ${fotito}</td><td class="text-success fw-bold">$${parseFloat(c.precio).toFixed(2)}</td><td><span class="badge ${badge}">${c.formato.replace('_', ' ')}</span></td><td class="fw-bold">${c.copias}</td><td><button class="btn btn-sm text-danger border-0" onclick="borrarItemCola(${idx})"><i class="bi bi-trash"></i></button></td></tr>`;
    });
}

function imprimirTodo() {
    if (colaImpresion.length === 0) return Swal.fire('Aviso', 'La cola está vacía.', 'warning');
    const zona = document.getElementById('zonaImpresion'); const logo = localStorage.getItem('logo_empresa_b64');
    
    let html = `
        <style>
            @media print {
                @page { size: A4; margin: 0; }
                body { margin: 0; padding: 10mm; background: white !important; font-family: Arial, sans-serif; }
                #app-container, .main-wrapper, .modal, .d-print-none, .swal2-container { display: none !important; }
                #zonaImpresion { display: flex !important; flex-wrap: wrap; gap: 5mm; visibility: visible !important; position: absolute; left: 0; top: 0; width: 100%; }
                .cartel { page-break-inside: avoid; box-sizing: border-box; overflow: hidden; background: white !important; }
                .bg-print { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                .truncate-lines { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; }
            }
        </style>
    `;

    colaImpresion.forEach((item, idx) => {
        let pF = parseFloat(item.precio).toLocaleString('es-AR', {minimumFractionDigits: 2});
        let txExtra = item.textoExtra ? `<div class="bg-print" style="background:#dc3545; color:white; font-size:10px; font-weight:bold; text-align:center; text-transform:uppercase; padding:2px 5px; border-radius:3px; margin-bottom:2px;">${item.textoExtra}</div>` : '';
        let bultoHTML = item.txtBulto ? `<div style="font-size:9px; color:red; font-weight:bold; margin-bottom:2px; text-align:center;">${item.txtBulto}</div>` : '';

        for (let i = 0; i < item.copias; i++) {
            
            // PLANTILLA 1: CENEFA ESTÁNDAR
            if (item.formato === "Cenefa_Normal") {
                html += `
                    <div class="cartel" style="width: 100mm; height: 40mm; border: 1px solid #ddd; padding: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-start;">
                        <div class="bg-print" style="width: 100%; background: ${colorInstitucional}; color: white; font-size: 8px; font-weight: bold; text-align: center; text-transform: uppercase; padding: 1.5mm 0; letter-spacing: 1px;">Autoservicio 20 de Junio</div>
                        <div style="padding: 1mm 2mm; width: 100%; display: flex; flex-direction: column; align-items: center; height: 100%;">
                            ${txExtra}
                            <div class="truncate-lines" style="font-size: 11px; font-weight: bold; text-align: center; color: #333; line-height:1.1; margin-top:1mm; min-height: 8mm;">${item.nombre}</div>
                            ${bultoHTML}
                            <div style="font-size: 32px; font-weight: 900; line-height: 1; margin-top:auto; color: #000;">$${pF}</div>
                            ${item.codigo_barras ? `<svg id="bc-${idx}-${i}" style="height:9mm; width:65mm; margin:0; margin-top:auto;"></svg>` : ''}
                        </div>
                    </div>
                `;
            } 
            // PLANTILLA 2: CENEFA DOBLE 
            else if (item.formato === "Cenefa_Doble") {
                let mitadDer = item.cantMayo 
                    ? `<div class="bg-print" style="width: 50%; background: ${colorInstitucional}; color: white; display:flex; flex-direction:column; justify-content:center; align-items:center; padding: 2mm;">
                           <div class="bg-print" style="background:#dc3545; color:white; font-size:11px; font-weight:bold; text-transform:uppercase; padding: 2px 10px; border-radius: 10px; margin-bottom: 2mm; letter-spacing: 1px;">OFERTA LLEVANDO ${item.cantMayo}</div>
                           <div style="font-size:45px; font-weight:900; line-height:1;">$${parseFloat(item.precioMayo).toLocaleString('es-AR', {minimumFractionDigits:2})}</div>
                       </div>`
                    : `<div class="bg-print" style="width: 50%; background: ${colorInstitucional}; color: white; display:flex; align-items:center; justify-content:center; font-size:45px; font-weight:900;">$${pF}</div>`;

                html += `
                    <div class="cartel" style="width: 200mm; height: 40mm; border: 2px solid #333; display: flex; flex-direction: row; border-radius: 4px;">
                        <div style="width: 50%; padding: 2mm; display:flex; flex-direction:column; justify-content:center; align-items:center; border-right: 2px dashed #999; background: white;">
                            ${txExtra}
                            <div style="font-size: 10px; text-transform:uppercase; color: #666; font-weight:bold; background: #f0f0f0; padding: 2px 8px; border-radius: 4px; margin-bottom: 2mm;">PRECIO NORMAL</div>
                            <div class="truncate-lines" style="font-size: 14px; font-weight: bold; text-align: center; line-height:1.1; color:#333; margin-bottom: 1mm;">${item.nombre}</div>
                            ${bultoHTML}
                            <div style="font-size: 28px; font-weight: bold; color: #000; margin-bottom: 1mm;">$${pF}</div>
                            ${item.codigo_barras ? `<svg id="bc-${idx}-${i}" style="height:7mm; width:45mm; margin:0;"></svg>` : ''}
                        </div>
                        ${mitadDer}
                    </div>
                `;
            }
            else if (item.formato === "Cartel_A4") {
                let logoHTML = logo 
                    ? `<img src="${logo}" style="max-height: 40mm; object-fit: contain;">` 
                    : `<div style="font-size:30px; font-weight:900; color:${colorInstitucional}; text-transform:uppercase; letter-spacing: 2px;">Autoservicio 20 de Junio</div>`;

                // LA LÓGICA DE FUENTE DINÁMICA (Si es un número gordo, se achica para no desbordar)
                let fontSizePrecio = pF.length > 8 ? '100px' : (pF.length > 6 ? '120px' : '150px');
                
                // LA FOTO MANUAL SI EXISTE
                let imagenManualHTML = (item.esLibre && item.fotoManual) ? `<img src="${item.fotoManual}" style="max-height: 80mm; max-width:100%; object-fit: contain; margin-bottom: 5mm; border-radius: 15px; box-shadow: 0 10px 20px rgba(0,0,0,0.1);">` : '';

                html += `
                    <div class="cartel" style="width: 195mm; height: 280mm; border: 6px solid ${colorInstitucional}; border-radius: 20px; display: flex; flex-direction: column; align-items: center; padding: 0; text-align:center; position:relative; box-shadow: 0 0 20px rgba(0,0,0,0.1);">
                        
                        <div class="bg-print" style="width: 100%; padding: 10mm; border-bottom: 2px solid ${colorInstitucional}; display:flex; justify-content:center; align-items:center; background-color: #f8f9fa;">
                            ${logoHTML}
                        </div>

                        <div style="padding: 10mm; flex-grow: 1; display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%;">
                            ${txExtra ? `<div class="bg-print" style="background:#dc3545; color:white; font-size:35px; font-weight:900; padding:5mm 20mm; border-radius:15px; margin-bottom:10mm; text-transform:uppercase; letter-spacing:2px; box-shadow: 5px 5px 0px rgba(0,0,0,0.2);">${item.textoExtra}</div>` : ''}
                            
                            ${imagenManualHTML}
                            
                            <div style="font-size: 45px; font-weight: 900; color: #333; line-height: 1.1; margin-bottom: 5mm;">${item.nombre}</div>
                            ${item.txtBulto ? `<div style="font-size:25px; color:#dc3545; font-weight:bold; margin-bottom:5mm; border: 3px solid #dc3545; padding:3mm 10mm; border-radius:10px;">${item.txtBulto}</div>` : ''}
                            
                            <div style="font-size: ${fontSizePrecio}; font-weight: 900; color: #198754; line-height: 0.9; margin-top:auto; text-shadow: 4px 4px 0px rgba(0,0,0,0.1);">$${pF}</div>
                            
                            ${item.cantMayo ? `<div class="bg-print" style="margin-top:10mm; background:${colorInstitucional}; color:white; padding: 8mm; border-radius:15px; width:90%;"><div style="font-size:25px; font-weight:bold;">OFERTA MAYORISTA LLEVANDO ${item.cantMayo} UNIDADES</div><div style="font-size:60px; font-weight:900; margin-top:2mm;">$${item.precioMayo} c/u</div></div>` : ''}
                        </div>
                    </div>
                `;
            }
        }
    });

    zona.innerHTML = html;
    zona.classList.remove('d-none');


    colaImpresion.forEach((item, idx) => {
        if ((item.formato === "Cenefa_Normal" || item.formato === "Cenefa_Doble") && item.codigo_barras) {
            for (let i = 0; i < item.copias; i++) {
                try { 
                    JsBarcode(`#bc-${idx}-${i}`, item.codigo_barras, { 
                        format: "CODE128", 
                        width: 1.5, 
                        height: 30, 
                        displayValue: true, // ¡ACÁ ESTÁ LA MAGIA PARA QUE SE VEAN LOS NÚMEROS!
                        fontSize: 12,
                        textMargin: 1,
                        margin: 0 
                    }); 
                } catch (e) {}
            }
        }
    });

    Swal.fire({ title: 'Enviando a la impresora...', icon: 'info', timer: 1000, showConfirmButton: false }).then(() => {
        if (typeof require !== 'undefined') { const { ipcRenderer } = require('electron'); ipcRenderer.send('imprimir-silencioso', document.documentElement.outerHTML); } else { window.print(); }
        zona.classList.add('d-none'); zona.innerHTML = ''; vaciarCola(); 
    });
}