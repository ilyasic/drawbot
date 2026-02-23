require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');
const { Telegraf, Markup } = require('telegraf');
const Jimp      = require('jimp');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN         = process.env.BOT_TOKEN;
const PUBLIC_URL        = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT              = process.env.PORT || 3000;
const WEBAPP_SHORT_NAME = process.env.WEBAPP_SHORT_NAME || 'draw1';
const ROUND_DURATION_MS = parseInt(process.env.ROUND_DURATION_MS || '90000');
const HINT_COOLDOWN_MS  = parseInt(process.env.HINT_COOLDOWN_MS  || '30000');
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET || 'tgbot';

if (!BOT_TOKEN)  { console.error('BOT_TOKEN missing');  process.exit(1); }
if (!PUBLIC_URL) { console.error('PUBLIC_URL missing'); process.exit(1); }

console.log(`[config] WEBAPP=${WEBAPP_SHORT_NAME} ROUND=${ROUND_DURATION_MS/1000}s HINT_COOLDOWN=${HINT_COOLDOWN_MS/1000}s`);

// ── Express / WS / Bot ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const bot    = new Telegraf(BOT_TOKEN);
let   botUsername = '';

app.use(express.json());
app.use((req, res, next) => {
  if (req.path !== '/ping') console.log(`[http] ${req.method} ${req.path}`);
  next();
});
app.get('/ping', (_req, res) => res.send('pong'));

// ── Webhook ───────────────────────────────────────────────────────────────────
const WEBHOOK_PATH = `/webhook/${WEBHOOK_SECRET}`;
const WEBHOOK_URL  = `${PUBLIC_URL}${WEBHOOK_PATH}`;

app.post(WEBHOOK_PATH, async (req, res) => {
  // Respond immediately so Telegram never retries the same update
  res.sendStatus(200);
  console.log('[webhook] update:', JSON.stringify(req.body).slice(0, 100));
  try {
    await bot.handleUpdate(req.body);
  } catch(e) {
    console.error('[webhook] error:', e.message);
  }
});
app.get(WEBHOOK_PATH, (_req, res) => res.send('Webhook active ✅'));

// Static client files served last
app.use(express.static(path.join(__dirname, '../../client')));

// ── Word list ─────────────────────────────────────────────────────────────────
const WORDS = [
  'cat','dog','sun','car','fish','bird','moon','tree','house','flower',
  'apple','pizza','smile','heart','star','cake','boat','rain','snow','book',
  'guitar','elephant','rainbow','castle','dragon','piano','volcano','butterfly',
  'telescope','snowman','dinosaur','waterfall','helicopter','cactus','penguin',
  'banana','scissors','telephone','umbrella','bicycle',
  'submarine','tornado','lighthouse','compass','anchor','mermaid','unicorn',
  'wizard','knight','ninja','pirate','robot','alien','crown','bridge',
];
function pickWord() { return WORDS[Math.floor(Math.random() * WORDS.length)]; }

// ── Canvas render (PNG for Telegram chat) ─────────────────────────────────────
const RENDER_W = 1600, RENDER_H = 1000;

function hexToInt(hex) {
  try {
    const c = (hex || '#000').replace('#', '').padEnd(6, '0');
    return Jimp.rgbaToInt(
      parseInt(c.slice(0,2),16),
      parseInt(c.slice(2,4),16),
      parseInt(c.slice(4,6),16),
      255
    );
  } catch { return 0x000000FF; }
}

function plotLine(img, x0, y0, x1, y1, col, r) {
  x0=Math.round(x0); y0=Math.round(y0); x1=Math.round(x1); y1=Math.round(y1);
  const dx=Math.abs(x1-x0), dy=Math.abs(y1-y0);
  const sx=x0<x1?1:-1, sy=y0<y1?1:-1;
  let err=dx-dy;
  for(;;) {
    for(let tx=-r;tx<=r;tx++) for(let ty=-r;ty<=r;ty++) {
      if(tx*tx+ty*ty<=r*r){
        const px=x0+tx, py=y0+ty;
        if(px>=0&&px<RENDER_W&&py>=0&&py<RENDER_H) img.setPixelColor(col,px,py);
      }
    }
    if(x0===x1&&y0===y1) break;
    const e2=2*err;
    if(e2>-dy){err-=dy;x0+=sx;}
    if(e2< dx){err+=dx;y0+=sy;}
  }
}

async function renderPNG(strokes) {
  const img = new Jimp(RENDER_W, RENDER_H, 0xFFFFFFFF);
  for (const s of (strokes||[])) {
    const pts = s.points || [];
    if (pts.length < 2) continue;
    const col = hexToInt(s.color);
    const r   = Math.max(1, Math.round((s.size || 4) * 0.9));
    for (let i=1; i<pts.length; i++) {
      plotLine(img,
        pts[i-1][0]*2, pts[i-1][1]*2,
        pts[i][0]*2,   pts[i][1]*2,
        col, r*2);
    }
  }
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// ── Game state ────────────────────────────────────────────────────────────────
// One game per Telegram group chat
const games = new Map(); // chatId (string) → game object

function makeGame(chatId) {
  return {
    chatId,
    // 'idle' | 'waiting_drawer' | 'drawing' | 'ended'
    phase: 'idle',

    // Drawer info
    drawerTgId:  null,   // Telegram user id (string)
    drawerName:  '',
    drawerWsId:  null,   // WebSocket client id (set when they open Mini App)

    // Round data
    word:             null,
    hintRevealed:     [],
    strokes:          [],
    roundStartTime:   0,
    firstStrokeDrawn: false,  // image hidden until drawer makes first stroke
    lastHintAt:       0,      // timestamp of last hint reveal (for cooldown)

    // Timers
    roundTimer:  null,
    hintTimer:   null,
    updateTimer: null,

    // Telegram message ids
    inviteMessageId: null,
    liveMessageId:   null,

    // Scores: name → pts
    scores: new Map(),

    // WebSocket clients (wsId → { ws, name, tgId })
    clients: new Map(),
  };
}

function getOrMakeGame(chatId) {
  const key = String(chatId);
  if (!games.has(key)) games.set(key, makeGame(key));
  return games.get(key);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastToGame(game, msg, skipWsId=null) {
  const d = JSON.stringify(msg);
  game.clients.forEach((c, id) => {
    if (id !== skipWsId && c.ws.readyState === WebSocket.OPEN) c.ws.send(d);
  });
}

function sendToWs(game, wsId, msg) {
  const c = game.clients.get(wsId);
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

function getLeaderboard(game) {
  return Array.from(game.scores.entries())
    .sort((a,b) => b[1]-a[1])
    .map(([name,score],i) => ({ rank:i+1, name, score }));
}

function fmtLeaderboard(game) {
  const lb = getLeaderboard(game);
  if (!lb.length) return 'No scores yet.';
  const medals = ['🥇','🥈','🥉'];
  return lb.slice(0,10)
    .map(({rank,name,score}) => `${medals[rank-1]||`${rank}.`} *${name}* — ${score} pts`)
    .join('\n');
}

function buildHint(word, revealed) {
  return word.split('').map((ch,i) =>
    ch === ' ' ? '  ' : (revealed[i] ? ch : '_')
  ).join(' ');
}

// ── Hint reveals (manual — triggered by button press) ────────────────────────
function revealNextHint(game) {
  if (game.phase !== 'drawing' || !game.word) return null;
  const unrevealed = game.word.split('').map((_,i)=>i)
    .filter(i => game.word[i] !== ' ' && !game.hintRevealed[i]);
  if (!unrevealed.length) return null;
  const idx = unrevealed[Math.floor(Math.random()*unrevealed.length)];
  game.hintRevealed[idx] = true;
  game.lastHintAt = Date.now();
  const hint = buildHint(game.word, game.hintRevealed);
  broadcastToGame(game, { type:'hint', hint });
  return hint;
}

// ── Live canvas push to Telegram chat ─────────────────────────────────────────
async function pushCanvasToChat(game) {
  if (game.phase !== 'drawing' || !game.word) return;
  let png;
  try { png = await renderPNG(game.strokes); }
  catch(e) { console.error('[render]', e.message); return; }

  const hint    = buildHint(game.word, game.hintRevealed);
  const caption =
    `🎨 *${game.drawerName}* is drawing!\n` +
    `🔤 \`${hint}\`  —  ${game.word.length} letters\n\n` +
    `💬 Type your guess in the chat!`;

  // Hint button — shows cooldown remaining if pressed recently
  const now          = Date.now();
  const cooldownLeft = Math.ceil((HINT_COOLDOWN_MS - (now - game.lastHintAt)) / 1000);
  const hintReady    = cooldownLeft <= 0;
  const hintLabel    = hintReady ? '💡 Hint' : `⏳ Hint (${cooldownLeft}s)`;
  const keyboard     = Markup.inlineKeyboard([[
    Markup.button.callback(hintLabel, `hint:${game.chatId}`),
  ]]);

  try {
    if (!game.liveMessageId) {
      const m = await bot.telegram.sendPhoto(
        game.chatId,
        { source: png, filename: 'drawing.png' },
        { caption, parse_mode:'Markdown', ...keyboard }
      );
      game.liveMessageId = m.message_id;
    } else {
      await bot.telegram.editMessageMedia(
        game.chatId, game.liveMessageId, null,
        { type:'photo', media:{ source:png, filename:'drawing.png' }, caption, parse_mode:'Markdown' },
        keyboard
      );
    }
  } catch(e) {
    if (/not modified/i.test(e.message)) return;
    console.error('[pushCanvas]', e.message);
    if (/not found|deleted|message to edit|socket hang up|ECONNRESET|ETIMEDOUT/i.test(e.message)) game.liveMessageId = null;
  }
}

function scheduleCanvasUpdate(game) {
  // Don't push image until drawer makes first stroke
  if (!game.firstStrokeDrawn) return;
  if (game.updateTimer) return;
  game.updateTimer = setTimeout(async () => {
    game.updateTimer = null;
    await pushCanvasToChat(game);
  }, 1500);
}

// ── End game ──────────────────────────────────────────────────────────────────
async function endGame(game, guesserName, reason) {
  if (game.phase === 'ended' || game.phase === 'idle') return;
  game.phase = 'ended';

  clearTimeout(game.roundTimer);
  clearTimeout(game.hintTimer);
  clearTimeout(game.updateTimer);
  game.roundTimer = game.hintTimer = game.updateTimer = null;

  console.log(`[game] END chatId=${game.chatId} word=${game.word} guesser=${guesserName||'none'} reason=${reason}`);

  // Tell Mini App clients
  broadcastToGame(game, {
    type: 'round_end',
    word: game.word,
    drawerName: game.drawerName,
    guesser: guesserName || null,
    reason,
    board: getLeaderboard(game),
  });

  // Render final image
  let png;
  try { png = await renderPNG(game.strokes); }
  catch(e) { console.error('[endGame render]', e.message); }

  // Delete the live drawing message
  if (game.liveMessageId) {
    try { await bot.telegram.deleteMessage(game.chatId, game.liveMessageId); } catch{}
    game.liveMessageId = null;
  }

  // Build result message
  const lines = [
    `✅ *Game Over!*`,
    ``,
    `🖌 Drawer: *${game.drawerName}*`,
    `🎯 Word: *${game.word}*`,
    guesserName
      ? `🏆 Guessed by: *${guesserName}*`
      : reason === 'timeout'
        ? `⏰ Time's up! Nobody guessed.`
        : `😮 Round ended early.`,
    ``,
    `📊 *Leaderboard:*`,
    fmtLeaderboard(game),
    ``,
    `_Use /startgame to play again!_`,
  ].join('\n');

  try {
    if (png) {
      await bot.telegram.sendPhoto(
        game.chatId,
        { source: png, filename: `${game.word}.png` },
        { caption: lines, parse_mode:'Markdown' }
      );
    } else {
      await bot.telegram.sendMessage(game.chatId, lines, { parse_mode:'Markdown' });
    }
  } catch(e) { console.error('[endGame send]', e.message); }

  // Reset for next game — delay 'idle' by 3s so stray Telegram
  // messages from the just-ended game don't trigger the new one
  game.word             = null;
  game.hintRevealed     = [];
  game.strokes          = [];
  game.firstStrokeDrawn = false;
  game.lastHintAt       = 0;
  game.drawerTgId       = null;
  game.drawerName       = '';
  game.drawerWsId       = null;
  game.inviteMessageId  = null;
  game.liveMessageId    = null;
  setTimeout(() => { game.phase = 'idle'; }, 3000);
}

// ── Bot commands ──────────────────────────────────────────────────────────────

bot.command('startgame', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply('➕ Add me to a group and use /startgame there!');
  }

  const chatId = String(ctx.chat.id);
  const game   = getOrMakeGame(chatId);

  if (game.phase === 'waiting_drawer') {
    return ctx.reply('⏳ Already waiting for someone to press "I Want to Draw"!');
  }
  if (game.phase === 'drawing') {
    return ctx.reply('🎨 A game is already in progress! Type your guess in the chat.');
  }

  // Fresh game
  game.phase       = 'waiting_drawer';
  game.scores      = new Map();
  game.strokes     = [];
  game.word        = null;
  game.drawerTgId  = null;
  game.drawerName  = '';
  game.drawerWsId  = null;
  game.liveMessageId = null;

  if (!botUsername) {
    try { const me = await bot.telegram.getMe(); botUsername = me.username; }
    catch(e) { return ctx.reply('Bot still starting, try again in a moment.'); }
  }

  const msg = await ctx.reply(
    `🎨 *Draw & Guess!*\n\nWho wants to draw this round?\nPress the button below! ✏️`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('✏️ I Want to Draw!', `claim_draw:${chatId}`),
      ]]),
    }
  );
  game.inviteMessageId = msg.message_id;
  console.log(`[bot] /startgame chatId=${chatId} — waiting for drawer`);
});

bot.command('stopgame', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const game   = games.get(chatId);
  if (!game || game.phase === 'idle') return ctx.reply('No active game.');
  await endGame(game, null, 'stopped');
  ctx.reply('🛑 Game stopped.');
});

bot.command('skipword', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const game   = games.get(chatId);
  if (!game || game.phase !== 'drawing') return ctx.reply('No active round.');
  const newWord = pickWord();
  game.word             = newWord;
  game.hintRevealed     = new Array(newWord.length).fill(false);
  game.strokes          = [];
  game.firstStrokeDrawn = false;
  game.lastHintAt       = 0;
  clearTimeout(game.hintTimer);
  game.hintTimer = null;
  if (game.drawerWsId) sendToWs(game, game.drawerWsId, { type:'role', role:'drawer', word:newWord, round:1 });
  broadcastToGame(game, { type:'clear' }, game.drawerWsId);
  broadcastToGame(game, { type:'word_skipped', hint:buildHint(newWord, game.hintRevealed) }, game.drawerWsId);
  ctx.reply('✅ Word skipped!');
});

bot.command('leaderboard', async (ctx) => {
  const game = games.get(String(ctx.chat.id));
  if (!game) return ctx.reply('No game. Use /startgame.');
  ctx.reply(`📊 *Leaderboard*\n\n${fmtLeaderboard(game)}`, { parse_mode:'Markdown' });
});

// ── Callback: "I Want to Draw" button ────────────────────────────────────────
bot.action(/^claim_draw:(.+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const game   = games.get(chatId);

  if (!game) {
    return ctx.answerCbQuery('❌ No active game. Use /startgame.', { show_alert:true });
  }
  if (game.phase !== 'waiting_drawer') {
    return ctx.answerCbQuery('❌ A drawer already claimed this round!', { show_alert:true });
  }

  const tgId   = String(ctx.from.id);
  const fname  = ctx.from.first_name || '';
  const lname  = ctx.from.last_name  || '';
  const uname  = `${fname} ${lname}`.trim() || ctx.from.username || 'Artist';

  game.drawerTgId     = tgId;
  game.drawerName     = uname;
  game.phase          = 'drawing';
  game.word           = pickWord();
  game.hintRevealed   = new Array(game.word.length).fill(false);
  game.strokes        = [];
  game.roundStartTime = Date.now();

  console.log(`[game] Drawer: ${uname} (${tgId}), word=${game.word}, chatId=${chatId}`);

  await ctx.answerCbQuery('✅ You are the drawer! Open your canvas.', { show_alert:false });

  // Update invite message — remove the button, show who is drawing
  try {
    await bot.telegram.editMessageText(
      chatId, game.inviteMessageId, null,
      `🎨 *${uname}* is drawing!\n🔤 \`${buildHint(game.word, game.hintRevealed)}\`  —  ${game.word.length} letters\n\n💬 Type your guess in the chat!`,
      { parse_mode:'Markdown' }
    );
  } catch(e) { console.error('[editInvite]', e.message); }

  // Build Mini App canvas URL — encodes chatId + tgId + name so frontend knows the room and role
  const startappParam = encodeURIComponent(`${chatId}__${tgId}__${uname}`);
  const canvasUrl     = `https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}?startapp=${startappParam}`;

  // Post canvas button in group so the drawer (and only they need to) can open it
  await bot.telegram.sendMessage(
    chatId,
    `✏️ *${uname}*, tap below to open your canvas!`,
    {
      parse_mode:'Markdown',
      ...Markup.inlineKeyboard([[
        Markup.button.url('🖌 Open Canvas to Draw', canvasUrl),
      ]]),
    }
  ).catch(e => console.error('[sendCanvasBtn]', e.message));

  // Timer starts on first stroke — not here
  // Do NOT push canvas yet — wait for first stroke
  console.log(`[game] Waiting for first stroke before showing image in chat`);
});

// ── Hint button handler ───────────────────────────────────────────────────────
bot.action(/^hint:(.+)$/, async (ctx) => {
  const chatId = ctx.match[1];
  const game   = games.get(chatId);

  if (!game || game.phase !== 'drawing') {
    return ctx.answerCbQuery('❌ No active game!', { show_alert:false });
  }
  if (!game.firstStrokeDrawn) {
    return ctx.answerCbQuery('⏳ Wait for the drawer to start!', { show_alert:false });
  }

  // Check cooldown
  const now          = Date.now();
  const cooldownLeft = Math.ceil((HINT_COOLDOWN_MS - (now - game.lastHintAt)) / 1000);
  if (cooldownLeft > 0) {
    return ctx.answerCbQuery(`⏳ Wait ${cooldownLeft}s before next hint!`, { show_alert:false });
  }

  // Check if all letters already revealed
  const unrevealed = game.word.split('').filter((c,i) => c !== ' ' && !game.hintRevealed[i]);
  if (!unrevealed.length) {
    return ctx.answerCbQuery('🤷 No more hints available!', { show_alert:false });
  }

  const hint = revealNextHint(game);
  if (!hint) return ctx.answerCbQuery('No hints left!', { show_alert:false });

  const presserName = ctx.from.first_name || ctx.from.username || 'Someone';
  console.log(`[hint] ${presserName} requested hint → ${hint}`);

  await ctx.answerCbQuery(`💡 Hint revealed!`, { show_alert:false });

  // Update the live image caption with new hint + updated button
  await pushCanvasToChat(game);
});

// ── Telegram text = guesses ───────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  if (ctx.chat.type === 'private') return;

  const chatId = String(ctx.chat.id);
  const game   = games.get(chatId);
  if (!game || game.phase !== 'drawing' || !game.word) return;

  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;

  const tgId  = String(ctx.from.id);
  const fname = ctx.from.first_name || '';
  const lname = ctx.from.last_name  || '';
  const name  = `${fname} ${lname}`.trim() || ctx.from.username || 'Player';

  // Drawer cannot guess their own word
  if (tgId === game.drawerTgId) return;

  const correct = text.toLowerCase() === game.word.toLowerCase();

  // Send guess to Mini App watchers
  broadcastToGame(game, { type:'guess', name, text, correct });

  if (correct) {
    console.log(`[game] Correct! "${text}" by ${name}`);

    const hintsGiven = game.hintRevealed.filter(Boolean).length;
    const elapsed    = (Date.now() - game.roundStartTime) / 1000;
    const timeBonus  = Math.max(0, Math.floor((ROUND_DURATION_MS/1000 - elapsed) / 10));
    const pts        = Math.max(10, 100 - hintsGiven*10 + timeBonus);

    game.scores.set(name,           (game.scores.get(name)           || 0) + pts);
    game.scores.set(game.drawerName,(game.scores.get(game.drawerName)|| 0) + 50);

    broadcastToGame(game, {
      type: 'score_update', name, pts, timeBonus, board: getLeaderboard(game),
    });

    try {
      await bot.telegram.sendMessage(
        chatId,
        `🎉 *${name}* guessed it!\nThe word was *${game.word}* ✅  +${pts} pts${timeBonus?` ⚡ +${timeBonus} time bonus`:''}`,
        { parse_mode:'Markdown' }
      );
    } catch{}

    await endGame(game, name, 'guess');
  }
});

// ── WebSocket — Mini App ──────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const wsId = uuidv4();
  const url  = new URL(req.url, 'http://localhost');

  // Frontend sends: ?room=CHATID&name=NAME&userId=TGID
  const chatId = url.searchParams.get('room') || '';
  const name   = url.searchParams.get('name') || 'Artist';
  const tgId   = url.searchParams.get('userId') || '';

  if (!chatId) { ws.close(); return; }

  const game = getOrMakeGame(chatId);

  // ── Ghost game fix: only assign drawer role if game is actively drawing ──
  const isDrawer = tgId && tgId === game.drawerTgId && game.phase === 'drawing';

  // ── Duplicate connection fix: if drawer reconnects, close old WS first ──
  if (isDrawer && game.drawerWsId) {
    const old = game.clients.get(game.drawerWsId);
    if (old && old.ws.readyState === WebSocket.OPEN) {
      console.log(`[ws] Closing duplicate drawer WS for ${name}`);
      old.ws.close();
    }
    game.clients.delete(game.drawerWsId);
    game.drawerWsId = null;
  }

  game.clients.set(wsId, { ws, name, tgId });
  console.log(`[ws] +${name} tgId=${tgId} chatId=${chatId} clients=${game.clients.size}`);

  if (isDrawer) {
    game.drawerWsId = wsId;
    ws.send(JSON.stringify({ type:'role', role:'drawer', word:game.word, round:1 }));
    console.log(`[ws] ${name} = DRAWER, word=${game.word}`);
  } else {
    // Watcher/guesser — send current state
    ws.send(JSON.stringify({
      type: 'init',
      strokes:  game.strokes,
      players:  game.clients.size,
      board:    getLeaderboard(game),
    }));
    if (game.phase === 'drawing') {
      ws.send(JSON.stringify({
        type: 'role', role: 'guesser',
        hint: buildHint(game.word, game.hintRevealed),
        round: 1,
      }));
      ws.send(JSON.stringify({
        type: 'status',
        message: `${game.drawerName} is drawing! Guess in the Telegram chat!`,
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'status',
        message: 'No game running. Use /startgame in the group!',
      }));
    }
  }

  broadcastToGame(game, { type:'player_joined', name, count:game.clients.size }, wsId);

  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {

      case 'draw':
        if (wsId !== game.drawerWsId) return;
        game.strokes.push(msg.stroke);
        broadcastToGame(game, { type:'draw', stroke:msg.stroke }, wsId);
        // First stroke — start timer + reveal image in chat
        if (!game.firstStrokeDrawn) {
          game.firstStrokeDrawn = true;
          game.roundStartTime   = Date.now();
          game.roundTimer       = setTimeout(() => endGame(game, null, 'timeout'), ROUND_DURATION_MS);
          console.log(`[game] First stroke by ${name} — timer started, revealing canvas in chat`);
          setTimeout(() => pushCanvasToChat(game), 500);
        } else {
          scheduleCanvasUpdate(game);
        }
        break;

      case 'clear':
        if (wsId !== game.drawerWsId) return;
        game.strokes = [];
        game.firstStrokeDrawn = false; // hide image until next stroke
        broadcastToGame(game, { type:'clear' });
        break;

      case 'snapshot':
        if (wsId !== game.drawerWsId) return;
        broadcastToGame(game, { type:'snapshot', data:msg.data }, wsId);
        break;

      // Guess from Mini App chat panel (mirrors Telegram guesses)
      case 'guess': {
        if (wsId === game.drawerWsId) return;
        const t = (msg.text||'').trim(); if (!t) return;
        const ok = game.word && t.toLowerCase() === game.word.toLowerCase();
        broadcastToGame(game, { type:'guess', name, text:t, correct:ok });
        if (ok) {
          const hintsGiven = game.hintRevealed.filter(Boolean).length;
          const elapsed    = (Date.now() - game.roundStartTime) / 1000;
          const timeBonus  = Math.max(0, Math.floor((ROUND_DURATION_MS/1000 - elapsed) / 10));
          const pts        = Math.max(10, 100 - hintsGiven*10 + timeBonus);
          game.scores.set(name,           (game.scores.get(name)||0) + pts);
          game.scores.set(game.drawerName,(game.scores.get(game.drawerName)||0) + 50);
          broadcastToGame(game, { type:'score_update', name, pts, timeBonus, board:getLeaderboard(game) });
          bot.telegram.sendMessage(
            game.chatId,
            `🎉 *${name}* guessed it! The word was *${game.word}* ✅  +${pts} pts`,
            { parse_mode:'Markdown' }
          ).catch(()=>{});
          endGame(game, name, 'guess');
        }
        break;
      }

      case 'done_drawing':
        if (wsId !== game.drawerWsId) return;
        endGame(game, null, 'done');
        break;

      case 'skip_word':
        if (wsId !== game.drawerWsId) return;
        {
          const nw = pickWord();
          game.word             = nw;
          game.hintRevealed     = new Array(nw.length).fill(false);
          game.strokes          = [];
          game.firstStrokeDrawn = false; // hide image until drawer starts new word
          game.lastHintAt       = 0;
          clearTimeout(game.roundTimer); // timer restarts on next first stroke
          clearTimeout(game.hintTimer);
          game.roundTimer = null;
          game.hintTimer  = null;
          sendToWs(game, wsId, { type:'role', role:'drawer', word:nw, round:1 });
          broadcastToGame(game, { type:'clear' }, wsId);
          broadcastToGame(game, { type:'word_skipped', hint:buildHint(nw,game.hintRevealed) }, wsId);
        }
        break;

      case 'get_logs':
        ws.send(JSON.stringify({ type:'logs', logs:[] }));
        break;
    }
  });

  ws.on('close', () => {
    game.clients.delete(wsId);
    console.log(`[ws] -${name} left chatId=${chatId} remaining=${game.clients.size}`);
    broadcastToGame(game, { type:'player_left', name, count:game.clients.size });
    if (wsId === game.drawerWsId) {
      game.drawerWsId = null;
      console.log(`[ws] Drawer closed Mini App (game still running)`);
    }
  });

  ws.on('error', err => { console.error(`[ws] ${name}:`, err.message); ws.close(); });
});

// ── Bot launch (webhook mode) ─────────────────────────────────────────────────
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
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

async function launchBot() {
  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username;
    console.log(`🤖 @${botUsername} ready`);

    await bot.telegram.setMyCommands([
      { command:'startgame',   description:'Start a new Draw & Guess game' },
      { command:'stopgame',    description:'Stop the current game' },
      { command:'skipword',    description:'Skip current word' },
      { command:'leaderboard', description:'Show scores' },
    ]);

    const info = (await telegramPost('getWebhookInfo', {})).result || {};
    if (info.url === WEBHOOK_URL) {
      console.log('[bot] ✅ Webhook already active');
    } else {
      const r = await telegramPost('setWebhook', {
        url: WEBHOOK_URL,
        drop_pending_updates: true,
        allowed_updates: ['message','callback_query'],
      });
      console.log('[bot] setWebhook:', r.description || JSON.stringify(r));
    }
  } catch(e) {
    console.error('[bot] launchBot error:', e.message);
    setTimeout(launchBot, 5000);
  }
}

server.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
  setTimeout(launchBot, 1000);

  // Keep-alive ping every 4 min (prevents Railway sleep)
  if (PUBLIC_URL) {
    setInterval(() => {
      const mod = PUBLIC_URL.startsWith('https') ? require('https') : require('http');
      mod.get(`${PUBLIC_URL}/ping`, r => console.log(`[keepalive] ${r.statusCode}`))
         .on('error', e => console.warn('[keepalive]', e.message));
    }, 4 * 60 * 1000);
  }
});

process.on('unhandledRejection', r => console.error('[unhandledRejection]', r?.message||r));
process.on('uncaughtException',  e => console.error('[uncaughtException]', e.message));
process.once('SIGINT',  () => { server.close(); process.exit(0); });
process.once('SIGTERM', () => { server.close(); process.exit(0); });
