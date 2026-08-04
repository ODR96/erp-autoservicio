# CONTEXTO - ERP / POS Sistema de Gestión Híbrido

## 1. Nombre y Objetivo Principal
* **Objetivo:** Un sistema de gestión integral de ventas, stock, cajas y cuentas corrientes optimizado para un entorno de retail rápido. Está diseñado bajo una arquitectura "híbrida" (Local + Nube) para garantizar un funcionamiento continuo, latencia nula y resistencia total a los cortes de internet. 
* **Visión de Escalabilidad (White-label):** El sistema está pensado para ser replicable e implementable en múltiples negocios futuros. Todo parámetro de identidad visual, nombre, CUIT, dirección o mensajes impresos debe consumirse obligatoriamente desde un módulo de configuración dinámica, permitiendo adaptar el software a cualquier cliente sin tocar el código fuente.

## 2. Arquitectura y Tecnologías
* **Backend:** Python estructurado modularmente con **FastAPI**.
* **Base de Datos:** **SQLite** operando de forma local como fuente principal de verdad.
* **Frontend:** HTML5, CSS3, Vanilla JavaScript (JS Puro, sin frameworks pesados de renderizado).
* **Librerías UI/UX:** **Bootstrap 5** para estructura y diseño, **SweetAlert2** para alertas, **JsBarcode** para credenciales.
* **Sincronización:** Tareas en segundo plano (`BackgroundTasks`) de FastAPI para clonar la memoria local hacia la nube.

## 3. Estado Actual
* **Caja Fuerte (Arquitectura Multi-Caja Independiente):** Sistema adaptado para detectar desde qué terminal se opera mediante variables de entorno en el navegador (`localStorage`), permitiendo escalabilidad infinita de terminales (Caja 1, Caja 2, Caja N) sin depender de hardware físico específico.
* **Módulo POS (`pos.html`):** Motor de ventas con soporte para balanzas/peso, edición de precios manual, modificadores globales y gestión de ventas en espera.
* **Módulo de Pagos:** Integración de Efectivo (con cálculo de vueltos), Tarjeta/POS, Billeteras Virtuales, Cuenta Corriente (Fiado) y motor robusto de **Pago Múltiple/Mixto**. Integración de cobros de Pedidos Mayoristas.
* **Módulo de Cajas:** Apertura/Cierre de turnos, ingresos/retiros, Cierre Z, Arqueo X parcial, forzado de cierre remoto, e Historial de Ventas por Fecha con desglose exacto de montos.

## 4. Reglas de Desarrollo (Core Guidelines)
* **Prohibido el Hardcodeo de Red y Negocio:** Nunca utilizar IPs locales fijas ni nombres de empresas quemados en el código. Toda conexión usa dinámicamente `` `${obtenerBaseUrl()}` `` y todo dato legal sale de la API de configuración.
* **Seguridad por Capas (El Patovica Digital):** Acciones de riesgo financiero (anulaciones, edición manual de precios, límites excedidos, retiros) requieren validación obligatoria con PIN de Encargado/Admin.
* **Prioridad Offline (Híbrido First):** El sistema asume que internet es inestable. Operaciones de venta y lectura de base de datos se resuelven 100% en el servidor local.

## 5. Lista de Próximos Pasos (Backlog)
* **[Prioridad Alta] - Reparar Menú Responsive:** Inyectar el "botón hamburguesa" y estilos en el ERP para garantizar la navegación lateral en teléfonos móviles.
* **[Prioridad Media] - Túnel Zero Trust (Cloudflare):** Configurar el túnel web seguro para permitir el acceso, auditoría y uso del sistema desde el exterior simulando la red local.
* **[Prioridad Baja] - Pulido General:** Limpieza de bugs visuales y refactorización de código heredado en las vistas de administración.