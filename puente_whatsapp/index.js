const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

const PUERTO = Number(process.env.PUENTE_PORT || 3000);
const TOKEN = (process.env.PUENTE_TOKEN || '').trim();

const app = express();
app.use(express.json());

let listo = false;

const client = new Client({
    authStrategy: new LocalAuth(),
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

client.on('message', async (message) => {
    if (message.body === '!id') {
        const chat = await message.getChat();
        message.reply(`El ID de este chat/grupo es:\n${chat.id._serialized}`);
        console.log(`ID capturado: ${chat.id._serialized}`);
    }
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

app.get('/salud', (_req, res) => {
    res.status(listo ? 200 : 503).send({ listo });
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
});
