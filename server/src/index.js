require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Telegraf, Markup } = require('telegraf');
const Jimp = require('jimp');

const BOT_TOKEN  = process.env.BOT_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT       = process.env.PORT || 3000;

if (!BOT_TOKEN)  { console.error('BOT_TOKEN missing'); process.exit(1); }
if (!PUBLIC_URL) { console.error('PUBLIC_URL missing'); process.exit(1); }

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const bot    = new Telegraf(BOT_TOKEN);
let botUsername = '';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../../client')));

// ─────────────────────────────────────────────────────────────────────────────
// Health-check endpoint (used by railway.json healthcheckPath)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('OK'));

// ── Render canvas PNG ─────────────────────────────────────────────────────────
const CW = 1600, CH = 1000;

function hexToInt(hex) {
  try {
    const c = (hex || '#000').replace('#', '').padEnd(6, '0');
    return Jimp.rgbaToInt(
      parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16),
      parseInt(c.slice(4, 6), 16), 255
    );
  } catch { return 0x000000FF; }
}

function plotLine(img, x0, y0, x1, y1, col, r) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    for (let tx = -r; tx <= r; tx++) for (let ty = -r; ty <= r; ty++) {
      if (tx * tx + ty * ty <= r * r) {
        const px = x0 + tx, py = y0 + ty;
        if (px >= 0 && px < CW && py >= 0 && py < CH) img.setPixelColor(col, px, py);
      }
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx)  { err += dx; y0 += sy; }
  }
}

async function renderPNG(strokes, drawerName, word, done) {
  const img = new Jimp(CW, CH, 0xFFFFFFFF);
  for (const s of strokes) {
    const pts = s.points || [];
    if (pts.length < 2) continue;
    const col = hexToInt(s.color);
    const r   = Math.max(1, Math.round((s.size || 4) * 0.9));
    for (let i = 1; i < pts.length; i++) {
      plotLine(img,
        pts[i - 1][0] * 2, pts[i - 1][1] * 2,
        pts[i][0]     * 2, pts[i][1]     * 2,
        col, r * 2);
    }
  }
  const barCol = done ? 0x2dc653FF : 0x1a1a2eFF;
  for (let x = 0; x < CW; x++)
    for (let y = CH - 46; y < CH; y++) img.setPixelColor(barCol, x, y);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// ── State ─────────────────────────────────────────────────────────────────────
const rooms = new Map();

// FIX: Minimum players required before a round starts.
const MIN_PLAYERS = 1; // Set to 1 so a solo tester can verify the canvas loads.
                        // Change to 2 for real multiplayer enforcement.

const WORDS = [
  'cat','dog','house','tree','car','sun','moon','fish','bird','flower',
  'pizza','guitar','elephant','rainbow','rocket','castle','dragon','piano',
  'submarine','tornado','volcano','lighthouse','butterfly','telescope','snowman',
  'dinosaur','waterfall','helicopter','cactus','penguin','banana','scissors',
  'telephone','umbrella','bicycle','glasses','crown','anchor','compass','bridge',
  'robot','alien','wizard','knight','ninja','pirate','mermaid','unicorn',
];

function makeRoom(id, chatId) {
  return {
    id, chatId,
    clients: new Map(),
    strokes: [],
    currentDrawer: null,
    drawerName: '',
    word: null,
    guesses: new Set(),
    roundActive: false,
    liveMessageId: null,
    updateTimer: null,
  };
}

function bcast(room, msg, skip = null) {
  const d = JSON.stringify(msg);
  room.clients.forEach((c, id) => {
    if (id !== skip && c.ws.readyState === WebSocket.OPEN) c.ws.send(d);
  });
}

// ── Canvas push ───────────────────────────────────────────────────────────────
async function pushCanvas(room) {
  if (!room.chatId || !room.roundActive || !room.word) return;
  let png;
  try { png = await renderPNG(room.strokes, room.drawerName, room.word, false); }
  catch (e) { console.error('renderPNG error:', e.message); return; }

  const hint      = room.word.split('').map(() => '_').join(' ');
  const caption   = `🎨 *${room.drawerName}* is drawing!\n🔤 \`${hint}\` — ${room.word.length} letters\n\n💬 Type your guess here!`;
  const canvasUrl = `${PUBLIC_URL}/?room=${encodeURIComponent(room.id)}`;

  try {
    if (!room.liveMessageId) {
      const m = await bot.telegram.sendPhoto(
        room.chatId,
        { source: png, filename: 'drawing.png' },
        {
          caption,
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([Markup.button.url('🖌 Open Canvas', canvasUrl)]),
        }
      );
      room.liveMessageId = m.message_id;
      console.log(`[canvas] sent message_id=${m.message_id}`);
    } else {
      await bot.telegram.editMessageMedia(
        room.chatId, room.liveMessageId, null,
        { type: 'photo', media: { source: png, filename: 'drawing.png' }, caption, parse_mode: 'Markdown' }
      );
    }
  } catch (e) {
    if (e.message.includes('message is not modified')) return; // benign
    console.error('pushCanvas error:', e.message);
    // FIX: reset liveMessageId on any "message gone" error so the next push resends it fresh
    if (/(not found|deleted|no message|message to edit)/i.test(e.message)) {
      room.liveMessageId = null;
    }
  }
}

function scheduleUpdate(room) {
  if (room.updateTimer) return;
  room.updateTimer = setTimeout(async () => {
    room.updateTimer = null;
    await pushCanvas(room);
  }, 1200);
}

async function saveFinal(room, guesserName) {
  if (!room.chatId) return;
  let png;
  try { png = await renderPNG(room.strokes, room.drawerName, room.word, true); }
  catch (e) { console.error('saveFinal render error:', e.message); return; }

  if (room.liveMessageId) {
    try { await bot.telegram.deleteMessage(room.chatId, room.liveMessageId); } catch { /* ignore */ }
    room.liveMessageId = null;
  }

  const caption = [
    `✅ *Round Complete!*`, ``,
    `🖌 Artist: *${room.drawerName}*`,
    `🎯 Word: *${room.word}*`,
    guesserName ? `🏆 Guessed by: *${guesserName}*` : `😔 Nobody guessed!`,
    ``, `_Next round in 5 seconds..._`,
  ].join('\n');

  try {
    await bot.telegram.sendPhoto(
      room.chatId,
      { source: png, filename: `${room.word}.png` },
      { caption, parse_mode: 'Markdown' }
    );
  } catch (e) { console.error('saveFinal send error:', e.message); }
}

// ── Rounds ────────────────────────────────────────────────────────────────────
function startRound(room) {
  const ids = Array.from(room.clients.keys());

  // FIX: Guard — don't start if not enough players
  if (ids.length < MIN_PLAYERS) {
    console.log(`[round] Not enough players in room ${room.id} (${ids.length}/${MIN_PLAYERS}). Waiting...`);
    // FIX: Notify existing clients so the UI isn't just frozen
    bcast(room, { type: 'status', message: `Waiting for players… (${ids.length}/${MIN_PLAYERS} needed)` });
    return;
  }

  // FIX: Cancel any pending update timer before resetting state
  if (room.updateTimer) { clearTimeout(room.updateTimer); room.updateTimer = null; }

  room.strokes        = [];
  room.guesses        = new Set();
  room.roundActive    = true;
  room.liveMessageId  = null; // FIX: always reset so a fresh photo is sent each round
  room.currentDrawer  = ids[Math.floor(Math.random() * ids.length)];
  room.drawerName     = room.clients.get(room.currentDrawer)?.name || 'Someone';
  room.word           = WORDS[Math.floor(Math.random() * WORDS.length)];

  console.log(`[round] START room=${room.id} drawer=${room.drawerName} word=${room.word} players=${ids.length}`);

  // FIX: Send role messages individually — each client gets the right payload
  room.clients.forEach((c, id) => {
    const isDrawer = id === room.currentDrawer;
    const msg = isDrawer
      ? { type: 'role', role: 'drawer', word: room.word }
      : { type: 'role', role: 'guesser', hint: room.word.length };
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  });

  bcast(room, { type: 'clear' });
  bcast(room, { type: 'status', message: `${room.drawerName} is drawing!` });

  if (room.chatId) {
    bot.telegram.sendMessage(
      room.chatId,
      `🎮 *New Round!*\n\n✏️ *${room.drawerName}* is drawing...\n💬 Guess by typing here!`,
      { parse_mode: 'Markdown' }
    ).catch(e => console.error('[bot] sendMessage error:', e.message));
  }

  // Push first canvas snapshot after a short delay
  setTimeout(() => pushCanvas(room), 800);
}

async function endRound(room, guesserName) {
  if (!room.roundActive) return; // FIX: idempotency guard (already handled)
  room.roundActive   = false;
  room.currentDrawer = null; // FIX: reset drawer so reconnect logic works correctly

  if (room.updateTimer) { clearTimeout(room.updateTimer); room.updateTimer = null; }

  console.log(`[round] END room=${room.id} word=${room.word} guesser=${guesserName || 'none'}`);

  bcast(room, { type: 'round_end', word: room.word, drawerName: room.drawerName, guesser: guesserName || null });
  await saveFinal(room, guesserName);

  setTimeout(() => {
    if (rooms.has(room.id) && room.clients.size >= MIN_PLAYERS) {
      startRound(room);
    } else {
      console.log(`[round] Skipping next round — room gone or too few players`);
    }
  }, 5000);
}

// ── Bot commands ──────────────────────────────────────────────────────────────

// ── Bot commands ─────────────────────────────────────────────────────────────
//
// HOW THE MINI APP OPENS IN-GROUP (no private chat redirect)
//
// Telegram allows webApp buttons on inline keyboards attached to group messages
// sent by the bot. When the user taps, the Mini App opens as an overlay right
// inside the group chat — no private chat needed.
//
// REQUIREMENT: In @BotFather you must set the Menu Button URL to PUBLIC_URL so
// Telegram trusts the domain for in-group Mini App launches:
//   /mybots → your bot → Bot Settings → Menu Button → Set URL → <PUBLIC_URL>
// ─────────────────────────────────────────────────────────────────────────────

// GROUP: /startgame → opens canvas directly in-group via webApp button
bot.command('startgame', async (ctx) => {
  if (ctx.chat.type === 'private') {
    // Solo preview mode
    const canvasUrl = `${PUBLIC_URL}/?room=solo_${ctx.from.id}`;
    return ctx.reply(
      `👋 *Draw & Guess* is designed for groups!\n\nAdd me to a group and use /startgame there.\n\n_Or tap below to try the canvas solo:_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.webApp('🖌 Try Canvas (solo)', canvasUrl)]]),
      }
    );
  }

  const roomId = String(ctx.chat.id);
  if (!rooms.has(roomId)) {
    rooms.set(roomId, makeRoom(roomId, ctx.chat.id));
  } else {
    rooms.get(roomId).chatId = ctx.chat.id; // re-link after bot restart
  }

  const canvasUrl = `${PUBLIC_URL}/?room=${encodeURIComponent(roomId)}`;
  console.log(`[bot] /startgame room=${roomId} canvasUrl=${canvasUrl}`);

  await ctx.reply(
    `🎨 *Draw & Guess!*\n\nTap *🖌 Open Canvas* — the drawing board opens right here!\n\nEveryone else: type your guesses in this chat.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🖌 Open Canvas', canvasUrl)],
      ]),
    }
  );
});

// PRIVATE: /start — backwards compatibility with any old deep links
bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const parts  = ctx.message.text.split(' ');
  const roomId = parts[1] ? decodeURIComponent(parts[1]) : null;

  if (!roomId) {
    return ctx.reply('👋 Add me to a group and use /startgame there to play!');
  }

  if (!rooms.has(roomId)) {
    rooms.set(roomId, makeRoom(roomId, null));
    console.log(`[bot] /start stub room roomId=${roomId}`);
  }

  const canvasUrl = `${PUBLIC_URL}/?room=${encodeURIComponent(roomId)}`;
  await ctx.reply(
    `🎨 *Draw & Guess* — tap to open the canvas:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.webApp('🖌 Open Canvas', canvasUrl)]]),
    }
  );
});
bot.command('stopgame', async (ctx) => {
  const roomId = String(ctx.chat.id);
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    // FIX: cancel pending timers before deleting the room
    if (room.updateTimer) clearTimeout(room.updateTimer);
    rooms.delete(roomId);
    ctx.reply('🛑 Game stopped.');
  } else {
    ctx.reply('No active game.');
  }
});

bot.command('newround', async (ctx) => {
  const roomId = String(ctx.chat.id);
  const room   = rooms.get(roomId);
  if (!room)                 return ctx.reply('No game. Use /startgame first.');
  if (!room.clients.size)    return ctx.reply('No players on canvas yet!');
  await endRound(room, null);
});

// Group text = guesses
bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  const roomId = String(ctx.chat.id);
  const room   = rooms.get(roomId);
  if (!room || !room.roundActive || !room.word) return;

  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;

  const userId   = String(ctx.from.id);
  // FIX: do not block the drawer from seeing their own confirmation in group chat,
  //      but do prevent them from accidentally ending the round with the correct word
  if (userId === room.currentDrawer) return;
  if (room.guesses.has(userId)) return;

  const userName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
    || ctx.from.username || 'Player';
  const correct  = text.toLowerCase() === room.word.toLowerCase();

  bcast(room, { type: 'guess', name: userName, text, correct });

  if (correct) {
    room.guesses.add(userId);
    await endRound(room, userName);
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const url      = new URL(req.url, 'http://localhost');
  const roomId   = url.searchParams.get('room') || 'default';
  const name     = url.searchParams.get('name') || `Player${Math.floor(Math.random() * 1000)}`;

  if (!rooms.has(roomId)) rooms.set(roomId, makeRoom(roomId, null));
  const room = rooms.get(roomId);
  room.clients.set(clientId, { ws, name });

  console.log(`[ws] +${name} → room=${roomId} total=${room.clients.size}`);

  // Send current state to the new client
  ws.send(JSON.stringify({ type: 'init', strokes: room.strokes, players: room.clients.size }));
  bcast(room, { type: 'player_joined', name, count: room.clients.size }, clientId);

  // FIX: Only auto-start a round if one isn't already active
  if (!room.roundActive && !room.currentDrawer) {
    if (room.clients.size >= MIN_PLAYERS) {
      console.log(`[ws] Enough players — starting round in room=${roomId}`);
      setTimeout(() => startRound(room), 800);
    } else {
      // Inform the new client that we're waiting
      ws.send(JSON.stringify({
        type: 'status',
        message: `Waiting for players… (${room.clients.size}/${MIN_PLAYERS} needed)`,
      }));
    }
  } else if (room.roundActive) {
    // FIX: Catch up late-joiner — send them the correct role
    const isDrawer = clientId === room.currentDrawer; // always false for a new client
    ws.send(JSON.stringify({
      type: 'role',
      role: 'guesser',
      hint: room.word ? room.word.length : 0,
    }));
    ws.send(JSON.stringify({ type: 'status', message: `${room.drawerName} is drawing!` }));
  }

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'draw':
        if (clientId !== room.currentDrawer) return;
        room.strokes.push(msg.stroke);
        bcast(room, { type: 'draw', stroke: msg.stroke }, clientId);
        scheduleUpdate(room);
        break;

      case 'clear':
        if (clientId !== room.currentDrawer) return;
        room.strokes = [];
        bcast(room, { type: 'clear' });
        scheduleUpdate(room);
        break;

      case 'snapshot':
        if (clientId !== room.currentDrawer) return;
        bcast(room, { type: 'snapshot', data: msg.data }, clientId);
        break;

      case 'guess': {
        if (clientId === room.currentDrawer) return; // drawer can't guess
        const t  = (msg.text || '').trim();
        if (!t) return;
        const ok = !!room.word && t.toLowerCase() === room.word.toLowerCase();
        bcast(room, { type: 'guess', name, text: t, correct: ok });
        if (ok) endRound(room, name);
        break;
      }

      case 'done_drawing':
        if (clientId !== room.currentDrawer) return;
        endRound(room, null);
        break;
    }
  });

  ws.on('close', () => {
    room.clients.delete(clientId);
    console.log(`[ws] -${name} left room=${roomId} remaining=${room.clients.size}`);
    bcast(room, { type: 'player_left', name, count: room.clients.size });

    if (room.currentDrawer === clientId) {
      // FIX: drawer disconnected — cleanly end the round (if active) then restart
      room.currentDrawer = null;
      if (room.roundActive) {
        room.roundActive = false;
        if (room.updateTimer) { clearTimeout(room.updateTimer); room.updateTimer = null; }
        bcast(room, { type: 'status', message: `${name} (drawer) disconnected. New round soon…` });
        if (room.chatId) {
          bot.telegram.sendMessage(room.chatId, `⚠️ *${name}* (drawer) disconnected. Starting new round...`,
            { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
      if (room.clients.size >= MIN_PLAYERS) {
        setTimeout(() => startRound(room), 2000);
      }
    }
  });

  ws.on('error', err => {
    console.error(`[ws] error for ${name}:`, err.message);
    ws.close();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

// FIX 409: Telegraf's bot.launch() runs the polling loop in the background.
// When a 409 occurs it throws *inside* the async polling loop — outside any
// try/catch we wrap around bot.launch(). The only reliable intercept point is
// process.on('uncaughtException') / process.on('unhandledRejection').
//
// Strategy:
//   1. deleteWebhook before every launch to evict the old instance's session.
//   2. Catch 409 at the process level, stop the current bot instance cleanly,
//      wait, then restart — without crashing the HTTP/WS server.

let botRestartTimer = null;

function stopBot() {
  try { bot.stop(); } catch { /* already stopped */ }
}

async function launchBot(retryCount = 0) {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('[bot] Webhook cleared');

    const me = await bot.telegram.getMe();
    botUsername = me.username;

    await bot.telegram.setMyCommands([
      { command: 'startgame', description: 'Start Draw & Guess in this group' },
      { command: 'stopgame',  description: 'Stop the game' },
      { command: 'newround',  description: 'Skip to next round' },
    ]);

    // bot.launch() returns a Promise that resolves when the bot is stopped.
    // We do NOT await it — we let it run in the background.
    // Errors from the polling loop are caught via unhandledRejection below.
    bot.launch({ allowedUpdates: ['message', 'callback_query'] })
      .catch(e => {
        // This catches errors from the *polling loop* (including 409)
        if (e.response?.error_code === 409) {
          console.warn('[bot] 409 Conflict caught from polling loop');
          handle409(retryCount);
        } else {
          console.error('[bot] Polling loop error:', e.message);
        }
      });

    console.log(`🤖 @${botUsername} running`);
  } catch (e) {
    // Errors from deleteWebhook / getMe / setMyCommands
    if (e.response?.error_code === 409) {
      handle409(retryCount);
    } else {
      console.error('[bot] Launch setup error:', e.message);
    }
  }
}

function handle409(retryCount) {
  if (botRestartTimer) return; // already scheduled
  const maxRetries = 5;
  if (retryCount >= maxRetries) {
    console.error(`[bot] Giving up after ${maxRetries} retries. Restart the service manually.`);
    return;
  }
  const delay = Math.min(3000 * Math.pow(2, retryCount), 30000); // exp back-off, max 30s
  console.warn(`[bot] Scheduling restart in ${delay / 1000}s (attempt ${retryCount + 1}/${maxRetries})`);
  stopBot();
  botRestartTimer = setTimeout(() => {
    botRestartTimer = null;
    launchBot(retryCount + 1);
  }, delay);
}

// Safety net: catch any 409 that escapes via unhandledRejection
process.on('unhandledRejection', (reason) => {
  const code = reason?.response?.error_code;
  if (code === 409) {
    console.warn('[bot] 409 caught via unhandledRejection');
    handle409(0);
  } else {
    // Log but don't crash the process for other unhandled rejections
    console.error('[process] Unhandled rejection:', reason?.message || reason);
  }
});

process.on('uncaughtException', (err) => {
  const code = err?.response?.error_code;
  if (code === 409) {
    console.warn('[bot] 409 caught via uncaughtException');
    handle409(0);
  } else {
    // For non-409 uncaught exceptions, log and exit (standard behavior)
    console.error('[process] Uncaught exception:', err.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
  // 1s delay gives Railway time to kill the old container's network connections
  // before we hit the Telegram API, reducing (but not eliminating) 409 chances.
  setTimeout(() => launchBot(), 1000);
});

process.once('SIGINT',  () => { stopBot(); server.close(); });
process.once('SIGTERM', () => { stopBot(); server.close(); });
