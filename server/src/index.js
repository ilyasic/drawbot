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
app.use(express.static(path.join(__dirname, '../../client')));

app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const isTelegram = /TelegramBot|Telegram/i.test(ua);
  if (!ALLOW_EXTERNAL_URL && !isTelegram && /text\/html/i.test(req.headers['accept'] || '')) {
    return res.status(403).send('<h2 style="font-family:sans-serif;padding:2rem">Open inside Telegram only 🎨</h2>');
  }
  res.send('OK');
});

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
    const pts = Math.max(10, 100 - hintsRevealed*10);
    room.scores.set(name, (room.scores.get(name)||0) + pts);
    // Drawer gets points too
    const drawerPts = 50;
    room.scores.set(room.drawerName, (room.scores.get(room.drawerName)||0) + drawerPts);
    bcast(room, { type:'score_update', name, pts, board: getLeaderboard(room) });
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
          const pts = Math.max(10, 100 - hintsRevealed*10);
          room.scores.set(name, (room.scores.get(name)||0) + pts);
          room.scores.set(room.drawerName, (room.scores.get(room.drawerName)||0) + 50);
          bcast(room, { type:'score_update', name, pts, board: getLeaderboard(room) });
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

// ── Bot launch ────────────────────────────────────────────────────────────────
let botRestartTimer = null;
function stopBot() { try { bot.stop(); } catch {} }

async function launchBot(retryCount=0) {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates:true });
    console.log('[bot] Webhook cleared');
    const me = await bot.telegram.getMe();
    botUsername = me.username;
    await bot.telegram.setMyCommands([
      { command:'startgame',   description:'Start Draw & Guess' },
      { command:'stopgame',    description:'Stop the game' },
      { command:'newround',    description:'Skip to next round' },
      { command:'skipword',    description:'Skip current word' },
      { command:'leaderboard', description:'Show scores' },
    ]);
    bot.launch({ allowedUpdates:['message','callback_query'] })
      .catch(e => {
        if (e.response?.error_code===409) { console.warn('[bot] 409 from loop'); handle409(retryCount); }
        else console.error('[bot] polling error:', e.message);
      });
    console.log(`🤖 @${botUsername} running`);
  } catch(e) {
    if (e.response?.error_code===409) handle409(retryCount);
    else console.error('[bot] launch error:', e.message);
  }
}

function handle409(retryCount) {
  if (botRestartTimer) return;
  if (retryCount >= 5) { console.error('[bot] giving up after 5 retries'); return; }
  const delay = Math.min(3000 * Math.pow(2, retryCount), 30000);
  console.warn(`[bot] retry in ${delay/1000}s (${retryCount+1}/5)`);
  stopBot();
  botRestartTimer = setTimeout(() => { botRestartTimer=null; launchBot(retryCount+1); }, delay);
}

process.on('unhandledRejection', reason => {
  if (reason?.response?.error_code===409) handle409(0);
  else console.error('[process] unhandledRejection:', reason?.message||reason);
});
process.on('uncaughtException', err => {
  if (err?.response?.error_code===409) handle409(0);
  else { console.error('[process] uncaughtException:', err.message); process.exit(1); }
});

server.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
  setTimeout(() => launchBot(), 1000);
});

process.once('SIGINT',  () => { stopBot(); server.close(); });
process.once('SIGTERM', () => { stopBot(); server.close(); });
