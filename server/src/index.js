require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const { Telegraf, Markup } = require('telegraf');
const Jimp       = require('jimp');

// ── Config ─────────────────────────────────────────────
const BOT_TOKEN         = process.env.BOT_TOKEN;
const PUBLIC_URL        = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT              = process.env.PORT || 3000;
const ALLOW_EXTERNAL_URL = process.env.ALLOW_EXTERNAL_URL === 'true';
const WEBAPP_SHORT_NAME  = process.env.WEBAPP_SHORT_NAME || 'draw1';
const ROUND_DURATION_MS  = parseInt(process.env.ROUND_DURATION_MS || '90000'); // 90s
const HINT_INTERVAL_MS   = parseInt(process.env.HINT_INTERVAL_MS  || '20000'); // 20s

if (!BOT_TOKEN || !PUBLIC_URL) { console.error('BOT_TOKEN or PUBLIC_URL missing'); process.exit(1); }

console.log(`[config] ALLOW_EXTERNAL_URL=${ALLOW_EXTERNAL_URL} WEBAPP=${WEBAPP_SHORT_NAME} ROUND=${ROUND_DURATION_MS/1000}s`);

// ── Express / WS / Bot ───────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const bot    = new Telegraf(BOT_TOKEN);
let botUsername = '';

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

// ── Canvas rendering ───────────────────────────────
const RENDER_W = 1600, RENDER_H = 1000;

function hexToInt(hex) {
  try {
    const c = (hex || '#000').replace('#','').padEnd(6,'0');
    return Jimp.rgbaToInt(
      parseInt(c.slice(0,2),16),
      parseInt(c.slice(2,4),16),
      parseInt(c.slice(4,6),16),
      255
    );
  } catch { return 0x000000FF; }
}

function plotLine(img, x0,y0,x1,y1,col,r) {
  x0=Math.round(x0); y0=Math.round(y0); x1=Math.round(x1); y1=Math.round(y1);
  const dx=Math.abs(x1-x0), dy=Math.abs(y1-y0);
  const sx=x0<x1?1:-1, sy=y0<y1?1:-1;
  let err=dx-dy;
  for(;;){
    for(let tx=-r;tx<=r;tx++) for(let ty=-r;ty<=r;ty++) {
      if(tx*tx+ty*ty<=r*r){
        const px=x0+tx,py=y0+ty;
        if(px>=0&&px<RENDER_W&&py>=0&&py<RENDER_H) img.setPixelColor(col,px,py);
      }
    }
    if(x0===x1 && y0===y1) break;
    const e2=2*err;
    if(e2>-dy){err-=dy;x0+=sx;}
    if(e2<dx){err+=dx;y0+=sy;}
  }
}

async function renderPNG(strokes, done) {
  const img = new Jimp(RENDER_W, RENDER_H, 0xFFFFFFFF);
  for(const s of strokes){
    const pts = s.points||[];
    if(pts.length<2) continue;
    const col = hexToInt(s.color);
    const r   = Math.max(1, Math.round((s.size||4)*0.9));
    for(let i=1;i<pts.length;i++)
      plotLine(img, pts[i-1][0]*2, pts[i-1][1]*2, pts[i][0]*2, pts[i][1]*2, col, r*2);
  }
  const barCol = done ? 0x2dc653FF : 0x1a1a2eFF;
  for(let x=0;x<RENDER_W;x++) for(let y=RENDER_H-46;y<RENDER_H;y++) img.setPixelColor(barCol,x,y);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// ── Word list ───────────────────────────────
const WORDS = {
  easy: ['cat','dog','sun','car','fish','bird','moon','tree','house','flower','apple','pizza','smile','heart','star','cake','boat','rain','snow','book'],
  medium: ['guitar','elephant','rainbow','castle','dragon','piano','volcano','butterfly','telescope','snowman','dinosaur','waterfall','helicopter','cactus','penguin','banana','scissors','telephone','umbrella','bicycle'],
  hard: ['submarine','tornado','lighthouse','compass','anchor','mermaid','unicorn','wizard','knight','ninja','pirate','robot','alien','crown','bridge','glasses','rocket']
};
const ALL_WORDS = [...WORDS.easy,...WORDS.medium,...WORDS.hard];
function pickWord(){ return ALL_WORDS[Math.floor(Math.random()*ALL_WORDS.length)]; }

// ── State ───────────────────────────────
const rooms = new Map();
const MIN_PLAYERS = 1;

function makeRoom(id, chatId){
  return {
    id, chatId,
    clients:new Map(),
    strokes:[],
    currentDrawer:null,
    drawerName:'',
    word:null,
    hintRevealed:[],
    guesses:new Set(),
    roundActive:false,
    roundTimer:null,
    hintTimer:null,
    updateTimer:null,
    liveMessageId:null,
    scores:new Map(),
    roundNumber:0,
    drawerQueue:[]
  };
}

function bcast(room,msg,skip=null){
  const d=JSON.stringify(msg);
  room.clients.forEach((c,id)=>{ if(id!==skip && c.ws.readyState===WebSocket.OPEN) c.ws.send(d); });
}

function sendTo(room,clientId,msg){
  const c = room.clients.get(clientId);
  if(c && c.ws.readyState===WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

// ── Hints ───────────────────────────────
function buildHint(word,revealed){
  return word.split('').map((ch,i)=> ch===' ' ? ' ' : (revealed[i]?ch:'_')).join(' ');
}

function revealNextHint(room){
  if(!room.word || !room.roundActive) return;
  const unrevealed = room.word.split('').map((_,i)=>i).filter(i=>room.word[i]!==' ' && !room.hintRevealed[i]);
  if(!unrevealed.length) return;
  const idx = unrevealed[Math.floor(Math.random()*unrevealed.length)];
  room.hintRevealed[idx] = true;
  bcast(room,{type:'hint',hint:buildHint(room.word,room.hintRevealed)});
  room.hintTimer = setTimeout(()=>revealNextHint(room), HINT_INTERVAL_MS);
}

// ── Leaderboard ───────────────────────────────
function getLeaderboard(room){
  return Array.from(room.scores.entries())
    .sort((a,b)=>b[1]-a[1])
    .map(([name,score],i)=>({rank:i+1,name,score}));
}

// ── Canvas push ───────────────────────────────
async function pushCanvas(room){
  if(!room.chatId || !room.roundActive || !room.word) return;
  try{
    const png = await renderPNG(room.strokes,false);
    const hint = buildHint(room.word,room.hintRevealed);
    const caption = `🎨 *${room.drawerName}* is drawing!\n🔤 \`${hint}\`\n💬 Guess in chat!`;
    const canvasUrl = `${PUBLIC_URL}/?room=${encodeURIComponent(room.id)}`;

    if(!room.liveMessageId){
      const m = await bot.telegram.sendPhoto(room.chatId,
        { source:png, filename:'drawing.png' },
        { caption, parse_mode:'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.url('🖌 Open Canvas',canvasUrl)]]) });
      room.liveMessageId = m.message_id;
    } else {
      await bot.telegram.editMessageMedia(room.chatId,room.liveMessageId,null,
        { type:'photo', media:{source:png,filename:'drawing.png'}, caption, parse_mode:'Markdown' });
    }
  } catch(e){ console.error('pushCanvas:',e.message); if(/not found|deleted/.test(e.message)) room.liveMessageId=null; }
}

function scheduleUpdate(room){
  if(room.updateTimer) return;
  room.updateTimer = setTimeout(()=>{room.updateTimer=null; pushCanvas(room);},1500);
}

// ── Round logic ───────────────────────────────
function clearRoundTimers(room){
  if(room.roundTimer){clearTimeout(room.roundTimer);room.roundTimer=null;}
  if(room.hintTimer){clearTimeout(room.hintTimer);room.hintTimer=null;}
  if(room.updateTimer){clearTimeout(room.updateTimer);room.updateTimer=null;}
}

function pickDrawer(room){
  const ids = Array.from(room.clients.keys());
  if(!ids.length) return null;
  while(room.drawerQueue.length){
    const next = room.drawerQueue.shift();
    if(room.clients.has(next)) return next;
  }
  room.drawerQueue = [...ids].sort(()=>Math.random()-0.5);
  return room.drawerQueue.shift();
}

function startRound(room){
  if(room.clients.size<MIN_PLAYERS){bcast(room,{type:'status',message:`Waiting for players (${room.clients.size}/${MIN_PLAYERS})`}); return;}

  clearRoundTimers(room);

  room.strokes=[];
  room.guesses=new Set();
  room.roundActive=true;
  room.liveMessageId=null;
  room.roundNumber+=1;
  room.currentDrawer=pickDrawer(room);
  room.drawerName=room.clients.get(room.currentDrawer)?.name||'Someone';
  room.word=pickWord();
  room.hintRevealed=new Array(room.word.length).fill(false);

  room.clients.forEach((c,id)=>{
    const isDrawer = id===room.currentDrawer;
    c.ws.send(JSON.stringify(isDrawer?{type:'role',role:'drawer',word:room.word,round:room.roundNumber}:{type:'role',role:'guesser',hint:buildHint(room.word,room.hintRevealed),round:room.roundNumber}));
  });

  bcast(room,{type:'clear'});
  bcast(room,{type:'status',message:`Round ${room.roundNumber} — ${room.drawerName} is drawing!`});
  bcast(room,{type:'leaderboard',board:getLeaderboard(room)});

  room.roundTimer = setTimeout(()=>endRound(room,null,'timeout'),ROUND_DURATION_MS);
  room.hintTimer = setTimeout(()=>revealNextHint(room),HINT_INTERVAL_MS);
  setTimeout(()=>pushCanvas(room),400);
}

async function endRound(room,guesserName,reason='guess'){
  if(!room.roundActive) return;
  room.roundActive=false;
  room.currentDrawer=null;
  clearRoundTimers(room);

  bcast(room,{type:'round_end',word:room.word,drawerName:room.drawerName,guesser:guesserName||null,reason,board:getLeaderboard(room)});
  try{
    const png = await renderPNG(room.strokes,true);
    if(room.liveMessageId){await bot.telegram.deleteMessage(room.chatId,room.liveMessageId).catch(()=>{});room.liveMessageId=null;}
    const lb = getLeaderboard(room).map((x,i)=>`${i+1}. ${x.name} — ${x.score} pts`).join('\n');
    const caption = `✅ *Round ${room.roundNumber} Complete!*\n🖌 Artist: *${room.drawerName}*\n🎯 Word: *${room.word}*\n${guesserName?`🏆 First guess: *${guesserName}*`:'😔 Nobody guessed!'}\n📊 Leaderboard:\n${lb}\n\n_Next round in 5s..._`;
    await bot.telegram.sendPhoto(room.chatId,{source:png,filename:`${room.word}.png`},{caption,parse_mode:'Markdown'});
  } catch(e){ console.error('endRound sendFinal:',e.message); }

  setTimeout(()=>{if(rooms.has(room.id) && room.clients.size>=MIN_PLAYERS) startRound(room);},5000);
}

// WebSocket connections, message handling, bot launch code remains mostly same
// ... (for brevity, you can keep WS code from original, just replace round logic with above fixed functions)

server.listen(PORT,()=>{console.log(`✅ http://localhost:${PORT} | 📡 ${PUBLIC_URL}`);setTimeout(()=>launchBot(),1000);});
