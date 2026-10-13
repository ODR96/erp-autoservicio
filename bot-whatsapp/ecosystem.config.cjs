// El reloj del VPS es Europe/Berlin. 10:00 de ese reloj es de madrugada en Argentina
// (05:00 con horario de verano de Berlin, 06:00 cuando Berlin vuelve a invierno).
module.exports = {
    apps: [{
        name: 'whatsapp-bot',
        script: 'bot.js',
        cwd: __dirname,
        autorestart: true,
        max_memory_restart: '700M',
        restart_delay: 5000,
        cron_restart: '0 10 * * *'
    }]
};
