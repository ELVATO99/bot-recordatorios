// Bot de Telegram - Recordatorios conectado a Google Calendar
// Version 2: cada usuario conecta su propio Google Calendar,
// y lo que escribe se agenda automaticamente ahi.

const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const chrono = require('chrono-node');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI; // ej: https://tu-app.onrender.com/oauth2callback

if (!BOT_TOKEN || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error('ERROR: falta alguna variable de entorno (BOT_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)');
  process.exit(1);
}

// --- Guardado sencillo de los "tokens" de cada usuario en un archivo ---
// (mas adelante se puede migrar a una base de datos para mas confiabilidad)
const DATA_FILE = path.join(__dirname, 'usuarios.json');

function cargarUsuarios() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function guardarUsuario(chatId, tokens) {
  const usuarios = cargarUsuarios();
  usuarios[chatId] = tokens;
  fs.writeFileSync(DATA_FILE, JSON.stringify(usuarios, null, 2));
}

function obtenerTokens(chatId) {
  const usuarios = cargarUsuarios();
  return usuarios[chatId] || null;
}

function crearOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

const bot = new Telegraf(BOT_TOKEN);

// --- Comando /start ---
bot.start((ctx) => {
  ctx.reply(
    '¡Hola! 👋 Soy tu bot de recordatorios.\n\n' +
    'Para empezar, conecta tu Google Calendar con el comando:\n' +
    '/conectar\n\n' +
    'Después, solo escríbeme cosas como:\n' +
    '"el lunes a las 5pm ir al concierto"\n' +
    '"el 15 de febrero pagar el agua"'
  );
});

// --- Comando /conectar ---
bot.command('conectar', (ctx) => {
  const chatId = String(ctx.chat.id);
  const oauth2Client = crearOAuthClient();

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: chatId,
  });

  ctx.reply(
    'Toca este link para conectar tu Google Calendar:\n' + url +
    '\n\nSolo lo tienes que hacer una vez.'
  );
});

// --- Cualquier otro mensaje de texto: lo interpretamos como recordatorio ---
bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const texto = ctx.message.text;

  const tokens = obtenerTokens(chatId);
  if (!tokens) {
    return ctx.reply('Primero conecta tu Google Calendar con /conectar 🙂');
  }

  const resultado = chrono.es.parse(texto, new Date(), { forwardDate: true });

  if (!resultado || resultado.length === 0) {
    return ctx.reply(
      'No pude entender la fecha en tu mensaje 😅\n' +
      'Prueba algo como: "el lunes a las 5pm ir al concierto"'
    );
  }

  const inicio = resultado[0].start.date();
  const fin = new Date(inicio.getTime() + 60 * 60 * 1000);

  let titulo = texto.replace(resultado[0].text, '').trim();
  if (!titulo) titulo = texto;

  try {
    const oauth2Client = crearOAuthClient();
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: titulo,
        start: { dateTime: inicio.toISOString() },
        end: { dateTime: fin.toISOString() },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 30 },
          ],
        },
      },
    });

    const fechaLegible = inicio.toLocaleString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });

    ctx.reply(`✅ Listo, agendé: "${titulo}"\n📅 ${fechaLegible}`);
  } catch (err) {
    console.error('Error creando evento:', err);
    ctx.reply('Hubo un problema agendando eso. Intenta conectar de nuevo con /conectar');
  }
});

bot.launch();
console.log('Bot iniciado correctamente...');

// --- Servidor web: health check + callback de Google OAuth ---
const app = express();

app.get('/', (req, res) => res.send('El bot de recordatorios está corriendo ✅'));

app.get('/oauth2callback', async (req, res) => {
  const { code, state } = req.query;
  const chatId = state;

  if (!code || !chatId) {
    return res.status(400).send('Faltan datos en la conexión. Vuelve a intentar desde /conectar en Telegram.');
  }

  try {
    const oauth2Client = crearOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    guardarUsuario(chatId, tokens);

    await bot.telegram.sendMessage(chatId, '✅ ¡Tu Google Calendar quedó conectado! Ya puedes escribirme tus recordatorios.');

    res.send('¡Listo! Ya puedes volver a Telegram 🎉');
  } catch (err) {
    console.error('Error en oauth2callback:', err);
    res.status(500).send('Hubo un error conectando tu cuenta. Vuelve a intentar desde /conectar en Telegram.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor web escuchando en el puerto ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
