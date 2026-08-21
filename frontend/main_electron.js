const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

let ventanaPrincipal;


function crearVentana() {
    ventanaPrincipal = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1024,
        minHeight: 768,
        show: false, // La ocultamos hasta que cargue bien
        icon: path.join(__dirname, 'logo20dejunio.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false
        }
    });

    // Le decimos que cargue tu index.html
    ventanaPrincipal.loadFile('index.html');

    // Quitamos el menú clásico de Windows (Archivo, Editar, Ver...)
    ventanaPrincipal.setMenuBarVisibility(false);

    // Cuando esté lista para mostrarse, la mostramos elegantemente
    ventanaPrincipal.once('ready-to-show', () => {
        ventanaPrincipal.show();
        ventanaPrincipal.maximize(); // Que ocupe toda la pantalla

    });
}

// Cuando Electron esté listo, abrimos la ventana
app.whenReady().then(crearVentana);

// Si cierran todas las ventanas, apagamos el proceso (excepto en Mac)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

ipcMain.on('imprimir-silencioso', (event, htmlContenido) => {
    let winImpresion = new BrowserWindow({ show: false });
    winImpresion.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContenido)}`);

    winImpresion.webContents.on('did-finish-load', () => {
        // LA MAGIA ESTÁ ACÁ
        winImpresion.webContents.print({
            silent: true, // true = No le pregunta nada al cajero

            // deviceName: 'POS-80' // <-- Si algún día necesitas forzar una impresora, le sacás las dos barras de adelante y pones el nombre de Windows acá.

        }, (success, errorType) => {
            winImpresion.close(); // Destruimos la ventana fantasma
        });
    });
});

// ========================================================
// SISTEMA DE ACTUALIZACIONES AUTOMÁTICAS (OTA)
// ========================================================
app.on('ready', () => {
    // Cuando el programa arranca, busca actualizaciones sin molestar
    autoUpdater.checkForUpdatesAndNotify();
});

// Cuando termina de descargar la versión nueva en la mochila, le avisa a tu HTML
autoUpdater.on('update-downloaded', () => {
    if (ventanaPrincipal) {
        ventanaPrincipal.webContents.send('actualizacion-lista');
        ventanaPrincipal.webContents.executeJavaScript(`console.error("Error en AutoUpdater: ${err.message}");`);
    }
});

// Si el usuario confirma en tu HTML, Electron se cierra, se actualiza y vuelve a abrir
ipcMain.on('reiniciar-y-actualizar', () => {
    autoUpdater.quitAndInstall();
});