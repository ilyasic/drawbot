require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const { Telegraf, Markup } = require('telegraf');
const Jimp       = require('jimp');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN         = process.env.BOT_TOKEN;
const PUBLIC_URL        = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT              = process.env.PORT || 3000;
const ALLOW_EXTERNAL_URL = process.env.ALLOW_EXTERNAL_URL === 'true';
const WEBAPP_SHORT_NAME  = process.env.WEBAPP_SHORT_NAME || 'draw1';
const ROUND_DURATION_MS  = parseInt(process.env.ROUND_DURATION_MS || '90000'); // 90s default
const HINT_INTERVAL_MS   = parseInt(process.env.HINT_INTERVAL_MS  || '20000'); // reveal a letter every 20s

if (!BOT_TOKEN)  { console.error('BOT_TOKEN missing');  process.exit(1); }
if (!PUBLIC_URL) { console.error('PUBLIC_URL missing'); process.exit(1); }

console.log(`[config] ALLOW_EXTERNAL_URL=${ALLOW_EXTERNAL_URL} WEBAPP=${WEBAPP_SHORT_NAME} ROUND=${ROUND_DURATION_MS/1000}s`);

// ── Express / WS / Bot ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const bot    = new Telegraf(BOT_TOKEN);
let   botUsername = '';

app.use(express.json());

// Log every incoming request BEFORE static so we see everything
app.use((req, res, next) => {
  if (req.path !== '/ping') {
    console.log(`[http] ${req.method} ${req.path}`);
  }
  next();
});

// Static files AFTER logging and webhook routes
// (registered below after webhook route)

app.get('/ping', (req, res) => res.send('pong'));

app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const isTelegram = /TelegramBot|Telegram/i.test(ua);
  if (!ALLOW_EXTERNAL_URL && !isTelegram && /text\/html/i.test(req.headers['accept'] || '')) {
    return res.status(403).send('<h2 style="font-family:sans-serif;padding:2rem">Open inside Telegram only 🎨</h2>');
  }
  res.send('OK');
});

// ── Webhook secret and route (must be defined before server.listen) ──────────
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ||
  require('crypto').createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0,32);
const WEBHOOK_PATH   = `/webhook/${WEBHOOK_SECRET}`;
const WEBHOOK_URL    = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// Telegram POSTs updates to this endpoint
app.post(WEBHOOK_PATH, async (req, res) => {
  console.log('[webhook] ← received update:', JSON.stringify(req.body).slice(0, 120));
  try {
    if (!req.body || !req.body.update_id) {
      console.warn('[webhook] Invalid body — missing update_id');
      return res.sendStatus(400);
    }
    await bot.handleUpdate(req.body);
    console.log('[webhook] ✅ handled update_id:', req.body.update_id);
    res.sendStatus(200);
  } catch(e) {
    console.error('[webhook] handleUpdate error:', e.message, e.stack?.split('\n')[1]);
    res.sendStatus(500);
  }
});

// Quick test endpoint to confirm webhook path is reachable
app.get(WEBHOOK_PATH, (req, res) => res.send('Webhook endpoint active ✅'));

// Static files served last — after all API/webhook routes
app.use(express.static(path.join(__dirname, '../../client')));


// ── Canvas render (PNG for Telegram) ─────────────────────────────────────────
const RENDER_W = 1600, RENDER_H = 1000;

function hexToInt(hex) {
  try {
    const c = (hex || '#000').replace('#', '').padEnd(6, '0');
    return Jimp.rgbaToInt(
      parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16),
      parseInt(c.slice(4,6),16), 255);
  } catch { return 0x000000FF; }
}

function plotLine(img, x0,y0,x1,y1, col, r) {
  x0=Math.round(x0); y0=Math.round(y0); x1=Math.round(x1); y1=Math.round(y1);
  const dx=Math.abs(x1-x0), dy=Math.abs(y1-y0);
  const sx=x0<x1?1:-1, sy=y0<y1?1:-1;
  let err=dx-dy;
  for(;;) {
    for(let tx=-r;tx<=r;tx++) for(let ty=-r;ty<=r;ty++) {
      if(tx*tx+ty*ty<=r*r){
        const px=x0+tx,py=y0+ty;
        if(px>=0&&px<RENDER_W&&py>=0&&py<RENDER_H) img.setPixelColor(col,px,py);
      }
    }
    if(x0===x1&&y0===y1) break;
    const e2=2*err;
    if(e2>-dy){err-=dy;x0+=sx;}
    if(e2<dx ){err+=dx;y0+=sy;}
  }
}

async function renderPNG(strokes, done) {
  const img = new Jimp(RENDER_W, RENDER_H, 0xFFFFFFFF);
  for (const s of strokes) {
    const pts = s.points || [];
    if (pts.length < 2) continue;
    const col = hexToInt(s.color);
    const r   = Math.max(1, Math.round((s.size || 4) * 0.9));
    for (let i=1; i<pts.length; i++)
      plotLine(img, pts[i-1][0]*2, pts[i-1][1]*2, pts[i][0]*2, pts[i][1]*2, col, r*2);
  }
  const barCol = done ? 0x2dc653FF : 0x1a1a2eFF;
  for (let x=0;x<RENDER_W;x++) for(let y=RENDER_H-46;y<RENDER_H;y++) img.setPixelColor(barCol,x,y);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// ── Word list ─────────────────────────────────────────────────────────────────
const WORDS = {
  easy: ['cat','dog','sun','car','fish','bird','moon','tree','house','flower',
         'apple','pizza','smile','heart','star','cake','boat','rain','snow','book'],
  medium: ['guitar','elephant','rainbow','castle','dragon','piano','volcano','butterfly',
           'telescope','snowman','dinosaur','waterfall','helicopter','cactus','penguin',
           'banana','scissors','telephone','umbrella','bicycle'],
  hard: ['submarine','tornado','lighthouse','compass','anchor','mermaid','unicorn',
         'wizard','knight','ninja','pirate','robot','alien','crown','bridge',
         'glasses','rocket','glasses','crown','compass'],
};
const ALL_WORDS = [...WORDS.easy, ...WORDS.medium, ...WORDS.hard];

function pickWord() { return ALL_WORDS[Math.floor(Math.random() * ALL_WORDS.length)]; }

// ── State ─────────────────────────────────────────────────────────────────────
const rooms = new Map();
const MIN_PLAYERS = 1;

function makeRoom(id, chatId) {
  return {
    id, chatId,
    clients:       new Map(),   // clientId → { ws, name, userId, score }
    strokes:       [],
    currentDrawer: null,
    drawerName:    '',
    word:          null,
    hintRevealed:  [],          // array of booleans per letter
    guesses:       new Set(),   // userIds who guessed correctly
    roundActive:   false,
    roundTimer:    null,
    hintTimer:     null,
    updateTimer:   null,
    liveMessageId: null,
    scores:        new Map(),   // name → total score
    roundNumber:   0,
    roundStartTime:0,
    drawerQueue:   [],          // rotation queue of clientIds
  };
}

function bcast(room, msg, skip=null) {
  const d = JSON.stringify(msg);
  room.clients.forEach((c,id) => {
    if (id !== skip && c.ws.readyState === WebSocket.OPEN) c.ws.send(d);
  });
}

function sendTo(room, clientId, msg) {
  const c = room.clients.get(clientId);
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

// ── Hint system ───────────────────────────────────────────────────────────────
function buildHint(word, revealed) {
  return word.split('').map((ch,i) => ch===' ' ? ' ' : (revealed[i] ? ch : '_')).join(' ');
}

function revealNextHint(room) {
  if (!room.word || !room.roundActive) return;
  const unrevealed = room.word.split('').map((_,i)=>i).filter(i => room.word[i]!==' ' && !room.hintRevealed[i]);
  if (!unrevealed.length) return;
  const idx = unrevealed[Math.floor(Math.random()*unrevealed.length)];
  room.hintRevealed[idx] = true;
  const hint = buildHint(room.word, room.hintRevealed);
  bcast(room, { type:'hint', hint });
  // Schedule next hint
  room.hintTimer = setTimeout(() => revealNextHint(room), HINT_INTERVAL_MS);
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function getLeaderboard(room) {
  return Array.from(room.scores.entries())
    .sort((a,b) => b[1]-a[1])
    .map(([name,score],i) => ({ rank:i+1, name, score }));
}

function formatLeaderboard(room) {
  const lb = getLeaderboard(room);
  if (!lb.length) return 'No scores yet.';
  const medals = ['🥇','🥈','🥉'];
  return lb.slice(0,10).map(({rank,name,score}) =>
    `${medals[rank-1]||`${rank}.`} *${name}* — ${score} pts`).join('\n');
}

// ── Canvas push ───────────────────────────────────────────────────────────────
async function pushCanvas(room) {
  if (!room.chatId || !room.roundActive || !room.word) return;
  let png;
  try { png = await renderPNG(room.strokes, false); }
  catch(e) { console.error('renderPNG:', e.message); return; }

  const hint      = buildHint(room.word, room.hintRevealed);
  const caption   = `🎨 *${room.drawerName}* is drawing!\n🔤 \`${hint}\` — ${room.word.length} letters\n\n💬 Guess in the chat!`;
  const canvasUrl = `${PUBLIC_URL}/?room=${encodeURIComponent(room.id)}`;

  try {
    if (!room.liveMessageId) {
      const m = await bot.telegram.sendPhoto(room.chatId,
        { source:png, filename:'drawing.png' },
        { caption, parse_mode:'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.url('🖌 Open Canvas', canvasUrl)]]) });
      room.liveMessageId = m.message_id;
    } else {
      await bot.telegram.editMessageMedia(room.chatId, room.liveMessageId, null,
        { type:'photo', media:{ source:png, filename:'drawing.png' }, caption, parse_mode:'Markdown' });
    }
  } catch(e) {
    if (/not modified/i.test(e.message)) return;
    console.error('pushCanvas:', e.message);
    if (/not found|deleted|no message|message to edit/i.test(e.message)) room.liveMessageId = null;
  }
}

function scheduleUpdate(room) {
  if (room.updateTimer) return;
  room.updateTimer = setTimeout(async () => { room.updateTimer=null; await pushCanvas(room); }, 1500);
}

async function saveFinal(room, guesserName) {
  if (!room.chatId) return;
  let png;
  try { png = await renderPNG(room.strokes, true); }
  catch(e) { console.error('saveFinal render:', e.message); return; }
  if (room.liveMessageId) {
    try { await bot.telegram.deleteMessage(room.chatId, room.liveMessageId); } catch{}
    room.liveMessageId = null;
  }
  const lb = formatLeaderboard(room);
  const caption = [
    `✅ *Round ${room.roundNumber} Complete!*`, ``,
    `🖌 Artist: *${room.drawerName}*`,
    `🎯 Word: *${room.word}*`,
    guesserName ? `🏆 First guess: *${guesserName}*` : `😔 Nobody guessed!`,
    ``, `📊 *Leaderboard:*`, lb,
    ``, `_Next round in 5 seconds..._`
  ].join('\n');
  try {
    await bot.telegram.sendPhoto(room.chatId,
      { source:png, filename:`${room.word}.png` },
      { caption, parse_mode:'Markdown' });
  } catch(e) { console.error('saveFinal send:', e.message); }
}

// ── Round logic ───────────────────────────────────────────────────────────────
function pickDrawer(room) {
  const ids = Array.from(room.clients.keys());
  if (!ids.length) return null;
  // Rotate through queue
  while (room.drawerQueue.length) {
    const next = room.drawerQueue.shift();
    if (room.clients.has(next)) return next;
  }
  // Refill queue (shuffle)
  room.drawerQueue = [...ids].sort(() => Math.random()-0.5);
  return room.drawerQueue.shift();
}

function startRound(room) {
  const ids = Array.from(room.clients.keys());
  if (ids.length < MIN_PLAYERS) {
    bcast(room, { type:'status', message:`Waiting for players… (${ids.length}/${MIN_PLAYERS})` });
    return;
  }

  clearRoundTimers(room);

  room.strokes       = [];
  room.guesses       = new Set();
  room.roundActive   = true;
  room.liveMessageId = null;
  room.roundNumber  += 1;
  room.roundStartTime = Date.now(); // for time-based scoring
  room.currentDrawer = pickDrawer(room);
  room.drawerName    = room.clients.get(room.currentDrawer)?.name || 'Someone';
  room.word          = pickWord();
  room.hintRevealed  = new Array(room.word.length).fill(false);

  console.log(`[round] #${room.roundNumber} START room=${room.id} drawer=${room.drawerName} word=${room.word}`);

  // Send roles
  room.clients.forEach((c,id) => {
    const isDrawer = id === room.currentDrawer;
    c.ws.send(JSON.stringify(isDrawer
      ? { type:'role', role:'drawer', word:room.word, round:room.roundNumber }
      : { type:'role', role:'guesser', hint:buildHint(room.word, room.hintRevealed), round:room.roundNumber }
    ));
  });

  bcast(room, { type:'clear' });
  bcast(room, { type:'status', message:`Round ${room.roundNumber} — ${room.drawerName} is drawing!` });
  bcast(room, { type:'leaderboard', board: getLeaderboard(room) });

  if (room.chatId) {
    bot.telegram.sendMessage(room.chatId,
      `🎮 *Round ${room.roundNumber}!*\n\n✏️ *${room.drawerName}* is drawing...\n💬 Guess here!`,
      { parse_mode:'Markdown' }).catch(()=>{});
  }

  // Round timer
  room.roundTimer = setTimeout(() => endRound(room, null, 'timeout'), ROUND_DURATION_MS);
  // First hint after HINT_INTERVAL_MS
  room.hintTimer = setTimeout(() => revealNextHint(room), HINT_INTERVAL_MS);

  setTimeout(() => pushCanvas(room), 400);
}

function clearRoundTimers(room) {
  if (room.roundTimer)  { clearTimeout(room.roundTimer);  room.roundTimer  = null; }
  if (room.hintTimer)   { clearTimeout(room.hintTimer);   room.hintTimer   = null; }
  if (room.updateTimer) { clearTimeout(room.updateTimer); room.updateTimer = null; }
}

async function endRound(room, guesserName, reason='guess') {
  if (!room.roundActive) return;
  room.roundActive   = false;
  room.currentDrawer = null;
  clearRoundTimers(room);

  console.log(`[round] #${room.roundNumber} END word=${room.word} guesser=${guesserName||'none'} reason=${reason}`);

  bcast(room, { type:'round_end', word:room.word, drawerName:room.drawerName,
                guesser:guesserName||null, reason,
                board: getLeaderboard(room) });

  await saveFinal(room, guesserName);

  setTimeout(() => {
    if (rooms.has(room.id) && room.clients.size >= MIN_PLAYERS) startRound(room);
  }, 5000);
}

function skipWord(room, requesterId) {
  if (!room.roundActive) return false;
  if (requesterId !== room.currentDrawer) return false;
  const newWord = pickWord();
  room.word = newWord;
  room.hintRevealed = new Array(newWord.length).fill(false);
  room.strokes = [];
  if (room.hintTimer) { clearTimeout(room.hintTimer); }
  room.hintTimer = setTimeout(() => revealNextHint(room), HINT_INTERVAL_MS);

  sendTo(room, room.currentDrawer, { type:'role', role:'drawer', word:newWord, round:room.roundNumber });
  bcast(room, { type:'clear' }, room.currentDrawer);
  bcast(room, { type:'word_skipped', hint: buildHint(newWord, room.hintRevealed) }, room.currentDrawer);
  bcast(room, { type:'status', message:`Word skipped! ${room.drawerName} is drawing a new word.` });
  console.log(`[round] Word skipped → ${newWord}`);
  return true;
}

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.command('startgame', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const roomId    = `solo_${ctx.from.id}`;
    const canvasUrl = `${PUBLIC_URL}/?room=${encodeURIComponent(roomId)}`;
    return ctx.reply(`🎨 *Draw & Guess* — Solo mode:`,
      { parse_mode:'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.webApp('🖌 Open Canvas', canvasUrl)]]) });
  }

  const roomId = String(ctx.chat.id);
  const chatId = ctx.chat.id;
  if (!rooms.has(roomId)) rooms.set(roomId, makeRoom(roomId, chatId));
  else rooms.get(roomId).chatId = chatId;

  if (!botUsername) {
    try { const me = await bot.telegram.getMe(); botUsername = me.username; }
    catch(e) { return ctx.reply('Bot still starting, try again.'); }
  }

  const startappLink = `https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}?startapp=${encodeURIComponent(roomId)}`;
  console.log(`[bot] /startgame room=${roomId} link=${startappLink}`);

  await ctx.reply(
    `🎨 *Draw & Guess is ready!*\n\n👇 Tap *🖌 Open Canvas* to draw inside Telegram!\nEveryone else: type your guesses here!`,
    { parse_mode:'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.url('🖌 Open Canvas', startappLink)]]) });
});

bot.command('stopgame', async (ctx) => {
  const roomId = String(ctx.chat.id);
  if (!rooms.has(roomId)) return ctx.reply('No active game.');
  const room = rooms.get(roomId);
  clearRoundTimers(room);
  rooms.delete(roomId);
  ctx.reply('🛑 Game stopped.');
});

bot.command('newround', async (ctx) => {
  const room = rooms.get(String(ctx.chat.id));
  if (!room) return ctx.reply('No game. Use /startgame first.');
  if (!room.clients.size) return ctx.reply('No players connected yet!');
  await endRound(room, null, 'manual');
});

bot.command('skipword', async (ctx) => {
  const room = rooms.get(String(ctx.chat.id));
  if (!room || !room.roundActive) return ctx.reply('No active round.');
  // Any admin can skip from Telegram
  const newWord = pickWord();
  room.word = newWord;
  room.hintRevealed = new Array(newWord.length).fill(false);
  room.strokes = [];
  sendTo(room, room.currentDrawer, { type:'role', role:'drawer', word:newWord, round:room.roundNumber });
  bcast(room, { type:'clear' });
  bcast(room, { type:'status', message:`Word skipped by admin!` });
  ctx.reply(`✅ Word skipped!`);
});

bot.command('leaderboard', async (ctx) => {
  const room = rooms.get(String(ctx.chat.id));
  if (!room) return ctx.reply('No active game.');
  ctx.reply(`📊 *Leaderboard*\n\n${formatLeaderboard(room)}`, { parse_mode:'Markdown' });
});

bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const parts  = ctx.message.text.split(' ');
  const roomId = parts[1] ? decodeURIComponent(parts[1]) : null;
  if (!roomId) return ctx.reply('👋 Add me to a group and use /startgame!');
  if (!rooms.has(roomId)) rooms.set(roomId, makeRoom(roomId, null));
  const canvasUrl = `${PUBLIC_URL}/?room=${encodeURIComponent(roomId)}`;
  await ctx.reply(`🎨 *Draw & Guess* — tap to open:`,
    { parse_mode:'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.webApp('🖌 Open Canvas', canvasUrl)]]) });
});

// Group text = guesses
bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  const room = rooms.get(String(ctx.chat.id));
  if (!room || !room.roundActive || !room.word) return;
  const text = (ctx.message.text||'').trim();
  if (text.startsWith('/')) return;
  const userId   = String(ctx.from.id);
  if (userId === room.currentDrawer) return;
  if (room.guesses.has(userId)) return;
  const name    = [ctx.from.first_name,ctx.from.last_name].filter(Boolean).join(' ')||ctx.from.username||'Player';
  const correct = text.toLowerCase() === room.word.toLowerCase();
  bcast(room, { type:'guess', name, text, correct });
  if (correct) {
    room.guesses.add(userId);
    // Score: 100 - 10 per hint revealed
    const hintsRevealed = room.hintRevealed.filter(Boolean).length;
    const elapsed   = (Date.now() - (room.roundStartTime||Date.now())) / 1000;
    const timeBonus = Math.max(0, Math.floor((ROUND_DURATION_MS/1000 - elapsed) / 10));
    const pts = Math.max(10, 100 - hintsRevealed*10 + timeBonus);
    room.scores.set(name, (room.scores.get(name)||0) + pts);
    room.scores.set(room.drawerName, (room.scores.get(room.drawerName)||0) + 50);
    bcast(room, { type:'score_update', name, pts, timeBonus, board: getLeaderboard(room) });
    await endRound(room, name);
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const url      = new URL(req.url, 'http://localhost');
  const roomId   = url.searchParams.get('room') || 'default';
  const name     = url.searchParams.get('name') || `Player${Math.floor(Math.random()*1000)}`;
  const userId   = url.searchParams.get('userId') || clientId;

  if (!rooms.has(roomId)) rooms.set(roomId, makeRoom(roomId, null));
  const room = rooms.get(roomId);
  room.clients.set(clientId, { ws, name, userId, score: 0 });

  console.log(`[ws] +${name} → room=${roomId} total=${room.clients.size}`);

  // Send full state to new client
  ws.send(JSON.stringify({
    type: 'init',
    strokes:  room.strokes,
    players:  room.clients.size,
    board:    getLeaderboard(room),
    round:    room.roundNumber,
  }));
  bcast(room, { type:'player_joined', name, count:room.clients.size }, clientId);
  bcast(room, { type:'leaderboard', board: getLeaderboard(room) });

  if (!room.roundActive && !room.currentDrawer) {
    if (room.clients.size >= MIN_PLAYERS) startRound(room);
    else ws.send(JSON.stringify({ type:'status', message:`Waiting for players… (${room.clients.size}/${MIN_PLAYERS})` }));
  } else if (room.roundActive) {
    // Late joiner — send current state
    ws.send(JSON.stringify({ type:'role', role:'guesser',
      hint: buildHint(room.word, room.hintRevealed), round: room.roundNumber }));
    ws.send(JSON.stringify({ type:'status', message:`${room.drawerName} is drawing!` }));
  }

  ws.on('message', data => {
    let msg; try { msg=JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'draw':
        if (clientId !== room.currentDrawer) return;
        room.strokes.push(msg.stroke);
        bcast(room, { type:'draw', stroke:msg.stroke }, clientId);
        scheduleUpdate(room);
        break;

      case 'clear':
        if (clientId !== room.currentDrawer) return;
        room.strokes = [];
        bcast(room, { type:'clear' });
        scheduleUpdate(room);
        break;

      case 'snapshot':
        if (clientId !== room.currentDrawer) return;
        bcast(room, { type:'snapshot', data:msg.data }, clientId);
        break;

      case 'skip_word':
        skipWord(room, clientId);
        break;

      case 'guess': {
        if (clientId === room.currentDrawer) return;
        const t  = (msg.text||'').trim();
        if (!t) return;
        const ok = !!room.word && t.toLowerCase()===room.word.toLowerCase();
        bcast(room, { type:'guess', name, text:t, correct:ok });
        if (ok) {
          room.guesses.add(userId);
          const hintsRevealed = room.hintRevealed.filter(Boolean).length;
          const elapsed   = (Date.now() - (room.roundStartTime||Date.now())) / 1000;
          const timeBonus = Math.max(0, Math.floor((ROUND_DURATION_MS/1000 - elapsed) / 10));
          const pts = Math.max(10, 100 - hintsRevealed*10 + timeBonus);
          room.scores.set(name, (room.scores.get(name)||0) + pts);
          room.scores.set(room.drawerName, (room.scores.get(room.drawerName)||0) + 50);
          bcast(room, { type:'score_update', name, pts, timeBonus, board: getLeaderboard(room) });
          endRound(room, name);
        }
        break;
      }

      case 'done_drawing':
        if (clientId !== room.currentDrawer) return;
        endRound(room, null, 'done');
        break;

      case 'new_round':
        // Any player can request a new round after round ends
        if (!room.roundActive && room.clients.size >= MIN_PLAYERS) startRound(room);
        break;
    }
  });

  ws.on('close', () => {
    room.clients.delete(clientId);
    console.log(`[ws] -${name} left room=${roomId} remaining=${room.clients.size}`);
    bcast(room, { type:'player_left', name, count:room.clients.size });
    if (room.currentDrawer === clientId) {
      room.currentDrawer = null;
      if (room.roundActive) {
        room.roundActive = false;
        clearRoundTimers(room);
        bcast(room, { type:'status', message:`${name} (drawer) left. New round soon…` });
      }
      if (room.clients.size >= MIN_PLAYERS) setTimeout(() => startRound(room), 2000);
    }
  });

  ws.on('error', err => { console.error(`[ws] ${name}:`, err.message); ws.close(); });
});

// ── Bot launch — WEBHOOK mode (no polling, no 409 ever) ─────────────────────
//
// WHY WEBHOOK instead of polling:
//   Polling (bot.launch()) causes 409 Conflict on every redeploy because the
//   new container starts before Railway fully kills the old one. Telegram sees
//   two getUpdates requests simultaneously and rejects one with 409.
//
//   Webhook = Telegram PUSHES updates to our URL. No competing connections,
//   no 409, works perfectly with Railway's rolling deploys.
//
// HOW IT WORKS:
//   1. On startup we call setWebhook(PUBLIC_URL/webhook/SECRET)
//   2. Express handles POST /webhook/:secret → bot.handleUpdate()
//   3. On SIGTERM we delete the webhook so the next deploy starts clean
//
// SECRET_TOKEN: random string to prevent unauthorized posts to our webhook URL.
//   Set WEBHOOK_SECRET in Railway env vars (any random string ≥ 16 chars).
//   If not set, we derive one from BOT_TOKEN automatically.
// ─────────────────────────────────────────────────────────────────────────────

// (webhook route moved to top — see route definitions above)

// Call Telegram API directly with raw HTTPS — bypasses any Telegraf wrapper bugs
function telegramPost(method, body) {
  return new Promise((resolve, reject) => {
    const https   = require('https');
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Bad JSON: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function launchBot() {
  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username;

    await bot.telegram.setMyCommands([
      { command:'startgame',   description:'Start Draw & Guess' },
      { command:'stopgame',    description:'Stop the game' },
      { command:'newround',    description:'Skip to next round' },
      { command:'skipword',    description:'Skip current word' },
      { command:'leaderboard', description:'Show scores' },
    ]);

    // Check webhook status — never set or delete it here.
    // Railway overlapping deploys cause race conditions if we touch the webhook.
    // Webhook is registered once manually via browser and stays forever.
    const infoResult = await telegramPost('getWebhookInfo', {});
    const info = infoResult.result || {};
    console.log(`🤖 @${botUsername} ready`);
    console.log(`[bot] webhook="${info.url||'NOT SET'}"`);
    console.log(`[bot] pending=${info.pending_update_count} last_error=${info.last_error_message||'none'}`);
    if (!info.url) {
      console.warn('[bot] ⚠️  Webhook not set — register it manually in your browser:');
      console.warn(`[bot] https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}&allowed_updates=["message","callback_query"]`);
    } else {
      console.log('[bot] ✅ Webhook active');
    }
  } catch(e) {
    console.error('[bot] launchBot error:', e.message);
    setTimeout(launchBot, 5000);
  }
}
server.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
  setTimeout(() => launchBot(), 1000);

  // ── Keep-alive: self-ping every 4 min to prevent Railway sleep ──────────
  // Railway free tier sleeps containers after ~10min of no inbound requests.
  // Pinging our own health endpoint keeps the process alive 24/7.
  if (PUBLIC_URL) {
    setInterval(() => {
      const https = require('https');
      const http2  = require('http');
      const url    = new URL(PUBLIC_URL + '/ping');
      const lib    = url.protocol === 'https:' ? https : http2;
      lib.get(url.toString(), res => {
        console.log(`[keepalive] ping → ${res.statusCode}`);
      }).on('error', e => console.warn('[keepalive] ping failed:', e.message));
    }, 4 * 60 * 1000); // every 4 minutes
    console.log('[keepalive] Self-ping enabled every 4 min');
  }
});

async function gracefulShutdown(signal) {
  // DO NOT delete webhook — Railway starts new instance before killing old one.
  // Deleting webhook on shutdown would break the already-running new instance.
  console.log(`[shutdown] ${signal} — keeping webhook alive for new instance`);
  server.close(() => { console.log('[shutdown] Server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}

process.on('unhandledRejection', reason => {
  console.error('[process] unhandledRejection:', reason?.message || reason);
});
process.on('uncaughtException', err => {
  console.error('[process] uncaughtException:', err.message);
  // Don't exit — Railway will restart if needed
});

process.once('SIGINT',  () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
