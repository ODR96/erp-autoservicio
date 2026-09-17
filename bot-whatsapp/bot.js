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

function serialIdMensaje(id) {
    if (!id) return '';
    if (typeof id === 'string') return id;
    return id._serialized || id.$1 || '';
}

function parcheIdWhatsapp(message) {
    if (!message || !message.id || typeof message.id !== 'object') return;
    const id = message.id;
    if (!id._serialized) {
        if (id.$1) id._serialized = id.$1;
        else if (id.remote && id.id != null) {
            id._serialized = `${id.fromMe ? 'true' : 'false'}_${id.remote}_${id.id}`;
        }
    }
    if (!id.$1 && id._serialized) id.$1 = id._serialized;
}

function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bajarMediaViaPagina(message) {
    const page = client.pupPage;
    if (!page) throw new Error('WhatsApp sin página interna');
    parcheIdWhatsapp(message);
    const payload = {
        serialized: serialIdMensaje(message.id),
        fromMe: !!message.id.fromMe,
        remote: message.id.remote || message.from,
        id: message.id.id
    };
    if (!payload.serialized) throw new Error('mensaje sin id serializado');
    return await page.evaluate(async (p) => {
        const collections = window.require ? window.require('WAWebCollections') : null;
        const Msg = (window.Store && window.Store.Msg) || (collections && collections.Msg);
        if (!Msg) throw new Error('Store.Msg no disponible');
        const candidatos = [p.serialized];
        let msg = null;
        for (const c of candidatos) {
            try { msg = Msg.get(c); } catch (e) { /* */ }
            if (msg) break;
        }
        if (!msg && Msg.getMessagesById) {
            try {
                const packed = await Msg.getMessagesById([p.serialized]);
                msg = packed && (packed.messages && packed.messages[0] || packed[0]);
            } catch (e) { /* */ }
        }
        if (!msg && typeof Msg.getModelsArray === 'function') {
            const arr = Msg.getModelsArray();
            msg = arr.find((m) => {
                const sid = m.id && (m.id._serialized || m.id.$1);
                return sid === p.serialized || (m.id && m.id.id === p.id);
            });
        }
        if (!msg) throw new Error('mensaje no está en Store');
        if (!window.WWebJS || typeof window.WWebJS.downloadBuffer !== 'function') {
            throw new Error('WWebJS.downloadBuffer no disponible');
        }
        const decrypted = await window.WWebJS.downloadBuffer(msg);
        if (!decrypted) throw new Error('downloadBuffer vacío');
        const bytes = decrypted instanceof ArrayBuffer ? new Uint8Array(decrypted) : new Uint8Array(decrypted);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return {
            mimetype: msg.mimetype || 'image/jpeg',
            data: btoa(binary),
            filename: msg.filename || 'whatsapp.jpg'
        };
    }, payload);
}

async function bajarMedia(message) {
    parcheIdWhatsapp(message);
    console.log(`msg.id serial=${serialIdMensaje(message.id) || '-'} $1=${(message.id && message.id.$1) || '-'} remote=${(message.id && message.id.remote) || '-'}`);
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
    try {
        console.log('Bajando foto vía Store interno...');
        const media = await bajarMediaViaPagina(message);
        if (media && media.data) {
            console.log(`Foto bajada (Store) mime=${media.mimetype || '-'} bytes_b64=${String(media.data).length}`);
            return media;
        }
    } catch (e) {
        console.error('Store interno:', (e && e.message) ? e.message : e);
        ultimo = e;
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
    parcheIdWhatsapp(message);
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
