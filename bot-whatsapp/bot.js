/**
 * Puente WhatsApp (PM2 en Contabo).
 * Salida: POST 127.0.0.1:3000/enviar  { destino, mensaje }
 * Entrada: foto/PDF → POST 127.0.0.1:8000/proveedores/borradores/desde_whatsapp
 * NUNCA carga stock. La sesión (.wwebjs_auth) vive en el cwd de PM2, no en git.
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const http = require('http');

const PUERTO = Number(process.env.PUENTE_PORT || 3000);
const TOKEN = (process.env.PUENTE_TOKEN || process.env.WHATSAPP_BRIDGE_TOKEN || '').trim();
const ERP_URL = (process.env.ERP_INTERNAL_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const CHATS_FACTURA = (process.env.WHATSAPP_FACTURA_CHATS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const app = express();
app.use(express.json());

let listo = false;
const gruposVistos = new Map();

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_AUTH || '.wwebjs_auth' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
    console.log('\n=========================================');
    console.log('¡ATENCIÓN! ESCANEÁ ESTE QR CON TU WHATSAPP');
    console.log('=========================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    listo = true;
    console.log('BOT CONECTADO EXITOSAMENTE A WHATSAPP');
});

client.on('disconnected', (razon) => {
    listo = false;
    console.log('WhatsApp desconectado:', razon);
});

function normalizarDestino(raw) {
    const texto = String(raw || '').trim();
    if (!texto) return '';
    if (texto.includes('@')) return texto;
    const digitos = texto.replace(/\D/g, '');
    if (!digitos) return '';
    const conPais = digitos.startsWith('54') ? digitos : `54${digitos}`;
    return `${conPais}@c.us`;
}

function exigirToken(req, res, next) {
    if (!TOKEN) return next();
    if (req.headers['x-erp-token'] !== TOKEN) {
        return res.status(401).send({ error: 'No autorizado' });
    }
    next();
}

function esChatDirecto(id) {
    const s = String(id || '');
    return s.endsWith('@c.us') || s.endsWith('@lid');
}

function chatFacturaPermitido(message) {
    const from = message.from || '';
    if (from === 'status@broadcast' || from.endsWith('@g.us')) return false;
    const peer = message.fromMe ? (message.to || from) : from;
    if (peer === 'status@broadcast' || String(peer).endsWith('@g.us')) return false;
    if (CHATS_FACTURA.length) {
        return CHATS_FACTURA.includes(from) || CHATS_FACTURA.includes(peer);
    }
    return esChatDirecto(peer);
}

function esMediaFactura(message) {
    if (!message) return false;
    const t = message.type || '';
    if (t === 'sticker' || t === 'ptt' || t === 'audio' || t === 'vcard' || t === 'location') return false;
    if (t === 'image' || t === 'document') return true;
    return !!message.hasMedia;
}

function postJson(url, payload) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = JSON.stringify(payload);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        };
        if (TOKEN) headers['X-ERP-Token'] = TOKEN;
        const req = http.request({
            hostname: u.hostname,
            port: u.port || 80,
            path: u.pathname,
            method: 'POST',
            headers
        }, (res) => {
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => {
                let json = {};
                try { json = JSON.parse(buf); } catch (e) { /* */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => {
            req.destroy(new Error('timeout ERP'));
        });
        req.write(data);
        req.end();
    });
}

function detalleErp(json) {
    const d = json && json.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d) && d[0] && d[0].msg) return d[0].msg;
    return (json && json.error) || 'ERP rechazó la foto';
}

function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bajarMedia(message) {
    let ultimo = null;
    for (let i = 1; i <= 3; i++) {
        try {
            console.log(`Bajando foto intento ${i}...`);
            const media = await message.downloadMedia();
            if (media && media.data) {
                console.log(`Foto bajada mime=${media.mimetype || '-'} bytes_b64=${String(media.data).length}`);
                return media;
            }
            ultimo = new Error('downloadMedia vacío');
        } catch (e) {
            ultimo = e;
            console.error(`downloadMedia intento ${i}:`, (e && e.message) ? e.message : e);
        }
        await esperar(800 * i);
    }
    throw ultimo || new Error('No se pudo bajar la foto de WhatsApp');
}

async function mandarFotoAlErp(message) {
    if (!esMediaFactura(message)) return;
    if (!chatFacturaPermitido(message)) {
        console.log(`Foto ignorada chat=${message.from} type=${message.type}`);
        return;
    }
    const media = await bajarMedia(message);
    const mime = (media.mimetype || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/') && mime !== 'application/pdf') {
        console.log(`Foto ignorada mime=${mime}`);
        return;
    }
    const chatId = message.fromMe ? (message.to || message.from) : message.from;
    const url = `${ERP_URL}/proveedores/borradores/desde_whatsapp`;
    console.log(`POST ERP ${url} chat=${chatId}`);
    const { status, json } = await postJson(url, {
        chat_id: chatId,
        caption: String(message.body || '').slice(0, 500),
        foto_b64: media.data,
        mime,
        filename: media.filename || 'whatsapp.jpg'
    });
    if (status >= 400) {
        throw new Error(`ERP ${status}: ${detalleErp(json)}`);
    }
    const id = json.borrador_id;
    const n = json.n_fotos || 1;
    const txt = n === 1
        ? `Borrador #${id} en el ERP. 1 foto. No se tocó el stock. Mandá las otras páginas acá o abrí Proveedores.`
        : `Borrador #${id}: ${n} fotos. No se tocó el stock.`;
    await message.reply(txt);
    console.log(`Foto factura → borrador #${id} (${n} fotos) chat=${chatId}`);
}

async function onMensajeEntrante(message) {
    if (message.fromMe && (message.type || '') === 'chat') return;
    const from = message.from || '';
    console.log(`MSG from=${from} type=${message.type || '-'} media=${!!message.hasMedia} author=${message.author || '-'} body=${String(message.body || '').slice(0, 80)}`);
    if (from.endsWith('@g.us')) {
        gruposVistos.set(from, { nombre: '', id: from });
    }
    try {
        await mandarFotoAlErp(message);
    } catch (error) {
        console.error('Foto factura:', error.message || error);
        try {
            await message.reply('Recibí la foto pero el ERP no la guardó. No se tocó stock.');
        } catch (e) { /* */ }
    }
}

client.on('message_create', (message) => {
    onMensajeEntrante(message).catch((e) => console.error(e));
});

app.get('/salud', (_req, res) => {
    res.status(listo ? 200 : 503).send({ listo });
});

app.get('/grupos', (_req, res) => {
    if (!listo) return res.status(503).send({ error: 'WhatsApp no conectado' });
    const grupos = Array.from(gruposVistos.values());
    res.send({
        cantidad: grupos.length,
        grupos,
        nota: grupos.length
            ? 'IDs vistos desde que arrancó el bot.'
            : 'Que alguien (no el celular del bot) escriba en el grupo y repetí este curl.'
    });
});

app.post('/enviar', exigirToken, (req, res) => {
    const destino = normalizarDestino(req.body.destino || req.body.numero);
    const mensaje = (req.body.mensaje || '').trim();
    if (!destino || !mensaje) {
        return res.status(400).send({ error: 'Faltan datos' });
    }
    if (!listo) {
        return res.status(503).send({ error: 'WhatsApp no conectado' });
    }
    res.status(202).send({ status: 'Aceptado' });
    client.sendMessage(destino, mensaje)
        .then(() => console.log(`Mensaje enviado a ${destino}`))
        .catch((error) => console.error('Error enviando mensaje:', error));
});

client.initialize();
app.listen(PUERTO, '127.0.0.1', () => {
    console.log(`Puente API solo en 127.0.0.1:${PUERTO}`);
    console.log(`Fotos de factura → ${ERP_URL}/proveedores/borradores/desde_whatsapp`);
});
