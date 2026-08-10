// Bot de Telegram - Recordatorios
// Esta es la version 1: solo confirma que el bot esta vivo y responde.
// En el siguiente paso le agregamos la conexion a Google Calendar.

const { Telegraf } = require('telegraf');
const express = require('express');

// El token NUNCA se escribe aqui directo en el codigo.
// Se guarda como "variable de entorno" en el servidor (Render), por seguridad.
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('ERROR: falta la variable de entorno BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Comando /start - primer mensaje que ve cualquier usuario nuevo
bot.start((ctx) => {
  ctx.reply(
    '¡Hola! 👋 Soy tu bot de recordatorios.\n\n' +
    'Todavía estoy en construcción: por ahora solo repito lo que me escribes, ' +
    'para confirmar que la conexión funciona.\n\n' +
    'Prueba escribiéndome algo como:\n' +
    '"el lunes a las 5pm ir al concierto"'
  );
});

// Por ahora, cualquier mensaje de texto se responde con un eco de confirmación.
// Esto es solo para probar que el bot esta conectado y funcionando.
bot.on('text', (ctx) => {
  const mensaje = ctx.message.text;
  ctx.reply(`✅ Te recibí: "${mensaje}"\n\n(Todavía no lo agendo en Calendar, eso viene en el siguiente paso)`);
});

bot.launch();
console.log('Bot iniciado correctamente...');

// Pequeño servidor web solo para que Render sepa que el servicio esta "vivo"
const app = express();
app.get('/', (req, res) => res.send('El bot de recordatorios está corriendo ✅'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor web escuchando en el puerto ${PORT}`));

// Apagado limpio
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
