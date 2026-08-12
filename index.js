// Bot de Telegram - Recordatorios conectado a Google Calendar
// Version 3: link corto para conectar, correccion de errores de tipeo,
// hora por defecto en la mañana, limpieza de mensajes de audio,
// link para editar y comando /deshacer.

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
const PUBLIC_URL = GOOGLE_REDIRECT_URI ? GOOGLE_REDIRECT_URI.replace('/oauth2callback', '') : null;

if (!BOT_TOKEN || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error('ERROR: falta alguna variable de entorno (BOT_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)');
  process.exit(1);
}

// --- Guardado sencillo de los "tokens" de cada usuario en un archivo ---
const DATA_FILE = path.join(__dirname, 'usuarios.json');
const EVENTOS_FILE = path.join(__dirname, 'ultimo_evento.json');

function leerJSON(archivo) {
  try {
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch (e) {
    return {};
  }
}

function guardarUsuario(chatId, tokens) {
  const usuarios = leerJSON(DATA_FILE);
  usuarios[chatId] = tokens;
  fs.writeFileSync(DATA_FILE, JSON.stringify(usuarios, null, 2));
}

function obtenerTokens(chatId) {
  const usuarios = leerJSON(DATA_FILE);
  return usuarios[chatId] || null;
}

function guardarUltimoEvento(chatId, eventId) {
  const eventos = leerJSON(EVENTOS_FILE);
  eventos[chatId] = eventId;
  fs.writeFileSync(EVENTOS_FILE, JSON.stringify(eventos, null, 2));
}

function obtenerUltimoEvento(chatId) {
  const eventos = leerJSON(EVENTOS_FILE);
  return eventos[chatId] || null;
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

// --- Corrector simple de errores de tipeo en fechas ---
const PALABRAS_FECHA = [
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre',
  'manana', 'hoy', 'pasado',
];

function distanciaLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function quitarTildes(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizarTexto(texto) {
  let t = texto.replace(/\balas\b/gi, 'a las');

  t = t.split(' ').map((palabra) => {
    const limpia = quitarTildes(palabra.replace(/[.,!?]/g, '').toLowerCase());
    if (limpia.length < 4) return palabra;

    let mejor = null;
    let mejorDist = 3;
    for (const clave of PALABRAS_FECHA) {
      const d = distanciaLevenshtein(limpia, clave);
      if (d < mejorDist && d <= 2) {
        mejor = clave;
        mejorDist = d;
      }
    }
    return mejor && mejor !== limpia ? mejor : palabra;
  }).join(' ');

  return t;
}

const bot = new Telegraf(BOT_TOKEN);

// --- Comando /start ---
bot.start((ctx) => {
  ctx.reply(
    '¡Hola! 👋 Soy tu bot de recordatorios.\n\n' +
    'Para empezar, conecta tu Google Calendar con el comando:\n' +
    '/conectar\n\n' +
    'Después, solo escríbeme o mándame audios como:\n' +
    '"el lunes a las 5pm ir al concierto"\n' +
    '"el 15 de febrero pagar el agua"\n\n' +
    'Si algo queda mal agendado, usa /deshacer para borrar el último recordatorio.'
  );
});

// --- Comando /conectar (con link corto) ---
bot.command('conectar', (ctx) => {
  const chatId = String(ctx.chat.id);
  ctx.reply(
    'Toca este link para conectar tu Google Calendar:\n' +
    `${PUBLIC_URL}/conectar/${chatId}` +
    '\n\nSolo lo tienes que hacer una vez.'
  );
});

// --- Comando /deshacer ---
bot.command('deshacer', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const tokens = obtenerTokens(chatId);
  if (!tokens) return ctx.reply('Primero conecta tu Google Calendar con /conectar 🙂');

  const eventId = obtenerUltimoEvento(chatId);
  if (!eventId) return ctx.reply('No tengo ningún recordatorio reciente para borrar.');

  try {
    const oauth2Client = crearOAuthClient();
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    await calendar.events.delete({ calendarId: 'primary', eventId });
    ctx.reply('🗑️ Listo, borré el último recordatorio que agendé.');
  } catch (err) {
    console.error('Error borrando evento:', err);
    ctx.reply('No pude borrarlo (puede que ya lo hayas editado o borrado directo en Google Calendar).');
  }
});

// --- Lógica compartida: convierte un texto en un evento de Calendar ---
async function procesarRecordatorio(ctx, chatId, textoOriginal) {
  const tokens = obtenerTokens(chatId);
  if (!tokens) {
    return ctx.reply('Primero conecta tu Google Calendar con /conectar 🙂');
  }

  const texto = normalizarTexto(textoOriginal);
  const resultado = chrono.es.parse(texto, new Date(), { forwardDate: true });

  if (!resultado || resultado.length === 0) {
    return ctx.reply(
      'No pude entender la fecha en tu mensaje 😅\n' +
      'Prueba algo como: "el lunes a las 5pm ir al concierto"'
    );
  }

  const componentes = resultado[0].start;
  const inicio = componentes.date();

  // Si no dijo una hora especifica, usamos 9am por defecto (en vez del mediodia)
  if (!componentes.isCertain('hour')) {
    inicio.setHours(9, 0, 0, 0);
  }

  const fin = new Date(inicio.getTime() + 60 * 60 * 1000);

  let titulo = texto.replace(resultado[0].text, '').trim();
  titulo = titulo.replace(/\s{2,}/g, ' ').trim();
  if (!titulo) titulo = texto;

  try {
    const oauth2Client = crearOAuthClient();
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const eventoCreado = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: titulo,
        start: { dateTime: inicio.toISOString() },
        end: { dateTime: fin.toISOString() },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: 30 }],
        },
      },
    });

    guardarUltimoEvento(chatId, eventoCreado.data.id);

    const fechaLegible = inicio.toLocaleString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });

    ctx.reply(
      `✅ Listo, agendé: "${titulo}"\n📅 ${fechaLegible}\n\n` +
      `Ver o editar: ${eventoCreado.data.htmlLink}\n` +
      `¿Está mal? Usa /deshacer para borrarlo.`
    );
  } catch (err) {
    console.error('Error creando evento:', err);
    ctx.reply('Hubo un problema agendando eso. Intenta conectar de nuevo con /conectar');
  }
}

// --- Mensajes de texto: se procesan directo ---
bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const texto = ctx.message.text;
  if (texto.startsWith('/')) return; // ignora comandos no reconocidos
  await procesarRecordatorio(ctx, chatId, texto);
});

// --- Mensajes de voz: se transcriben, se muestra el resultado limpio, y se procesan igual ---
bot.on('voice', async (ctx) => {
  const chatId = String(ctx.chat.id);

  if (!speechClient) {
    return ctx.reply('El reconocimiento de audio todavía no está configurado. Escríbeme el recordatorio en texto por ahora 🙂');
  }

  const tokens = obtenerTokens(chatId);
  if (!tokens) {
    return ctx.reply('Primero conecta tu Google Calendar con /conectar 🙂');
  }

  let msgEscuchando;
  try {
    msgEscuchando = await ctx.reply('🎙️ Escuchando tu audio...');

    const fileId = ctx.message.voice.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const respuesta = await fetch(fileLink.href);
    const arrayBuffer = await respuesta.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const texto = await transcribirAudio(buffer);

    // Borramos el mensaje de "Escuchando..." antes de seguir
    try { await ctx.telegram.deleteMessage(chatId, msgEscuchando.message_id); } catch (e) {}

    if (!texto) {
      return ctx.reply('No logré entender el audio 😅 Intenta de nuevo o escríbelo en texto.');
    }

    await procesarRecordatorio(ctx, chatId, texto);
  } catch (err) {
    console.error('Error procesando audio:', err);
    if (msgEscuchando) {
      try { await ctx.telegram.deleteMessage(chatId, msgEscuchando.message_id); } catch (e) {}
    }
    ctx.reply('Hubo un problema procesando tu audio. Intenta de nuevo.');
  }
});

bot.launch();
console.log('Bot iniciado correctamente...');

// --- Servidor web: paginas, callback de Google OAuth, y link corto de conexion ---
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Bot Recordatorios</title></head>
      <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; line-height: 1.6;">
        <h1>Bot Recordatorios</h1>
        <p>Bot Recordatorios es un bot de Telegram que permite a cualquier persona escribir (o mandar audio) un recordatorio en lenguaje natural y crearlo automáticamente como un evento en su propio Google Calendar.</p>
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
        <p>Cuando un usuario conecta su cuenta de Google mediante el comando /conectar, el bot solicita permiso únicamente para crear eventos en su Google Calendar (alcance "calendar.events"). El bot no lee, modifica ni elimina otros eventos existentes, y no accede a ninguna otra información de la cuenta de Google del usuario. Si el usuario envía un audio, este se transcribe a texto usando Google Speech-to-Text únicamente para entender el recordatorio, y no se guarda.</p>
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

// Link corto: /conectar/<chatId> redirige al link largo de Google
app.get('/conectar/:chatId', (req, res) => {
  const chatId = req.params.chatId;
  const oauth2Client = crearOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: chatId,
  });
  res.redirect(url);
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

    await bot.telegram.sendMessage(chatId, '✅ ¡Tu Google Calendar quedó conectado! Ya puedes escribirme o mandarme audios con tus recordatorios.');

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
