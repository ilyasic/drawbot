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

// ── Initialize rooms map ─────────────────────────────────────────────────────
const rooms = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../../client')));

// Health check and general routing
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const isTelegram = /TelegramBot|Telegram/i.test(ua);

  // If request is from Telegram or external allowed, OK
  if (ALLOW_EXTERNAL_URL || isTelegram) {
    return res.send('OK');
  }

  // Health check from Railway / browser (send OK for health check)
  if (/HealthCheck/i.test(ua) || /curl/i.test(ua) || /Mozilla/i.test(ua)) {
    return res.send('OK'); // Always 200 for health check
  }

  // Otherwise block
  res.status(403).send('<h2 style="font-family:sans-serif;padding:2rem">Open inside Telegram only 🎨</h2>');
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
  for (let x=0;x<RENDER_W;x++) for (let y=RENDER_H-46;y<RENDER_H;y++) img.setPixelColor(barCol,x,y);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const url      = new URL(req.url, 'http://localhost');
  const roomId   = url.searchParams.get('room') || 'default';
  const name     = url.searchParams.get('name') || `Player${Math.floor(Math.random()*1000)}`;
  const userId   = url.searchParams.get('userId') || clientId;

  // Make sure the room exists
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { 
      id: roomId,
      clients: new Map(),
      strokes: [],
      currentDrawer: null,
      drawerName: '',
      word: null,
      hintRevealed: [],
      guesses: new Set(),
      roundActive: false,
      roundTimer: null,
      hintTimer: null,
      updateTimer: null,
      liveMessageId: null,
      scores: new Map(),
      roundNumber: 0,
      drawerQueue: [],
    });
  }

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

  // Send game info
  if (!room.roundActive && !room.currentDrawer) {
    if (room.clients.size >= MIN_PLAYERS) startRound(room);
    else ws.send(JSON.stringify({ type:'status', message:`Waiting for players… (${room.clients.size}/${MIN_PLAYERS})` }));
  } else if (room.roundActive) {
    // Late joiner — send current state
    ws.send(JSON.stringify({ type:'role', role:'guesser', 
      hint: buildHint(room.word, room.hintRevealed), round: room.roundNumber }));
    ws.send(JSON.stringify({ type:'status', message:`${room.drawerName} is drawing!` }));
  }

  // Handle WebSocket message events
  ws.on('message', data => {
    let msg; try { msg=JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'draw':
        // Handle drawing updates
        break;

      case 'clear':
        // Clear the canvas
        break;

      // Add your message types for the game here...
    }
  });

  // Handle WebSocket close
  ws.on('close', () => {
    room.clients.delete(clientId);
    console.log(`[ws] -${name} left room=${roomId} remaining=${room.clients.size}`);
  });
});

// ── Bot Commands ─────────────────────────────────────────────────────────────
bot.command('startgame', async (ctx) => {
  // Command to start the game
});

bot.launch({ allowedUpdates:['message','callback_query'] });

server.listen(PORT, () => {
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
});
