// Bot de Telegram - Recordatorios conectado a Google Calendar
// Version 2: cada usuario conecta su propio Google Calendar,
// y lo que escribe se agenda automaticamente ahi.

const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const chrono = require('chrono-node');
const speech = require('@google-cloud/speech');

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

// --- Cliente de Google Speech-to-Text (para entender audios) ---
function crearSpeechClient() {
  const keysJson = process.env.GOOGLE_SPEECH_CREDENTIALS_JSON;
  if (!keysJson) return null;
  try {
    const keys = JSON.parse(keysJson);
    return new speech.SpeechClient({
      credentials: {
        client_email: keys.client_email,
        private_key: keys.private_key,
      },
      projectId: keys.project_id,
    });
  } catch (e) {
    console.error('GOOGLE_SPEECH_CREDENTIALS_JSON inválido:', e);
    return null;
  }
}

const speechClient = crearSpeechClient();

async function transcribirAudio(buffer) {
  const [response] = await speechClient.recognize({
    audio: { content: buffer.toString('base64') },
    config: {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'es-PE',
    },
  });
  if (!response.results || response.results.length === 0) return '';
  return response.results.map((r) => r.alternatives[0].transcript).join(' ').trim();
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

// --- Lógica compartida: convierte un texto en un evento de Calendar ---
async function procesarRecordatorio(ctx, chatId, texto) {
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
}

// --- Mensajes de texto: se procesan directo ---
bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const texto = ctx.message.text;
  await procesarRecordatorio(ctx, chatId, texto);
});

// --- Mensajes de voz: primero se transcriben, luego se procesan igual ---
bot.on('voice', async (ctx) => {
  const chatId = String(ctx.chat.id);

  if (!speechClient) {
    return ctx.reply('El reconocimiento de audio todavía no está configurado. Escríbeme el recordatorio en texto por ahora 🙂');
  }

  const tokens = obtenerTokens(chatId);
  if (!tokens) {
    return ctx.reply('Primero conecta tu Google Calendar con /conectar 🙂');
  }

  try {
    await ctx.reply('🎙️ Escuchando tu audio...');

    const fileId = ctx.message.voice.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const respuesta = await fetch(fileLink.href);
    const arrayBuffer = await respuesta.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const texto = await transcribirAudio(buffer);

    if (!texto) {
      return ctx.reply('No logré entender el audio 😅 Intenta de nuevo o escríbelo en texto.');
    }

    await ctx.reply(`Escuché: "${texto}"`);
    await procesarRecordatorio(ctx, chatId, texto);
  } catch (err) {
    console.error('Error procesando audio:', err);
    ctx.reply('Hubo un problema procesando tu audio. Intenta de nuevo.');
  }
});

bot.launch();
console.log('Bot iniciado correctamente...');

// --- Servidor web: health check + callback de Google OAuth ---
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Bot Recordatorios</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; line-height: 1.6;">
        <h1>Bot Recordatorios</h1>
        <p>Bot Recordatorios es un bot de Telegram que permite a cualquier persona escribir un recordatorio en lenguaje natural (por ejemplo: "el lunes a las 5pm ir al concierto") y crearlo automáticamente como un evento en su propio Google Calendar.</p>
        <p>El bot solo crea eventos en el calendario del usuario que se conecta voluntariamente con su cuenta de Google. No comparte, vende ni usa los datos del calendario para ningún otro fin.</p>
        <p>Puedes usar el bot buscando <b>@Gus_Recordatorio_bot</b> en Telegram.</p>
        <p><a href="/privacy">Política de privacidad</a></p>
      </body>
    </html>
  `);
});

app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <head><title>Política de Privacidad - Bot Recordatorios</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; line-height: 1.6;">
        <h1>Política de Privacidad</h1>
        <p>Bot Recordatorios ("el bot") es una herramienta gratuita de Telegram que ayuda a los usuarios a crear recordatorios en su propio Google Calendar.</p>
        <h2>Qué datos usamos</h2>
        <p>Cuando un usuario conecta su cuenta de Google mediante el comando /conectar, el bot solicita permiso únicamente para crear eventos en su Google Calendar (alcance "calendar.events"). El bot no lee, modifica ni elimina otros eventos existentes, y no accede a ninguna otra información de la cuenta de Google del usuario.</p>
        <h2>Cómo usamos los datos</h2>
        <p>El token de acceso de Google del usuario se guarda únicamente para poder crear los eventos que el propio usuario solicita por Telegram. Este token no se comparte, vende ni transfiere a terceros bajo ninguna circunstancia.</p>
        <h2>Cómo eliminar tus datos</h2>
        <p>Un usuario puede revocar el acceso del bot en cualquier momento desde <a href="https://myaccount.google.com/permissions" target="_blank">la configuración de su cuenta de Google</a>, o escribiéndole al administrador del bot para solicitar la eliminación de sus datos guardados.</p>
        <h2>Contacto</h2>
        <p>Para dudas sobre esta política, contacta al administrador del bot a través de Telegram.</p>
      </body>
    </html>
  `);
});

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
