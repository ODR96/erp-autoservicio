// --- VARIABLES GLOBALES ---
let carrito = [];
let totalVenta = 0;
let metodoSeleccionado = "";
const token = sessionStorage.getItem("token_acceso");

// Verificamos sesión al entrar
if (!token) {
    window.location.href = "index.html";
}

document.getElementById("nombreCajero").textContent = "Cajero: " + sessionStorage.getItem("usuario_nombre");

// --- BUSCADOR DE PRODUCTOS ---
const inputBusqueda = document.getElementById("inputBusqueda");
inputBusqueda.addEventListener("input", async (e) => {
    const query = e.target.value;
    if (query.length < 2) return;

    // Buscamos en el backend
    const resp = await fetch(`${obtenerBaseUrl()}/productos/buscar?termino=${query}`);
    const productos = await resp.json();
    
    // Si hay un solo resultado y es código exacto, lo agregamos directo (Escáner láser)
    if (productos.length === 1 && query === productos[0].codigo_barras) {
        agregarAlCarrito(productos[0]);
        inputBusqueda.value = "";
    }
});

function agregarAlCarrito(producto) {
    const existe = carrito.find(p => p.id === producto.id);
    if (existe) {
        existe.cantidad += 1;
    } else {
        carrito.push({ ...producto, cantidad: 1 });
    }
    actualizarTabla();
}

function actualizarTabla() {
    const tbody = document.getElementById("tablaVenta");
    tbody.innerHTML = "";
    totalVenta = 0;

    carrito.forEach((p, index) => {
        const subtotal = p.precio_venta_final * p.cantidad;
        totalVenta += subtotal;
        tbody.innerHTML += `
            <tr>
                <td>${p.nombre}</td>
                <td>
                    <input type="number" value="${p.cantidad}" class="form-control form-control-sm w-50" 
                           onchange="cambiarCantidad(${index}, this.value)">
                </td>
                <td>$ ${p.precio_venta_final.toFixed(2)}</td>
                <td>$ ${subtotal.toFixed(2)}</td>
                <td><button class="btn btn-danger btn-sm" onclick="eliminarItem(${index})">X</button></td>
            </tr>
        `;
    });

    document.getElementById("visorTotal").textContent = `$ ${totalVenta.toFixed(2)}`;
}

// --- FINALIZAR VENTA ---
async function finalizarVenta() {
    const payload = {
        metodo_pago: metodoSeleccionado,
        monto_entregado: parseFloat(document.getElementById("montoEntregado").value) || 0,
        items: carrito.map(p => ({ producto_id: p.id, cantidad: p.cantidad }))
    };

    const resp = await fetch(`${obtenerBaseUrl()}/ventas/cobrar`, {
        method: "POST",
        headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}` // MANDAMOS EL TOKEN DE SEGURIDAD
        },
        body: JSON.stringify(payload)
    });

    const resultado = await resp.json();
    if (resp.ok) {
        alert("Venta completada. Ticket #" + resultado.numero_ticket);
        carrito = [];
        actualizarTabla();
        bootstrap.Modal.getInstance(document.getElementById('modalCobro')).hide();
    } else {
        alert("Error: " + resultado.detalle);
    }
}

function abrirModalCobro(metodo) {
    if (carrito.length === 0) return alert("El carrito está vacío");
    metodoSeleccionado = metodo;
    document.getElementById("totalModal").textContent = `$ ${totalVenta.toFixed(2)}`;
    const modal = new bootstrap.Modal(document.getElementById('modalCobro'));
    modal.show();
}

function cerrarSesion() {
    sessionStorage.clear();
    window.location.href = "index.html";
}