let catalogoLocal = [];
let productoSeleccionado = null;
let colaImpresion = [];
const colorInstitucional = "#1b365d"; // Tu azul petróleo / navy blue

// --- 1. ARRANQUE Y CARGA DE DATOS ---
document.addEventListener("DOMContentLoaded", async () => {
    try {
        const token = localStorage.getItem('token') || localStorage.getItem('token_pos');
        const res = await fetch(`${obtenerBaseUrl()}/productos/listar`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        catalogoLocal = data.productos || [];
    } catch (e) {
        console.error("Error cargando catálogo para cartelería", e);
    }
});

// --- 2. EL LOGO EN MEMORIA ---
function guardarLogoLocal(event) {
    const reader = new FileReader();
    reader.onload = (e) => {
        localStorage.setItem('logo_empresa_b64', e.target.result);
        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Logo guardado en memoria', showConfirmButton: false, timer: 2000 });
        actualizarPreview();
    };
    reader.readAsDataURL(event.target.files[0]);
}

// --- 3. BUSCADOR INTELIGENTE Y MODO LIBRE ---
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
    if (busqueda.length < 2) { contenedor.classList.add('d-none'); return; }

    const filtrados = catalogoLocal.filter(p => p.nombre.toLowerCase().includes(busqueda.toLowerCase()) || (p.codigo_barras && p.codigo_barras.includes(busqueda))).slice(0, 8);
    
    contenedor.innerHTML = '';
    filtrados.forEach(p => {
        contenedor.innerHTML += `<button type="button" class="list-group-item list-group-item-action small py-2" onclick="seleccionarProd(${p.id})"><b>${p.codigo_barras || 'S/C'}</b> - ${p.nombre}</button>`;
    });
    contenedor.classList.remove('d-none');
}

function seleccionarProd(id) {
    productoSeleccionado = catalogoLocal.find(p => p.id === id);
    document.getElementById('inputBuscarEtiqueta').value = productoSeleccionado.nombre;
    document.getElementById('resultadosEtiqueta').classList.add('d-none');
    actualizarPreview();
}

// --- 4. VISTA PREVIA (Miniaturas de Referencia) ---
function actualizarPreview() {
    const preview = document.getElementById('previewCanva');
    const formato = document.getElementById('selectFormato').value;
    const esLibre = document.getElementById('switchModoLibre').checked;
    const textoExtra = document.getElementById('inputTextoExtra').value.toUpperCase();
    const logo = localStorage.getItem('logo_empresa_b64');

    let nombre = "SELECCIONE PRODUCTO";
    let precio = "0.00";
    let esMayorista = false;
    let precioMayo = 0;
    let cantMayo = 0;
    let txtBulto = "";

    if (esLibre) {
        nombre = document.getElementById('libreTitulo').value || "TÍTULO MANUAL";
        precio = document.getElementById('librePrecio').value || "0.00";
    } else if (productoSeleccionado) {
        nombre = productoSeleccionado.nombre;
        precio = productoSeleccionado.precio_venta_final;
        // Si el bulto trae más de 1, lo avisamos automáticamente
        if (productoSeleccionado.unidades_por_bulto > 1) {
            txtBulto = `CAJA/BULTO X ${productoSeleccionado.unidades_por_bulto}`;
            precio = precio * productoSeleccionado.unidades_por_bulto; // Multiplica solo!
        }
        // Detecta si tiene promo
        if (productoSeleccionado.cant_promo) {
            esMayorista = true;
            precioMayo = productoSeleccionado.precio_promo;
            cantMayo = productoSeleccionado.cant_promo;
        }
    }

    let pF = parseFloat(precio).toLocaleString('es-AR', {minimumFractionDigits: 2});
    let html = "";

    if (formato === "Cenefa_Normal") {
        html = `<div style="width: 150px; height: 60px; border: 1px solid #ccc; background: white; border-left: 5px solid ${colorInstitucional}; display:flex; flex-direction:column; align-items:center; justify-content:center; position:relative;">
                    ${textoExtra ? `<div style="background:${colorInstitucional}; color:white; font-size:6px; padding:2px; position:absolute; top:0;">${textoExtra}</div>` : ''}
                    <div style="font-size: 8px; font-weight:bold; margin-top:5px;">${nombre}</div>
                    <div style="font-size: 16px; font-weight:900;">$${pF}</div>
                </div>`;
    } else if (formato === "Cenefa_Doble") {
        let mitadDerecha = esMayorista 
            ? `<div style="width:50%; background:${colorInstitucional}; color:white; display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:7px;"><span>Llevando ${cantMayo}</span><span style="font-size:14px; font-weight:bold;">$${precioMayo}</span></div>` 
            : `<div style="width:50%; background:${colorInstitucional}; color:white; display:flex; align-items:center; justify-content:center; font-size:16px; font-weight:bold;">$${pF}</div>`;
            
        html = `<div style="width: 250px; height: 60px; border: 1px solid #333; display:flex; background:white;">
                    <div style="width:50%; padding:5px; text-align:center; display:flex; flex-direction:column; justify-content:center;">
                        <div style="font-size:8px; font-weight:bold;">${nombre}</div>
                        ${txtBulto ? `<div style="font-size:6px; color:red;">${txtBulto}</div>` : ''}
                        <div style="font-size:12px; font-weight:bold;">$${pF}</div>
                    </div>
                    ${mitadDerecha}
                </div>`;
    } else if (formato === "Cartel_A4") {
        html = `<div style="width: 100px; height: 140px; border: 3px solid ${colorInstitucional}; background:white; display:flex; flex-direction:column; align-items:center; padding:10px;">
                    ${logo ? `<img src="${logo}" style="max-height:20px; margin-bottom:5px;">` : `<div style="font-size:8px; font-weight:bold; color:${colorInstitucional};">Autoservicio</div>`}
                    <div style="font-size:8px; font-weight:bold; text-align:center; margin-top:10px;">${nombre}</div>
                    <div style="font-size:18px; font-weight:900; color:#198754; margin-top:auto;">$${pF}</div>
                </div>`;
    }

    preview.innerHTML = html;
}

// --- 5. LÓGICA DE COLA ---
function agregarACola() {
    const esLibre = document.getElementById('switchModoLibre').checked;
    const formato = document.getElementById('selectFormato').value;
    const copias = parseInt(document.getElementById('inputCopias').value);
    const textoExtra = document.getElementById('inputTextoExtra').value;

    let item = { id: Date.now(), formato, copias, textoExtra, esLibre };

    if (esLibre) {
        item.nombre = document.getElementById('libreTitulo').value || "Cartel Manual";
        item.precio = document.getElementById('librePrecio').value || 0;
        item.codigo_barras = "";
    } else {
        if (!productoSeleccionado) return Swal.fire('Aviso', 'Seleccioná un producto primero.', 'warning');
        item.nombre = productoSeleccionado.nombre;
        item.precio = productoSeleccionado.precio_venta_final;
        item.codigo_barras = productoSeleccionado.codigo_barras;
        
        if (productoSeleccionado.unidades_por_bulto > 1) {
            item.precio = item.precio * productoSeleccionado.unidades_por_bulto;
            item.txtBulto = `CAJA/BULTO X ${productoSeleccionado.unidades_por_bulto}`;
        }
        if (productoSeleccionado.cant_promo) {
            item.precioMayo = productoSeleccionado.precio_promo;
            item.cantMayo = productoSeleccionado.cant_promo;
        }
    }

    colaImpresion.push(item);
    dibujarCola();
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Agregado a la cola', showConfirmButton: false, timer: 1000 });
}

function vaciarCola() { colaImpresion = []; dibujarCola(); }
function borrarItemCola(idx) { colaImpresion.splice(idx, 1); dibujarCola(); }

function dibujarCola() {
    const tbody = document.querySelector('#tablaCola tbody');
    tbody.innerHTML = '';
    if (colaImpresion.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-muted py-5">No hay carteles en cola.</td></tr>';
        return;
    }
    colaImpresion.forEach((c, idx) => {
        let badge = c.formato.includes("Normal") ? "bg-secondary" : (c.formato.includes("Doble") ? "bg-primary" : "bg-success");
        tbody.innerHTML += `
            <tr>
                <td class="text-start ps-3 fw-bold">${c.nombre}</td>
                <td class="text-success fw-bold">$${parseFloat(c.precio).toFixed(2)}</td>
                <td><span class="badge ${badge}">${c.formato.replace('_', ' ')}</span></td>
                <td class="fw-bold">${c.copias}</td>
                <td><button class="btn btn-sm text-danger border-0" onclick="borrarItemCola(${idx})"><i class="bi bi-trash"></i></button></td>
            </tr>`;
    });
}

// --- 6. EL MOTOR DE IMPRESIÓN RIGUROSO ---
function imprimirTodo() {
    if (colaImpresion.length === 0) return Swal.fire('Aviso', 'La cola está vacía.', 'warning');

    const zona = document.getElementById('zonaImpresion');
    const logo = localStorage.getItem('logo_empresa_b64');
    
    // CSS ESTRICTO PARA ELECTRON Y CHROME
    let html = `
        <style>
            @media print {
                @page { size: A4; margin: 0; }
                body { margin: 0; padding: 10mm; background: white !important; font-family: Arial, sans-serif; }
                #app-container, .main-wrapper, .modal, .d-print-none, .swal2-container { display: none !important; }
                #zonaImpresion { display: flex !important; flex-wrap: wrap; gap: 5mm; visibility: visible !important; position: absolute; left: 0; top: 0; width: 100%; }
                .cartel { page-break-inside: avoid; box-sizing: border-box; overflow: hidden; background: white !important; }
                .bg-print { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            }
        </style>
    `;

    colaImpresion.forEach((item, idx) => {
        let pF = parseFloat(item.precio).toLocaleString('es-AR', {minimumFractionDigits: 2});
        let txExtra = item.textoExtra ? `<div class="bg-print" style="background:${colorInstitucional}; color:white; font-size:10px; font-weight:bold; text-align:center; text-transform:uppercase; padding:2px 5px; border-radius:3px; margin-bottom:2px;">${item.textoExtra}</div>` : '';
        let bultoHTML = item.txtBulto ? `<div style="font-size:9px; color:red; font-weight:bold; margin-bottom:2px;">${item.txtBulto}</div>` : '';

        for (let i = 0; i < item.copias; i++) {
            
            // PLANTILLA 1: CENEFA ESTÁNDAR (100mm x 40mm)
            if (item.formato === "Cenefa_Normal") {
                html += `
                    <div class="cartel" style="width: 100mm; height: 40mm; border: 1px solid #ddd; border-left: 6px solid ${colorInstitucional}; padding: 3mm; display: flex; flex-direction: column; align-items: center; justify-content: space-between;">
                        ${txExtra}
                        <div style="font-size: 11px; font-weight: bold; text-align: center; color: #333; line-height:1.1;">${item.nombre}</div>
                        ${bultoHTML}
                        <div style="font-size: 32px; font-weight: 900; line-height: 1; margin-top:auto; color: #000;">$${pF}</div>
                        ${item.codigo_barras ? `<svg id="bc-${idx}-${i}" style="height:12mm; width:70mm; margin:0;"></svg>` : ''}
                    </div>
                `;
            } 
            
            // PLANTILLA 2: CENEFA DOBLE/MAYORISTA (200mm x 40mm)
            else if (item.formato === "Cenefa_Doble") {
                let mitadDer = item.cantMayo 
                    ? `<div class="bg-print" style="width: 50%; background: ${colorInstitucional}; color: white; display:flex; flex-direction:column; justify-content:center; align-items:center; padding: 2mm;">
                           <div style="font-size:12px; text-transform:uppercase;">Precio Mayorista</div>
                           <div style="font-size:40px; font-weight:900; line-height:1;">$${parseFloat(item.precioMayo).toLocaleString('es-AR', {minimumFractionDigits:2})}</div>
                           <div style="background:white; color:${colorInstitucional}; font-size:10px; font-weight:bold; padding:2px 5px; border-radius:3px; margin-top:2px;">Llevando ${item.cantMayo} o más</div>
                       </div>`
                    : `<div class="bg-print" style="width: 50%; background: ${colorInstitucional}; color: white; display:flex; align-items:center; justify-content:center; font-size:45px; font-weight:900;">$${pF}</div>`;

                html += `
                    <div class="cartel" style="width: 200mm; height: 40mm; border: 2px solid #333; display: flex; flex-direction: row;">
                        <div style="width: 50%; padding: 2mm; display:flex; flex-direction:column; justify-content:center; align-items:center; border-right: 2px dashed #999;">
                            ${txExtra}
                            <div style="font-size: 14px; font-weight: bold; text-align: center; line-height:1.1; color:#333;">${item.nombre}</div>
                            ${bultoHTML}
                            <div style="font-size: 28px; font-weight: bold; color: #000; margin-top:3px;">$${pF}</div>
                        </div>
                        ${mitadDer}
                    </div>
                `;
            }

            // PLANTILLA 3: CARTEL A4 (200mm x 285mm - Dejamos 5mm de margen de seguridad para impresoras)
            else if (item.formato === "Cartel_A4") {
                let logoHTML = logo 
                    ? `<img src="${logo}" style="max-height: 35mm; margin-bottom: 10mm;">` 
                    : `<div class="bg-print" style="background:${colorInstitucional}; color:white; width:100%; text-align:center; padding:5mm; font-size:20px; font-weight:900; text-transform:uppercase; margin-bottom:10mm;">Autoservicio 20 de Junio</div>`;

                html += `
                    <div class="cartel" style="width: 195mm; height: 280mm; border: 5px solid ${colorInstitucional}; display: flex; flex-direction: column; align-items: center; padding: 10mm; text-align:center; position:relative;">
                        ${logoHTML}
                        ${txExtra ? `<div class="bg-print" style="background:red; color:white; font-size:25px; font-weight:900; padding:5mm 15mm; border-radius:10px; margin-bottom:15mm;">${item.textoExtra}</div>` : ''}
                        
                        <div style="font-size: 40px; font-weight: 900; color: #333; line-height: 1.1; margin-bottom: 5mm;">${item.nombre}</div>
                        ${item.txtBulto ? `<div style="font-size:25px; color:${colorInstitucional}; font-weight:bold; margin-bottom:10mm; border: 2px solid ${colorInstitucional}; padding:3mm 10mm;">${item.txtBulto}</div>` : ''}
                        
                        <div style="font-size: 130px; font-weight: 900; color: #198754; line-height: 0.9; margin-top:auto;">$${pF}</div>
                        
                        ${item.cantMayo ? `<div style="font-size:30px; font-weight:bold; color:#666; margin-top:10mm;">O llevá ${item.cantMayo} a <span style="color:${colorInstitucional};">$${item.precioMayo}</span> c/u</div>` : ''}
                    </div>
                `;
            }
        }
    });

    zona.innerHTML = html;
    zona.classList.remove('d-none');

    // Procesamos todos los códigos de barras de las cenefas normales
    colaImpresion.forEach((item, idx) => {
        if (item.formato === "Cenefa_Normal" && item.codigo_barras) {
            for (let i = 0; i < item.copias; i++) {
                try { JsBarcode(`#bc-${idx}-${i}`, item.codigo_barras, { format: "CODE128", width: 1.5, height: 40, displayValue: false, margin: 0 }); } catch (e) {}
            }
        }
    });

    Swal.fire({ title: 'Enviando a la impresora...', icon: 'info', timer: 1000, showConfirmButton: false }).then(() => {
        
        // Si estamos en entorno Electron Nativo (Tu POS)
        if (typeof require !== 'undefined') {
            const { ipcRenderer } = require('electron');
            ipcRenderer.send('imprimir-silencioso', document.documentElement.outerHTML);
        } else {
            // Entorno Web
            window.print();
        }
        
        zona.classList.add('d-none');
        zona.innerHTML = '';
    });
}