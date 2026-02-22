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

if (!BOT_TOKEN)  { console.error('BOT_TOKEN missing'); process.exit(1); }
if (!PUBLIC_URL) { console.error('PUBLIC_URL missing'); process.exit(1); }

console.log(`[config] ALLOW_EXTERNAL_URL=${ALLOW_EXTERNAL_URL} WEBAPP=${WEBAPP_SHORT_NAME} ROUND=${ROUND_DURATION_MS/1000}s`);

// ── Express / WS / Bot ───────────────────────────────────────────────────────
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

// ── Canvas helpers ──────────────────────────────────────────────────────────
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

function plotLine(img, x0,y0,x1,y1, col, r) {
  x0=Math.round(x0); y0=Math.round(y0); x1=Math.round(x1); y1=Math.round(y1);
  const dx=Math.abs(x1-x0), dy=Math.abs(y1-y0);
  const sx=x0<x1?1:-1, sy=y0<y1?1:-1;
  let err=dx-dy;
  for(;;) {
    for(let tx=-r;tx<=r;tx++) for(let ty=-r;ty<=r;ty++)
      if(tx*tx+ty*ty<=r*r && x0+tx>=0 && x0+tx<RENDER_W && y0+ty>=0 && y0+ty<RENDER_H)
        img.setPixelColor(col, x0+tx, y0+ty);
    if(x0===x1 && y0===y1) break;
    const e2=2*err;
    if(e2>-dy){err-=dy;x0+=sx;}
    if(e2<dx ){err+=dx;y0+=sy;}
  }
}

async function renderPNG(strokes, done=false) {
  const img = new Jimp(RENDER_W, RENDER_H, 0xFFFFFFFF);
  for(const s of strokes) {
    const pts = s.points || [];
    if(pts.length<2) continue;
    const col = hexToInt(s.color);
    const r   = Math.max(1, Math.round((s.size||4)*0.9));
    for(let i=1;i<pts.length;i++) plotLine(img, pts[i-1][0]*2, pts[i-1][1]*2, pts[i][0]*2, pts[i][1]*2, col, r*2);
  }
  if(done) for(let x=0;x<RENDER_W;x++) for(let y=RENDER_H-46;y<RENDER_H;y++) img.setPixelColor(0x2dc653FF,x,y);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// ── Word list ───────────────────────────────────────────────────────────────
const WORDS = {
  easy: ['cat','dog','sun','car','fish','bird','moon','tree','house','flower','apple','pizza','smile','heart','star','cake','boat','rain','snow','book'],
  medium: ['guitar','elephant','rainbow','castle','dragon','piano','volcano','butterfly','telescope','snowman','dinosaur','waterfall','helicopter','cactus','penguin','banana','scissors','telephone','umbrella','bicycle'],
  hard: ['submarine','tornado','lighthouse','compass','anchor','mermaid','unicorn','wizard','knight','ninja','pirate','robot','alien','crown','bridge','glasses','rocket'],
};
const ALL_WORDS = [...WORDS.easy, ...WORDS.medium, ...WORDS.hard];
const MIN_PLAYERS = 1;
function pickWord() { return ALL_WORDS[Math.floor(Math.random()*ALL_WORDS.length)]; }

// ── Room state ─────────────────────────────────────────────────────────────
const rooms = new Map();
function makeRoom(id, chatId) {
  return { id, chatId, clients:new Map(), strokes:[], currentDrawer:null, drawerName:'', word:null, hintRevealed:[], guesses:new Set(), roundActive:false, roundTimer:null, hintTimer:null, updateTimer:null, liveMessageId:null, scores:new Map(), roundNumber:0, drawerQueue:[] };
}

// ── Broadcast helpers ───────────────────────────────────────────────────────
function bcast(room,msg,skip=null){const d=JSON.stringify(msg);room.clients.forEach((c,id)=>{if(id!==skip && c.ws.readyState===WebSocket.OPEN)c.ws.send(d);});}
function sendTo(room,clientId,msg){const c=room.clients.get(clientId); if(c && c.ws.readyState===WebSocket.OPEN)c.ws.send(JSON.stringify(msg));}
function buildHint(word,revealed){return word.split('').map((ch,i)=>ch===' '? '':(revealed[i]?ch:'_')).join(' ');}
function getLeaderboard(room){return Array.from(room.scores.entries()).sort((a,b)=>b[1]-a[1]).map(([name,score],i)=>({rank:i+1,name,score}));}

// ── Round logic ─────────────────────────────────────────────────────────────
function clearRoundTimers(room){if(room.roundTimer){clearTimeout(room.roundTimer);room.roundTimer=null;} if(room.hintTimer){clearTimeout(room.hintTimer);room.hintTimer=null;} if(room.updateTimer){clearTimeout(room.updateTimer);room.updateTimer=null;}}
async function endRound(room,guesserName,reason='guess'){if(!room.roundActive)return;room.roundActive=false;room.currentDrawer=null;clearRoundTimers(room);bcast(room,{type:'round_end',word:room.word,drawerName:room.drawerName,guesser:guesserName||null,reason,board:getLeaderboard(room)});}

// ── Bot startup ─────────────────────────────────────────────────────────────
async function launchBot() {
  try {
    await bot.telegram.deleteWebhook({drop_pending_updates:true});
    const me = await bot.telegram.getMe();
    botUsername = me.username;
    console.log(`🤖 @${botUsername} running`);
    await bot.telegram.setMyCommands([
      { command:'startgame',   description:'Start Draw & Guess' },
      { command:'stopgame',    description:'Stop the game' },
      { command:'newround',    description:'Skip to next round' },
      { command:'skipword',    description:'Skip current word' },
      { command:'leaderboard', description:'Show scores' },
    ]);
    bot.launch({ allowedUpdates:['message','callback_query'] });
  } catch(e){console.error('Bot launch failed:',e.message);}
}

// ── Start server safely ──────────────────────────────────────────────────────
server.listen
