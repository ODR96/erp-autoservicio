// Memoria de la Oficina
let pedidoActual = [];
let clientesMayGlobales = [];

document.addEventListener('DOMContentLoaded', () => {
    cargarClientesMay();

    // El buscador reacciona al apretar "Enter"
    const inputBuscar = document.getElementById('busquedaProductoMay');
    if(inputBuscar) {
        inputBuscar.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') buscarProductoMay(this.value);
        });
    }
});

// --- 1. CARGAR CLIENTES ---
async function cargarClientesMay() {
    try {
        const res = await fetch(`${obtenerBaseUrl()}/clientes/listado`);
        const data = await res.json();
        clientesMayGlobales = data.clientes || [];
        
        const select = document.getElementById('selectClienteMay');
        clientesMayGlobales.forEach(c => {
            select.innerHTML += `<option value="${c.id}">${c.nombre_completo} (CUIT: ${c.cuit || 'S/D'})</option>`;
        });

        // Evento para mostrar la deuda si elegimos un cliente con cuenta
        select.addEventListener('change', function() {
            const infoDiv = document.getElementById('infoClienteMay');
            if (this.value === "0") {
                infoDiv.classList.add('d-none');
            } else {
                const cli = clientesMayGlobales.find(x => x.id == this.value);
                document.getElementById('cuitClienteMay').innerText = cli.cuit || '-';
                const divSaldo = infoDiv.querySelector('.text-danger');
                divSaldo.innerText = `$ ${cli.saldo_actual_deudor.toFixed(2)}`;
                infoDiv.classList.remove('d-none');
            }
        });
    } catch (e) { console.log("Error cargando clientes", e); }
}

// --- 2. BUSCADOR Y LÓGICA UNIDAD/BULTO ---
async function buscarProductoMay(termino) {
    if (!termino.trim()) return;
    
    Swal.fire({ title: 'Buscando...', didOpen: () => Swal.showLoading(), allowOutsideClick: false });
    
    try {
        const res = await fetch(`http://localhost:8000/productos/buscar?q=${termino}`);
        const data = await res.json();
        
        if (data.error || !data.productos || data.productos.length === 0) {
            return Swal.fire('Sin resultados', 'No se encontró el producto.', 'warning');
        }

        Swal.close();
        mostrarResultadosModal(data.productos);
    } catch (e) {
        Swal.fire('Error', 'Falla de conexión', 'error');
    }
}

function mostrarResultadosModal(productos) {
    const lista = document.getElementById('listaResultadosMay');
    lista.innerHTML = '';

    productos.forEach(p => {
        // Ahora sí, esperamos tranquilos a que Python nos mande el dato correcto
        let stockReal = p.stock_actual || 0;
        
        let opcionesSelector = `<option value="1|${p.precio_venta_final}|Unidad">Unidad ($${p.precio_venta_final})</option>`;
        
        if (p.reglas_mayoristas && p.reglas_mayoristas.length > 0) {
            p.reglas_mayoristas.forEach(regla => {
                opcionesSelector += `<option value="${regla.cantidad_minima}|${regla.precio_oferta_unitario}|Bulto x${regla.cantidad_minima}">Bulto x${regla.cantidad_minima} ($${regla.precio_oferta_unitario} c/u)</option>`;
            });
        }

        lista.innerHTML += `
            <div class="list-group-item py-3">
                <div class="row align-items-center">
                    <div class="col-md-5">
                        <h6 class="fw-bold mb-1">${p.nombre}</h6>
                        <small class="text-muted">Stock Físico: <span class="badge ${stockReal <= 0 ? 'bg-danger' : 'bg-success'}">${stockReal}</span></small>
                    </div>
                    
                    <div class="col-md-7 d-flex justify-content-end gap-2">
                        <input type="number" id="cant_${p.id}" class="form-control form-control-sm text-center border-primary" style="width: 80px;" value="1" min="1">
                        <select id="tipo_${p.id}" class="form-select form-select-sm border-primary" style="width: auto; font-weight: bold;">
                            ${opcionesSelector}
                        </select>
                        <button class="btn btn-sm btn-primary fw-bold px-3 shadow-sm" onclick="procesarAgregadoMayorista(${p.id}, '${p.nombre.replace(/'/g, "\\'")}')">
                            <i class="bi bi-plus-lg"></i> Agregar
                        </button>
                    </div>
                </div>
            </div>
        `;
    });

    const modal = new bootstrap.Modal(document.getElementById('modalResultadosProd'));
    modal.show();
}

// El nuevo cerebro que multiplica Bultos x Cantidad
function procesarAgregadoMayorista(id, nombre) {
    const cantIngresada = parseFloat(document.getElementById(`cant_${id}`).value);
    if (isNaN(cantIngresada) || cantIngresada <= 0) return Swal.fire('Error', 'Ingrese una cantidad válida', 'warning');

    const selectObj = document.getElementById(`tipo_${id}`).value;
    const partes = selectObj.split('|');
    const multiplicador = parseFloat(partes[0]);
    const precio = parseFloat(partes[1]);
    const tipo = partes[2];

    // Ahora le pasamos todo desglosado a la función que arma el carrito
    agregarAlPedidoMay(id, nombre, precio, cantIngresada, multiplicador, tipo);
}

// --- 3. GESTIÓN DEL CARRITO (PRESUPUESTO) ---
function agregarAlPedidoMay(id, nombreBase, precio, cantIngresada, multiplicador, tipo) {
    // Buscamos si ya está el producto con el mismo precio
    const existente = pedidoActual.find(x => x.producto_id === id && x.precio_negociado === precio);
    
    if (existente) {
        existente.cant_ingresada += cantIngresada;
        existente.cantidad = existente.cant_ingresada * existente.multiplicador;
        existente.subtotal = existente.cantidad * existente.precio_negociado;
    } else {
        const nombreConDetalle = (multiplicador > 1) ? `${nombreBase} <small class="text-muted ms-2">(${tipo})</small>` : nombreBase;
        
        pedidoActual.push({
            producto_id: id,
            nombre: nombreConDetalle,
            nombre_limpio: nombreBase, // Guardamos el nombre sin HTML para el cartel de edición
            cant_ingresada: cantIngresada, // Ej: 2
            multiplicador: multiplicador,  // Ej: 6
            cantidad: cantIngresada * multiplicador, // Total de unidades para descontar stock (Ej: 12)
            precio_negociado: precio,
            subtotal: (cantIngresada * multiplicador) * precio,
            tipo_bulto: tipo
        });
    }

    document.getElementById('busquedaProductoMay').value = '';
    const modalEl = document.getElementById('modalResultadosProd');
    const modalObj = bootstrap.Modal.getInstance(modalEl);
    if(modalObj) modalObj.hide();

    renderizarPedidoMay();
}

function renderizarPedidoMay() {
    const tbody = document.getElementById('bodyPedidoMay');
    const msgVacio = document.getElementById('msgVacio');
    tbody.innerHTML = '';

    if (pedidoActual.length === 0) {
        msgVacio.classList.remove('d-none');
        document.getElementById('totalSubMay').innerText = '$ 0.00';
        document.getElementById('totalFinalMay').innerText = '$ 0.00';
        return;
    }

    msgVacio.classList.add('d-none');
    let total = 0;

pedidoActual.forEach((item, index) => {
        total += item.subtotal;
        
        // MAGIA VISUAL: Diferenciamos gráficos si es Bulto o Unidad Suelta
        let htmlCantidad = '';
        if (item.multiplicador > 1) {
            htmlCantidad = `
                <span class="badge bg-warning text-dark border fs-6 shadow-sm" style="cursor:pointer;" onclick="editarItemMay(${index}, 'cantidad')" title="Editar Bultos">
                    📦 ${item.cant_ingresada} Bulto(s) <i class="bi bi-pencil small"></i>
                </span>
                <div class="small text-muted mt-1 fw-bold">(${item.cantidad} un. en total)</div>
            `;
        } else {
            htmlCantidad = `
                <span class="badge bg-light text-dark border fs-6 shadow-sm" style="cursor:pointer;" onclick="editarItemMay(${index}, 'cantidad')" title="Editar Unidades">
                    ${item.cantidad} <i class="bi bi-pencil small text-muted"></i>
                </span>
            `;
        }

        tbody.innerHTML += `
            <tr class="align-middle">
                <td>
                    ${item.nombre_limpio}
                    ${item.multiplicador > 1 ? `<br><small class="text-primary fw-bold">${item.tipo_bulto}</small>` : ''}
                </td>
                <td class="text-center align-middle">
                    ${htmlCantidad}
                </td>
                <td class="text-end">
                    <span style="cursor:pointer;" onclick="editarItemMay(${index}, 'precio')" title="Editar Precio">
                        $${item.precio_negociado.toFixed(2)} <i class="bi bi-pencil small text-muted"></i>
                    </span>
                </td>
                <td class="fw-bold text-primary text-end">$${item.subtotal.toFixed(2)}</td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-danger py-0" onclick="quitarItemMay(${index})"><i class="bi bi-trash"></i></button>
                </td>
            </tr>
        `;
    });

    document.getElementById('totalSubMay').innerText = `$ ${total.toFixed(2)}`;
    document.getElementById('totalFinalMay').innerText = `$ ${total.toFixed(2)}`;
}

async function editarItemMay(index, queEditar) {
    const item = pedidoActual[index];
    
    // El cartel ahora es inteligente y sabe si editás bultos o unidades
    const titulo = queEditar === 'cantidad' ? `Modificar cantidad de: ${item.tipo_bulto}` : 'Modificar Precio Unitario';
    const valorActual = queEditar === 'cantidad' ? item.cant_ingresada : item.precio_negociado;

    const { value: nuevoValor } = await Swal.fire({
        title: titulo,
        input: 'number',
        inputLabel: item.nombre_limpio, 
        inputValue: valorActual,
        showCancelButton: true,
        inputValidator: (value) => {
            if (!value || value <= 0) return 'El valor debe ser mayor a 0';
        }
    });

    if (nuevoValor) {
        if (queEditar === 'cantidad') {
            item.cant_ingresada = parseFloat(nuevoValor);
            // Recalculamos el total de unidades multiplicando lo que tipeó por lo que trae el bulto
            item.cantidad = item.cant_ingresada * item.multiplicador; 
        } else {
            item.precio_negociado = parseFloat(nuevoValor);
        }
        item.subtotal = item.cantidad * item.precio_negociado;
        renderizarPedidoMay();
    }
}

function quitarItemMay(index) {
    pedidoActual.splice(index, 1);
    renderizarPedidoMay();
}

// --- 4. ENVÍO AL SÓTANO ---
async function procesarDocumento(tipoDoc) {
    if (pedidoActual.length === 0) return Swal.fire('Aviso', 'El presupuesto está vacío.', 'warning');

    const clienteId = parseInt(document.getElementById('selectClienteMay').value);

    const payload = {
        tipo_documento: tipoDoc,
        cliente_id: clienteId === 0 ? null : clienteId,
        vendedor_id: 1, // Tu ID
        observaciones: "",
        items: pedidoActual.map(x => ({
            producto_id: x.producto_id,
            cantidad: x.cantidad,
            precio_negociado: x.precio_negociado
        }))
    };

    Swal.fire({ title: 'Generando Documento...', didOpen: () => Swal.showLoading() });

    try {
        const res = await fetch(`${obtenerBaseUrl()}/deposito/crear, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        }`);
        const data = await res.json();
        
        if (data.error) throw new Error(data.error);

        await Swal.fire('¡Éxito!', data.mensaje || 'Documento guardado', 'success');
        
        // LA BÚSQUEDA DEL ID PERDIDO
        const docId = data.numero_documento || data.documento_id || data.id || data.pedido_id;
        
        if (docId) {
            imprimirRemitoA5(docId); // Acá solo la LLAMAMOS
        } else {
            Swal.fire('Atención', 'Se guardó correctamente en la base de datos, pero Python no devolvió el ID para imprimir.', 'info');
        }

        // Limpiamos la mesa
        pedidoActual = [];
        renderizarPedidoMay();
        document.getElementById('selectClienteMay').value = "0";
        document.getElementById('infoClienteMay').classList.add('d-none');

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// ==========================================
// IMPRESIÓN DE PRESUPUESTOS Y REMITOS (A4 / A5)
// (Esta función vive afuera, sola y tranquila)
// ==========================================
// --- IMPRIMIR COMPROBANTE (Dinámico según estado) ---
// --- IMPRIMIR COMPROBANTE (Dinámico 100% desde Base de Datos) ---
async function imprimirRemitoA5(docId) {
    try {
        Swal.fire({ title: 'Generando comprobante...', didOpen: () => Swal.showLoading() });
        
        // 1. Traemos los datos del pedido/presupuesto
        const res = await fetch(`http://localhost:8000/deposito/documento/${docId}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // 2. EL REY DE LA CONFIGURACIÓN: Leemos los ajustes en vivo desde Python
        const resConfig = await fetch(`${obtenerBaseUrl()}/config/leer`);
        const config = await resConfig.json();
        if (config.error) throw new Error("No se pudo leer la configuración del negocio.");

        Swal.close();

        const cab = data.cabecera;
        const det = data.detalle;

        // --- MAGIA DEL LOGO TODOTERRENO ---
        let rutaSegura = "";
        if (config.ruta_logo) {
            if (config.ruta_logo.startsWith("data:image")) {
                rutaSegura = config.ruta_logo; // Si es código directo de Base de Datos
            } else {
                rutaSegura = `http://localhost:8000/static/logos/${config.ruta_logo}?t=${new Date().getTime()}`; // Si es un archivo subido
            }
        }

        const imgLogo = rutaSegura 
            ? `<img src="${rutaSegura}" style="max-height: 70px; max-width: 200px; object-fit: contain;" onerror="this.style.display='none';">` 
            : `<div style="font-size: 24px; font-weight: bold; text-transform: uppercase; color: #1b365d; margin: 0;">${config.nombre_negocio || 'SISTEMA ERP'}</div>`;

        // --- MAGIA VISUAL: Adaptar título, marca de agua y legales según el estado ---
        let titulo = "DOCUMENTO";
        let watermark = "";
        let watermarkColor = "rgba(0,0,0,0.1)";
        let textoLegales = "";

        if (cab.estado === 'PRESUPUESTO_ACTIVO') {
            titulo = "PRESUPUESTO";
            watermark = "PRESUPUESTO";
            textoLegales = "<strong>TÉRMINOS:</strong> Los precios detallados tienen una validez de 24 horas. La mercadería NO está reservada y queda sujeta al stock físico al momento del pago.";
        } else if (cab.estado === 'PENDIENTE_PAGO') {
            titulo = "ORDEN DE PEDIDO";
            watermark = "FALTA PAGAR";
            watermarkColor = "rgba(220, 53, 69, 0.15)"; 
            textoLegales = "<strong>ATENCIÓN:</strong> Pase por línea de cajas con este comprobante para abonar y liberar la mercadería en depósito.";
        } else if (cab.estado === 'PAGADO_PENDIENTE_ENTREGA') {
            titulo = "ORDEN DE RETIRO";
            watermark = "PAGADO";
            watermarkColor = "rgba(25, 135, 84, 0.15)"; 
            textoLegales = "<strong>ABONADO:</strong> Presente este documento en la zona de depósito para que el personal le entregue la mercadería detallada.";
        } else if (cab.estado === 'ENTREGADA') {
            titulo = "REMITO DE ENTREGA";
            watermark = "ENTREGADO";
            watermarkColor = "rgba(13, 110, 253, 0.1)"; 
            textoLegales = "<strong>FINALIZADO:</strong> La mercadería detallada en este documento ya fue entregada y despachada por nuestro depósito. ¡Gracias por su compra!";
        } else {
            titulo = "COMPROBANTE ANULADO";
            watermark = "ANULADO";
            textoLegales = "Documento sin validez comercial ni logística.";
        }

        let html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>${titulo} #${cab.id}</title>
                <style>
                    body { font-family: 'Arial', sans-serif; padding: 20px; font-size: 14px; position: relative; }
                    .watermark { 
                        position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg); 
                        font-size: 80px; color: ${watermarkColor}; font-weight: bold; z-index: -1; 
                        pointer-events: none; letter-spacing: 5px; border: 10px solid ${watermarkColor}; 
                        padding: 20px; border-radius: 20px; white-space: nowrap; 
                    }
                    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 15px; }
                    .title-box { text-align: right; }
                    h2 { margin: 0; color: #333; font-size: 22px; text-transform: uppercase; }
                    .info-box { display: flex; justify-content: space-between; background: #f8f9fa; padding: 10px; border-radius: 5px; border: 1px solid #ddd; margin-bottom: 15px; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
                    th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
                    th { background-color: #eee; font-size: 12px; }
                    .right { text-align: right; }
                    .total-box { font-size: 18px; font-weight: bold; text-align: right; margin-top: 10px; padding: 10px; background: #eee; border-radius: 5px; }
                    .legales { margin-top: 30px; font-size: 11px; color: #555; text-align: justify; padding: 10px; border: 1px dashed #aaa; }
                    .footer { text-align: center; margin-top: 20px; font-size: 12px; font-weight: bold; }
                </style>
            </head>
            <body>
                <div class="watermark">${watermark}</div>
                
                <div class="header">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        ${imgLogo}
                        <div>
                            <h2 style="color: #1b365d; margin: 0;">${config.nombre_negocio || 'MI NEGOCIO'}</h2>
                            <div style="font-size: 14px; color: #555;">${config.direccion || ''} | CUIT: ${config.cuit || 'S/D'}</div>
                        </div>
                    </div>
                    <div class="title-box">
                        <h2 style="margin: 0;">${titulo}</h2>
                        <div>N° Documento: <b>${cab.id.toString().padStart(5, '0')}</b></div>
                        <div>Fecha: ${cab.fecha_hora}</div>
                    </div>
                </div>
                
                <div class="info-box">
                    <div><b>Cliente:</b> ${cab.nombre_completo || 'Consumidor Final'}</div>
                    <div><b>CUIT/DNI:</b> ${cab.cuit || 'S/D'}</div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Cant.</th>
                            <th>Descripción</th>
                            <th class="right">P. Unit.</th>
                            <th class="right">Subtotal</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${det.map(i => `
                            <tr>
                                <td><b>${i.cantidad}</b></td>
                                <td>${i.nombre}</td>
                                <td class="right">$${i.precio.toFixed(2)}</td>
                                <td class="right"><b>$${i.subtotal.toFixed(2)}</b></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="total-box">
                    TOTAL: $${cab.total_venta.toFixed(2)}
                </div>

                <div class="legales">
                    ${textoLegales}
                </div>

                <div class="footer">
                    SISTEMA ERP MAYORISTA - COMPROBANTE DE CIRCULACIÓN INTERNA<br>
                    ${config.mensaje_ticket || ''}
                </div>
            </body>
            </html>
        `;

        let vent = window.open('', '_blank');
        vent.document.write(html);
        vent.document.close();
        vent.focus();
        setTimeout(() => { vent.print(); vent.close(); }, 800);

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

function guardarComoPresupuesto() {
    procesarDocumento('PRESUPUESTO');
}

function confirmarYReservar() {
    Swal.fire({
        title: '¿Confirmar Pedido?',
        text: "Esto bloqueará el stock físico para que nadie más lo venda.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#198754',
        confirmButtonText: 'Sí, Reservar'
    }).then((result) => {
        if (result.isConfirmed) procesarDocumento('PEDIDO');
    });
}

// ==========================================
// MONITOR LOGÍSTICO Y PESTAÑAS
// ==========================================

function cambiarPestanaMay(id) {
    document.querySelectorAll('#mayoristaTabs .nav-link').forEach(el => {
        el.classList.remove('active', 'text-primary'); el.classList.add('text-secondary');
    });
    document.querySelectorAll('.tab-pane').forEach(el => {
        el.classList.add('d-none'); el.classList.remove('active');
    });
    
    document.querySelector(`button[onclick="cambiarPestanaMay('${id}')"]`).classList.add('active', 'text-primary');
    document.querySelector(`button[onclick="cambiarPestanaMay('${id}')"]`).classList.remove('text-secondary');
    
    const tab = document.getElementById('tab-' + id);
    tab.classList.remove('d-none'); tab.classList.add('active');
    
    if (id === 'monitor') cargarMonitorPedidos();
}

let monitorDataGlobal = [];

// --- CONVERTIR PRESUPUESTO EN PEDIDO ---
function convertirAPedido(docId) {
    Swal.fire({
        title: '¿Pasar a Caja?',
        text: "El presupuesto se convertirá en un Pedido en firme y quedará pendiente de pago.",
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#ffc107',
        cancelButtonColor: '#6c757d',
        confirmButtonText: '<i class="bi bi-check-lg"></i> Sí, Convertir',
        cancelButtonText: 'Cancelar'
    }).then(async (result) => {
        if (result.isConfirmed) {
            Swal.fire({ title: 'Convirtiendo...', didOpen: () => Swal.showLoading() });
            try {
                const res = await fetch(`http://localhost:8000/deposito/convertir_presupuesto/${docId}`, {
                    method: 'POST'
                });
                const data = await res.json();
                
                if (data.error) throw new Error(data.error);
                
                Swal.fire('¡Listo para Cobrar!', `El cliente ya puede ir a la caja a pagar el Pedido #${docId}.`, 'success');
                cargarMonitorPedidos(); 
                
            } catch (e) {
                Swal.fire('Error', e.message, 'error');
            }
        }
    });
}

async function cargarMonitorPedidos() {
    const tbody = document.getElementById('bodyMonitor');
    tbody.innerHTML = '<tr><td colspan="7" class="py-4"><div class="spinner-border text-primary"></div></td></tr>';

    try {
        const res = await fetch(`${obtenerBaseUrl()}/deposito/listar`);
        const data = await res.json();
        monitorDataGlobal = data.documentos || [];
        dibujarMonitor(monitorDataGlobal);
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-danger py-4">Error de conexión</td></tr>';
    }
}

function dibujarMonitor(lista) {
    const tbody = document.getElementById('bodyMonitor');
    tbody.innerHTML = '';

    if (lista.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-muted py-4">No hay operaciones registradas.</td></tr>';
        return;
    }

    lista.forEach(doc => {
        let badgeEstado = '';
        let badgeTipo = doc.tipo_comprobante === 'PRESUPUESTO' ? '<span class="badge bg-secondary">Presupuesto</span>' : '<span class="badge bg-dark">Pedido</span>';
        
        // Semáforo de estados
        // Semáforo de estados
        switch (doc.estado) {
            case 'PRESUPUESTO_ACTIVO': badgeEstado = '<span class="badge bg-info text-dark">Activo</span>'; break;
            case 'PENDIENTE_PAGO': badgeEstado = '<span class="badge bg-warning text-dark"><i class="bi bi-clock"></i> Falta Pagar</span>'; break;
            case 'PAGADO_PENDIENTE_ENTREGA': badgeEstado = '<span class="badge bg-primary"><i class="bi bi-box-seam"></i> Para Entregar</span>'; break;
            case 'ENTREGADA': badgeEstado = '<span class="badge bg-success"><i class="bi bi-check-all"></i> Entregado</span>'; break;
            
            // EL NUEVO ESTADO: VENCIDO
            case 'VENCIDO': badgeEstado = '<span class="badge bg-danger"><i class="bi bi-hourglass-bottom"></i> Vencido</span>'; break;
            
            default: badgeEstado = `<span class="badge bg-secondary">${doc.estado}</span>`;
        }

        tbody.innerHTML += `
            <tr>
                <td class="fw-bold text-muted">#${doc.id.toString().padStart(5,'0')}</td>
                <td class="text-start small">${doc.fecha_hora}</td>
                <td class="text-start fw-bold">${doc.cliente}</td>
                <td>${badgeTipo}</td>
                <td class="text-end fw-bold text-success">$${doc.total_venta.toFixed(2)}</td>
                <td>${badgeEstado}</td>
                <td>
                    <button class="btn btn-sm btn-outline-info shadow-sm" onclick="verDetallePedido(${doc.id})" title="Ver detalle en pantalla">
                        <i class="bi bi-eye"></i>
                    </button>

                    <button class="btn btn-sm btn-outline-primary shadow-sm ms-1" onclick="imprimirRemitoA5(${doc.id})" title="Imprimir Comprobante">
                        <i class="bi bi-printer"></i>
                    </button>
                    
                    ${doc.estado === 'PRESUPUESTO_ACTIVO' ? `
                    <button class="btn btn-sm btn-warning shadow-sm ms-1 fw-bold" onclick="convertirAPedido(${doc.id})" title="Convertir en Pedido Real">
                        <i class="bi bi-cart-check"></i> Cobrar
                    </button>` : ''}

                    ${doc.estado === 'PAGADO_PENDIENTE_ENTREGA' ? `
                    <button class="btn btn-sm btn-outline-dark shadow-sm ms-1" onclick="imprimirPicking(${doc.id})" title="Imprimir Hoja de Armado">
                        <i class="bi bi-clipboard-check"></i>
                    </button>
                    <button class="btn btn-sm btn-success shadow-sm ms-1" onclick="marcarComoEntregado(${doc.id})" title="Despachar Mercadería">
                        <i class="bi bi-truck"></i>
                    </button>` : ''}
                </td>
            </tr>
        `;
    });
}

// --- VER DETALLE RÁPIDO EN PANTALLA (SIN IMPRIMIR) ---
async function verDetallePedido(docId) {
    try {
        Swal.fire({ title: 'Buscando detalle...', didOpen: () => Swal.showLoading() });
        
        // Usamos la ruta que ya teníamos para la impresora, pero la mostramos en pantalla
        const res = await fetch(`http://localhost:8000/deposito/documento/${docId}`);
        const data = await res.json();
        
        if (data.error) throw new Error(data.error);

        const cab = data.cabecera;
        const det = data.detalle;

        // Armamos una tablita HTML limpia
        let htmlTabla = `
            <div class="text-start mb-3 border-bottom pb-2">
                <span class="badge bg-secondary mb-1">${cab.estado.replace(/_/g, ' ')}</span><br>
                <b>Cliente:</b> ${cab.nombre_completo || 'Consumidor Final'} <br>
                <small class="text-muted">Fecha: ${cab.fecha_hora}</small>
            </div>
            <table class="table table-sm table-hover text-start small border">
                <thead class="table-light">
                    <tr>
                        <th class="text-center">Cant.</th>
                        <th>Producto</th>
                        <th class="text-end">Subtotal</th>
                    </tr>
                </thead>
                <tbody>
        `;

        det.forEach(i => {
            htmlTabla += `
                <tr>
                    <td class="text-center fw-bold">${i.cantidad}</td>
                    <td>${i.nombre}</td>
                    <td class="text-end text-primary">$${i.subtotal.toFixed(2)}</td>
                </tr>
            `;
        });

        htmlTabla += `
                </tbody>
            </table>
            <h4 class="text-end text-success fw-bold mt-3">Total: $${cab.total_venta.toFixed(2)}</h4>
        `;

        // Lanzamos el SweetAlert con la tabla adentro
        Swal.fire({
            title: `Documento #${cab.id}`,
            html: htmlTabla,
            width: '600px',
            showCloseButton: true,
            showConfirmButton: false, // No necesitamos botón de OK
            footer: '<span class="small text-muted"><i class="bi bi-info-circle"></i> Vista rápida de sistema</span>'
        });

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

function filtrarMonitor() {
    const query = document.getElementById('buscadorMonitor').value.toLowerCase();
    const filtrados = monitorDataGlobal.filter(doc => 
        doc.cliente.toLowerCase().includes(query) || 
        doc.id.toString().includes(query) || 
        doc.estado.toLowerCase().includes(query)
    );
    dibujarMonitor(filtrados);
}

// --- HOJA DE ARMADO (PICKING) SIN PRECIOS ---
async function imprimirPicking(docId) {
    try {
        Swal.fire({ title: 'Generando Hoja de Armado...', didOpen: () => Swal.showLoading() });
        
        // Reutilizamos la ruta que ya te trae el documento entero
        const res = await fetch(`http://localhost:8000/deposito/documento/${docId}`);
        const data = await res.json();
        
        if (data.error) throw new Error(data.error);
        Swal.close();

        const cab = data.cabecera;
        const det = data.detalle;

        let html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Armado Pedido #${cab.id}</title>
                <style>
                    body { font-family: 'Arial', sans-serif; padding: 20px; color: #333; }
                    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 20px; }
                    .title { font-size: 24px; font-weight: bold; text-transform: uppercase; }
                    .info { margin-bottom: 20px; font-size: 15px; background: #f8f9fa; padding: 15px; border-radius: 5px; border: 1px solid #ddd; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
                    th, td { border: 1px solid #aaa; padding: 12px; text-align: left; }
                    th { background-color: #eee; font-weight: bold; text-transform: uppercase; font-size: 14px; }
                    .check { width: 40px; text-align: center; font-size: 18px; font-weight: bold; color: #ccc; }
                    .cant { width: 80px; text-align: center; font-size: 18px; font-weight: bold; }
                    .footer { text-align: center; font-size: 12px; color: #666; margin-top: 30px; border-top: 1px dashed #aaa; padding-top: 10px; }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="title">📋 ORDEN DE ARMADO (PICKING)</div>
                    <div><b>Pedido N°:</b> ${cab.id.toString().padStart(5, '0')}</div>
                </div>
                
                <div class="info">
                    <strong>Cliente Destino:</strong> ${cab.nombre_completo || 'Consumidor Final'} <br>
                    <strong>Fecha de Emisión:</strong> ${cab.fecha_hora} <br>
                    <strong>Estado Logístico:</strong> AUTORIZADO PARA ENTREGA
                </div>

                <table>
                    <thead>
                        <tr>
                            <th class="check">✔</th>
                            <th class="cant">Cant.</th>
                            <th>Descripción del Producto</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${det.map(item => `
                            <tr>
                                <td class="check">[ &nbsp;&nbsp;&nbsp; ]</td>
                                <td class="cant">${item.cantidad}</td>
                                <td style="font-size: 16px;">${item.nombre}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="footer">
                    Documento de control interno de stock - No válido como comprobante de pago ni factura.<br>
                    Firma del Responsable de Armado: _________________________________
                </div>
            </body>
            </html>
        `;

        let vent = window.open('', '_blank');
        vent.document.write(html);
        vent.document.close();
        vent.focus();
        setTimeout(() => { vent.print(); vent.close(); }, 800);

    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}

// --- DESPACHAR MERCADERÍA (EL CAMIONCITO VERDE) ---
function marcarComoEntregado(docId) {
    Swal.fire({
        title: '¿Despachar Mercadería?',
        text: "Esto restará los productos definitivamente de tu stock físico.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#198754',
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'Sí, Entregar'
    }).then(async (result) => {
        if (result.isConfirmed) {
            Swal.fire({ title: 'Procesando entrega...', didOpen: () => Swal.showLoading() });
            try {
                // Llamamos a la ruta que ya tenés creada en Python
                const res = await fetch(`http://localhost:8000/deposito/entregar/${docId}`, {
                    method: 'PUT' // O PUT, dependiendo de cómo lo hayas definido en FastAPI
                });
                const data = await res.json();
                
                if (data.error) throw new Error(data.error);
                
                Swal.fire('¡Entregado!', data.mensaje, 'success');
                
                // Refrescamos la tablita del monitor
                cargarMonitorPedidos(); 
                
            } catch (e) {
                Swal.fire('Error logístico', e.message, 'error');
            }
        }
    });

    
}