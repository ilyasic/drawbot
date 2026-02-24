require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');
const { Telegraf, Markup } = require('telegraf');
const { createCanvas } = require('@napi-rs/canvas');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN         = process.env.BOT_TOKEN;
const PUBLIC_URL        = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT              = process.env.PORT || 3000;
const WEBAPP_SHORT_NAME = process.env.WEBAPP_SHORT_NAME || 'draw1';
const HINT_COOLDOWN_MS  = parseInt(process.env.HINT_COOLDOWN_MS  || '30000');
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET || 'tgbot';

if (!BOT_TOKEN)  { console.error('BOT_TOKEN missing');  process.exit(1); }
if (!PUBLIC_URL) { console.error('PUBLIC_URL missing'); process.exit(1); }

console.log(`[config] WEBAPP=${WEBAPP_SHORT_NAME} HINT_COOLDOWN=${HINT_COOLDOWN_MS/1000}s`);

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
  res.sendStatus(200);
  console.log('[webhook] update:', JSON.stringify(req.body).slice(0, 100));
  try { await bot.handleUpdate(req.body); }
  catch(e) { console.error('[webhook] error:', e.message); }
});
app.get(WEBHOOK_PATH, (_req, res) => res.send('Webhook active ✅'));

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

// ── DETERMINISTIC PRNG (mulberry32) ──────────────────────────────────────────
// CRITICAL: IDENTICAL to client-side makePRNG — same seed = same pixels
// This is the key fix: random brushes now produce exact same output on
// server as what the artist drew on their canvas
function makePRNG(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Canvas render (PNG for Telegram) ─────────────────────────────────────────
const CANVAS_W = 800, CANVAS_H = 500;

const BRUSH_DEFAULTS = {
  pen:       { smoothing:.5,  alpha:1.0,  widthMult:1.0,  cap:'round',  pressure:true,  flow:.8 },
  pencil:    { smoothing:.3,  alpha:.75,  widthMult:.8,   cap:'round',  pressure:true,  flow:.7 },
  marker:    { smoothing:.6,  alpha:.55,  widthMult:1.6,  cap:'round',  pressure:false, flow:.9 },
  bristle:   { smoothing:.2,  alpha:.5,   widthMult:1.0,  cap:'round',  pressure:true,  flow:.6 },
  flat:      { smoothing:.4,  alpha:1.0,  widthMult:2.5,  cap:'square', pressure:false, flow:1.0},
  eraser:    { smoothing:.5,  alpha:1.0,  widthMult:1.0,  cap:'round',  pressure:false, flow:1.0},
  airbrush:  { smoothing:.0,  alpha:.06,  widthMult:1.0,  cap:'round',  pressure:false, flow:.7 },
  ink:       { smoothing:.7,  alpha:1.0,  widthMult:1.0,  cap:'round',  pressure:true,  flow:1.0},
  watercolor:{ smoothing:.6,  alpha:.25,  widthMult:2.0,  cap:'round',  pressure:true,  flow:.5 },
};

function smoothPoints(pts, smoothing) {
  if (pts.length < 3 || smoothing < 0.05) return null;
  const s = smoothing * 0.4, cp = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0=pts[Math.max(0,i-1)], p1=pts[i], p2=pts[i+1], p3=pts[Math.min(pts.length-1,i+2)];
    cp.push([p1[0]+(p2[0]-p0[0])*s, p1[1]+(p2[1]-p0[1])*s, p2[0]-(p3[0]-p1[0])*s, p2[1]-(p3[1]-p1[1])*s]);
  }
  return cp;
}

function calcPressure(pts, i) {
  if (i===0||i>=pts.length-1) return 0.8;
  const dx=pts[i+1][0]-pts[i-1][0], dy=pts[i+1][1]-pts[i-1][1];
  const speed=Math.sqrt(dx*dx+dy*dy);
  return Math.max(0.3, Math.min(1.2, 1.4-speed*0.018));
}

function _drawPath(ctx, pts, smoothing) {
  const cp=smoothPoints(pts,smoothing);
  ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]);
  if (!cp) { for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0],pts[i][1]); }
  else { for(let i=0;i<cp.length;i++) ctx.bezierCurveTo(cp[i][0],cp[i][1],cp[i][2],cp[i][3],pts[i+1][0],pts[i+1][1]); }
}

// ── THE KEY FIX: renderStrokeProper uses rng = makePRNG(s.seed) ──────────────
// Every call with the same stroke (same seed, same points) renders identically
// This means Telegram chat image exactly matches what the artist sees
function renderStrokeProper(ctx, s) {
  const pts=s.points||[];
  if (pts.length<2) return;

  const btype    =s.brushType||'pen';
  const size     =s.size||6;
  const color    =s.color||'#000000';
  const opacity  =s.opacity!=null?s.opacity:1.0;
  const flow     =s.flow!=null?s.flow:0.8;
  const smoothing=s.smoothing!=null?s.smoothing:(BRUSH_DEFAULTS[btype]?.smoothing??0.5);
  const bd       =BRUSH_DEFAULTS[btype]||BRUSH_DEFAULTS.pen;

  // DETERMINISTIC PRNG — seed provided by client on stroke start
  const rng = makePRNG(s.seed || 12345);

  ctx.save();

  if (btype==='eraser') {
    ctx.globalCompositeOperation='destination-out';
    ctx.globalAlpha=1.0; ctx.strokeStyle='rgba(0,0,0,1)';
    ctx.lineWidth=size*bd.widthMult; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.setLineDash([]);
    _drawPath(ctx,pts,smoothing); ctx.stroke();
    ctx.restore(); return;
  }

  if (btype==='line') {
    ctx.globalCompositeOperation='source-over';
    ctx.globalAlpha=opacity*flow; ctx.strokeStyle=color;
    ctx.lineWidth=size; ctx.lineCap='round'; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]);
    ctx.lineTo(pts[pts.length-1][0],pts[pts.length-1][1]); ctx.stroke();
    ctx.restore(); return;
  }

  // Flood fill — server-side
  if (btype==='fill') {
    const [fx,fy]=pts[0];
    const sx=Math.round(fx), sy=Math.round(fy);
    const w=ctx.canvas.width, h=ctx.canvas.height;
    if (sx>=0&&sx<w&&sy>=0&&sy<h) {
      const imgData=ctx.getImageData(0,0,w,h); const data=imgData.data;
      const idx=(sy*w+sx)*4;
      const sr=data[idx],sg=data[idx+1],sb=data[idx+2],sa=data[idx+3];
      const fr=parseInt(color.slice(1,3),16), fg=parseInt(color.slice(3,5),16), fb=parseInt(color.slice(5,7),16);
      if(!(sr===fr&&sg===fg&&sb===fb&&sa===255)){
        const match=i=>{ const dr=data[i]-sr,dg=data[i+1]-sg,db=data[i+2]-sb,da=data[i+3]-sa; return dr*dr+dg*dg+db*db+da*da<=900; };
        const stack=[sx+sy*w]; const visited=new Uint8Array(w*h); visited[sx+sy*w]=1;
        while(stack.length){
          const pos=stack.pop(); const x=pos%w,y=(pos/w)|0; const i=pos*4;
          data[i]=fr;data[i+1]=fg;data[i+2]=fb;data[i+3]=255;
          const L=x-1,R=x+1,U=y-1,D=y+1;
          if(L>=0&&!visited[L+y*w]&&match((L+y*w)*4)){visited[L+y*w]=1;stack.push(L+y*w);}
          if(R<w&&!visited[R+y*w]&&match((R+y*w)*4)){visited[R+y*w]=1;stack.push(R+y*w);}
          if(U>=0&&!visited[x+U*w]&&match((x+U*w)*4)){visited[x+U*w]=1;stack.push(x+U*w);}
          if(D<h&&!visited[x+D*w]&&match((x+D*w)*4)){visited[x+D*w]=1;stack.push(x+D*w);}
        }
        ctx.putImageData(imgData,0,0);
      }
    }
    ctx.restore(); return;
  }

  if (btype==='eyedrop') { ctx.restore(); return; }

  // ── Airbrush — gaussian density falloff (matches client exactly via rng seed) ──
  if (btype==='airbrush') {
    ctx.globalCompositeOperation='source-over';
    ctx.fillStyle=color;
    const radius=size*2.5;
    const particleCount=Math.floor(radius*radius*0.6*flow);
    for (let i=0;i<pts.length;i++) {
      for (let d=0;d<particleCount;d++) {
        const u1=rng(), u2=rng();
        const gauss=Math.sqrt(-2*Math.log(Math.max(u1,0.0001)))*Math.cos(2*Math.PI*u2);
        const r=Math.abs(gauss)*radius*0.38;
        const angle=rng()*Math.PI*2;
        const px=pts[i][0]+Math.cos(angle)*r;
        const py=pts[i][1]+Math.sin(angle)*r;
        const distFraction=r/radius;
        const particleAlpha=opacity*bd.alpha*(1-distFraction*distFraction)*0.6;
        const particleSize=rng()*1.2+0.4;
        ctx.globalAlpha=particleAlpha;
        ctx.beginPath(); ctx.arc(px,py,particleSize,0,Math.PI*2); ctx.fill();
      }
    }
    ctx.restore(); return;
  }

  // ── Watercolor (seeded — matches client) ──
  if (btype==='watercolor') {
    ctx.globalCompositeOperation='source-over';
    ctx.strokeStyle=color; ctx.lineCap='round'; ctx.lineJoin='round';
    for (let l=0;l<6;l++) {
      ctx.globalAlpha=opacity*bd.alpha*flow/6;
      ctx.lineWidth=size*bd.widthMult*(0.7+rng()*0.6);
      ctx.beginPath(); ctx.moveTo(pts[0][0]+(rng()-.5)*size*.3,pts[0][1]+(rng()-.5)*size*.3);
      for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0]+(rng()-.5)*size*.4,pts[i][1]+(rng()-.5)*size*.4);
      ctx.stroke();
    }
    ctx.restore(); return;
  }

  // ── Bristle (seeded — matches client) ──
  if (btype==='bristle') {
    ctx.globalCompositeOperation='source-over';
    ctx.lineCap='round'; ctx.lineJoin='round';
    const bristles=Math.max(4,Math.floor(size*0.7));
    ctx.lineWidth=Math.max(0.8,size/bristles*1.2);
    for (let b=0;b<bristles;b++) {
      ctx.globalAlpha=opacity*bd.alpha*flow*(0.5+rng()*.5);
      ctx.strokeStyle=color;
      const r=size*0.55, offX=(rng()-.5)*r*2, offY=(rng()-.5)*r*2;
      ctx.beginPath(); ctx.moveTo(pts[0][0]+offX,pts[0][1]+offY);
      for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0]+offX*(0.85+rng()*.3),pts[i][1]+offY*(0.85+rng()*.3));
      ctx.stroke();
    }
    ctx.restore(); return;
  }

  if (btype==='ink') {
    ctx.globalCompositeOperation='source-over';
    ctx.strokeStyle=color; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.setLineDash([]);
    for (let i=1;i<pts.length;i++) {
      const p=calcPressure(pts,i);
      ctx.globalAlpha=opacity*flow*Math.min(1,p*0.9+0.1);
      ctx.lineWidth=size*p*bd.widthMult;
      ctx.beginPath(); ctx.moveTo(pts[i-1][0],pts[i-1][1]); ctx.lineTo(pts[i][0],pts[i][1]); ctx.stroke();
    }
    ctx.restore(); return;
  }

  // ── Pencil (seeded) ──
  if (btype==='pencil') {
    ctx.globalCompositeOperation='source-over';
    ctx.strokeStyle=color; ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.setLineDash([size*0.5,size*0.2]);
    ctx.lineWidth=size*bd.widthMult; ctx.globalAlpha=opacity*bd.alpha*flow;
    for (let pass=0;pass<2;pass++) {
      ctx.beginPath(); ctx.moveTo(pts[0][0]+(rng()-.5)*1.5,pts[0][1]+(rng()-.5)*1.5);
      for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0]+(rng()-.5)*1.5,pts[i][1]+(rng()-.5)*1.5);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore(); return;
  }

  // ── Pen / Marker / Flat ──
  ctx.globalCompositeOperation='source-over';
  ctx.globalAlpha=opacity*bd.alpha*flow;
  ctx.strokeStyle=color; ctx.lineCap=bd.cap||'round'; ctx.lineJoin='round'; ctx.setLineDash([]);
  if (bd.pressure&&btype!=='marker'&&btype!=='flat') {
    for (let i=1;i<pts.length;i++) {
      const p=calcPressure(pts,i);
      ctx.lineWidth=size*bd.widthMult*p;
      ctx.beginPath(); ctx.moveTo(pts[i-1][0],pts[i-1][1]); ctx.lineTo(pts[i][0],pts[i][1]); ctx.stroke();
    }
  } else {
    ctx.lineWidth=size*bd.widthMult;
    _drawPath(ctx,pts,smoothing); ctx.stroke();
  }
  ctx.restore();
}

async function renderPNG(strokes) {
  const canvas=createCanvas(CANVAS_W,CANVAS_H);
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
  for (const s of (strokes||[])) renderStrokeProper(ctx,s);
  return canvas.toBuffer('image/png');
}

// ── Game state ────────────────────────────────────────────────────────────────
const games = new Map();

function makeGame(chatId) {
  return {
    chatId,
    phase: 'idle',
    drawerTgId:  null,
    drawerName:  '',
    drawerWsId:  null,
    word:             null,
    hintRevealed:     [],
    strokes:          [],
    strokesUndo:      [], // for server-side undo stack
    roundStartTime:   0,
    firstStrokeDrawn: false,
    lastHintAt:       0,
    roundTimer:  null,
    hintTimer:   null,
    updateTimer: null,
    inviteMessageId: null,
    liveMessageId:   null,
    scores: new Map(),
    clients: new Map(),
  };
}

function getOrMakeGame(chatId) {
  const key=String(chatId);
  if (!games.has(key)) games.set(key,makeGame(key));
  return games.get(key);
}

function broadcastToGame(game, msg, skipWsId=null) {
  const d=JSON.stringify(msg);
  game.clients.forEach((c,id)=>{
    if(id!==skipWsId&&c.ws.readyState===WebSocket.OPEN) c.ws.send(d);
  });
}

function sendToWs(game, wsId, msg) {
  const c=game.clients.get(wsId);
  if(c&&c.ws.readyState===WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

function getLeaderboard(game) {
  return Array.from(game.scores.entries())
    .sort((a,b)=>b[1]-a[1])
    .map(([name,score],i)=>({rank:i+1,name,score}));
}

function fmtLeaderboard(game) {
  const lb=getLeaderboard(game);
  if(!lb.length) return 'No scores yet.';
  const medals=['🥇','🥈','🥉'];
  return lb.slice(0,10).map(({rank,name,score})=>`${medals[rank-1]||`${rank}.`} *${name}* — ${score} pts`).join('\n');
}

function buildHint(word, revealed) {
  return word.split('').map((ch,i)=>ch===' '?'  ':(revealed[i]?ch:'_')).join(' ');
}

// ── Hint reveals ──────────────────────────────────────────────────────────────
function revealNextHint(game) {
  if(game.phase!=='drawing'||!game.word) return null;
  const unrevealed=game.word.split('').map((_,i)=>i).filter(i=>game.word[i]!==' '&&!game.hintRevealed[i]);
  if(!unrevealed.length) return null;
  const idx=unrevealed[Math.floor(Math.random()*unrevealed.length)];
  game.hintRevealed[idx]=true;
  game.lastHintAt=Date.now();
  const hint=buildHint(game.word,game.hintRevealed);
  broadcastToGame(game,{type:'hint',hint});
  const allRevealed=game.word.split('').every((c,i)=>c===' '||game.hintRevealed[i]);
  if(allRevealed) setTimeout(()=>endGame(game,null,'all_hints'),2000);
  return hint;
}

// ── Canvas push to Telegram ───────────────────────────────────────────────────
async function pushCanvasToChat(game) {
  if(game.phase!=='drawing'||!game.word) return;
  let png;
  try{ png=await renderPNG(game.strokes); }
  catch(e){ console.error('[render]',e.message); return; }

  const hint=buildHint(game.word,game.hintRevealed);
  const caption=`🎨 *${game.drawerName}* is drawing!\n🔤 \`${hint}\`  —  ${game.word.length} letters\n\n💬 Type your guess in the chat!`;
  const now=Date.now();
  const cooldownLeft=Math.ceil((HINT_COOLDOWN_MS-(now-game.lastHintAt))/1000);
  const hintLabel=cooldownLeft<=0?'💡 Hint':`⏳ Hint (${cooldownLeft}s)`;
  const keyboard=Markup.inlineKeyboard([[Markup.button.callback(hintLabel,`hint:${game.chatId}`)]]);

  try {
    if(game.liveMessageId){
      await bot.telegram.editMessageMedia(
        game.chatId,game.liveMessageId,null,
        {type:'photo',media:{source:png,filename:'drawing.png'},caption,parse_mode:'Markdown'},
        keyboard
      );
    } else {
      const m=await bot.telegram.sendPhoto(game.chatId,{source:png,filename:'drawing.png'},{caption,parse_mode:'Markdown',...keyboard});
      game.liveMessageId=m.message_id;
    }
  } catch(e) {
    if(/not modified/i.test(e.message)) return;
    console.error('[pushCanvas]',e.message);
    if(/not found|deleted|message to edit|socket hang up|ECONNRESET|ETIMEDOUT/i.test(e.message)){
      game.liveMessageId=null;
      try{
        const m=await bot.telegram.sendPhoto(game.chatId,{source:png,filename:'drawing.png'},{caption,parse_mode:'Markdown',...keyboard});
        game.liveMessageId=m.message_id;
      }catch{}
    }
  }
}

function scheduleCanvasUpdate(game) {
  if(!game.firstStrokeDrawn) return;
  if(game.updateTimer) return;
  game.updateTimer=setTimeout(async()=>{
    game.updateTimer=null;
    await pushCanvasToChat(game);
  },1500);
}

// ── End game ──────────────────────────────────────────────────────────────────
async function endGame(game, guesserName, reason) {
  if(game.phase==='ended'||game.phase==='idle') return;
  game.phase='ended';
  clearTimeout(game.roundTimer); clearTimeout(game.hintTimer); clearTimeout(game.updateTimer);
  game.roundTimer=game.hintTimer=game.updateTimer=null;
  console.log(`[game] END chatId=${game.chatId} word=${game.word} guesser=${guesserName||'none'} reason=${reason}`);

  if(game.drawerWsId){
    sendToWs(game,game.drawerWsId,{
      type:'round_end',word:game.word,drawerName:game.drawerName,
      guesser:guesserName||null,reason,board:getLeaderboard(game),drawerFinish:true,
    });
  }
  broadcastToGame(game,{
    type:'round_end',word:game.word,drawerName:game.drawerName,
    guesser:guesserName||null,reason,board:getLeaderboard(game),
  },game.drawerWsId);

  await postGameResult(game,guesserName,reason);

  game.word=null; game.hintRevealed=[]; game.strokes=[]; game.strokesUndo=[];
  game.firstStrokeDrawn=false; game.lastHintAt=0;
  game.drawerTgId=null; game.drawerName=''; game.drawerWsId=null;
  game.inviteMessageId=null;
  setTimeout(()=>{ game.phase='idle'; },3000);
}

async function postGameResult(game, guesserName, reason) {
  let png;
  try{ png=await renderPNG(game.strokes); }catch(e){ console.error('[endGame render]',e.message); }

  const lines=[
    `✅ *Round Over!*`,``,
    `🖌 Drawer: *${game.drawerName}*`,
    `🎯 Word: *${game.word}*`,
    guesserName
      ? `🏆 Guessed by: *${guesserName}*`
      : reason==='all_hints' ? `🔤 All hints revealed! Nobody guessed.`
      : reason==='stopped'   ? `🛑 Game stopped by admin.`
      : `😮 Round ended.`,
    ``,`📊 *Leaderboard:*`,
    fmtLeaderboard(game),``,
    `_Use /startgame to play again!_`,
  ].join('\n');

  try {
    if(game.liveMessageId&&png){
      await bot.telegram.editMessageMedia(
        game.chatId,game.liveMessageId,null,
        {type:'photo',media:{source:png,filename:`${game.word}.png`},caption:lines,parse_mode:'Markdown'},
        Markup.inlineKeyboard([])
      );
    } else if(png){
      await bot.telegram.sendPhoto(game.chatId,{source:png,filename:`${game.word}.png`},{caption:lines,parse_mode:'Markdown'});
    } else {
      await bot.telegram.sendMessage(game.chatId,lines,{parse_mode:'Markdown'});
    }
  } catch(e) {
    console.error('[postGameResult]',e.message);
    try{ await bot.telegram.sendMessage(game.chatId,lines,{parse_mode:'Markdown'}); }catch{}
  }
}

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.command('startgame', async (ctx) => {
  if(ctx.chat.type==='private') return ctx.reply('➕ Add me to a group and use /startgame there!');
  const chatId=String(ctx.chat.id);
  const game=getOrMakeGame(chatId);
  if(game.phase==='waiting_drawer') return ctx.reply('⏳ Already waiting for someone to press "I Want to Draw"!');
  if(game.phase==='drawing') return ctx.reply('🎨 A game is already in progress! Type your guess in the chat.');
  game.phase='waiting_drawer'; game.scores=new Map(); game.strokes=[]; game.strokesUndo=[];
  game.word=null; game.drawerTgId=null; game.drawerName=''; game.drawerWsId=null; game.liveMessageId=null;
  if(!botUsername){
    try{ const me=await bot.telegram.getMe(); botUsername=me.username; }
    catch(e){ return ctx.reply('Bot still starting, try again in a moment.'); }
  }
  const msg=await ctx.reply(
    `🎨 *Draw & Guess!*\n\nWho wants to draw this round?\nPress the button below! ✏️`,
    {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('✏️ I Want to Draw!',`claim_draw:${chatId}`)]])}
  );
  game.inviteMessageId=msg.message_id;
  console.log(`[bot] /startgame chatId=${chatId}`);
});

bot.command('stopgame', async (ctx) => {
  const chatId=String(ctx.chat.id);
  const game=games.get(chatId);
  if(!game||game.phase==='idle') return ctx.reply('No active game.');
  await endGame(game,null,'stopped');
  ctx.reply('🛑 Game stopped.');
});

bot.command('skipword', async (ctx) => {
  const chatId=String(ctx.chat.id);
  const game=games.get(chatId);
  if(!game||game.phase!=='drawing') return ctx.reply('No active round.');
  const nw=pickWord();
  game.word=nw; game.hintRevealed=new Array(nw.length).fill(false);
  game.strokes=[]; game.strokesUndo=[]; game.firstStrokeDrawn=false; game.lastHintAt=0;
  clearTimeout(game.hintTimer); game.hintTimer=null;
  if(game.drawerWsId) sendToWs(game,game.drawerWsId,{type:'role',role:'drawer',word:nw,round:1});
  broadcastToGame(game,{type:'clear'},game.drawerWsId);
  broadcastToGame(game,{type:'word_skipped',hint:buildHint(nw,game.hintRevealed)},game.drawerWsId);
  ctx.reply('✅ Word skipped!');
});

bot.command('leaderboard', async (ctx) => {
  const game=games.get(String(ctx.chat.id));
  if(!game) return ctx.reply('No game. Use /startgame.');
  ctx.reply(`📊 *Leaderboard*\n\n${fmtLeaderboard(game)}`,{parse_mode:'Markdown'});
});

// ── Claim draw callback ───────────────────────────────────────────────────────
bot.action(/^claim_draw:(.+)$/, async (ctx) => {
  const chatId=ctx.match[1];
  const game=games.get(chatId);
  if(!game) return ctx.answerCbQuery('❌ No active game. Use /startgame.',{show_alert:true});
  if(game.phase!=='waiting_drawer') return ctx.answerCbQuery('❌ A drawer already claimed this round!',{show_alert:true});

  const tgId=String(ctx.from.id);
  const fname=ctx.from.first_name||'', lname=ctx.from.last_name||'';
  const uname=`${fname} ${lname}`.trim()||ctx.from.username||'Artist';

  game.drawerTgId=tgId; game.drawerName=uname; game.phase='drawing';
  game.word=pickWord(); game.hintRevealed=new Array(game.word.length).fill(false);
  game.strokes=[]; game.strokesUndo=[]; game.roundStartTime=Date.now();

  console.log(`[game] Drawer: ${uname} (${tgId}), word=${game.word}, chatId=${chatId}`);
  await ctx.answerCbQuery('✅ You are the drawer! Open your canvas.',{show_alert:false});

  const startappParam=encodeURIComponent(`${chatId}__${tgId}__${uname}`);
  const canvasUrl=`https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}?startapp=${startappParam}`;

  try {
    await bot.telegram.editMessageText(
      chatId,game.inviteMessageId,null,
      `🎨 *${uname}* is drawing!\n🔤 \`${buildHint(game.word,game.hintRevealed)}\`  —  ${game.word.length} letters\n\n💬 Type your guess in the chat!`,
      {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.url('🖌 Open Canvas to Draw',canvasUrl)]])}
    );
  } catch(e){ console.error('[editInvite]',e.message); }
});

// ── Hint button ───────────────────────────────────────────────────────────────
bot.action(/^hint:(.+)$/, async (ctx) => {
  const chatId=ctx.match[1];
  const game=games.get(chatId);
  if(!game||game.phase!=='drawing') return ctx.answerCbQuery('❌ No active game!',{show_alert:false});
  if(!game.firstStrokeDrawn) return ctx.answerCbQuery('⏳ Wait for the drawer to start!',{show_alert:false});

  const now=Date.now();
  const cooldownLeft=Math.ceil((HINT_COOLDOWN_MS-(now-game.lastHintAt))/1000);
  if(cooldownLeft>0) return ctx.answerCbQuery(`⏳ Wait ${cooldownLeft}s before next hint!`,{show_alert:false});

  const unrevealed=game.word.split('').filter((c,i)=>c!==' '&&!game.hintRevealed[i]);
  if(!unrevealed.length) return ctx.answerCbQuery('🤷 No more hints!',{show_alert:false});

  const hint=revealNextHint(game);
  if(!hint) return ctx.answerCbQuery('No hints left!',{show_alert:false});

  const presserName=ctx.from.first_name||ctx.from.username||'Someone';
  console.log(`[hint] ${presserName} → ${hint}`);
  await ctx.answerCbQuery('💡 Hint revealed!',{show_alert:false});
  await pushCanvasToChat(game);
});

// ── Text = guesses ────────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  if(ctx.chat.type==='private') return;
  const chatId=String(ctx.chat.id);
  const game=games.get(chatId);
  if(!game||game.phase!=='drawing'||!game.word) return;

  const text=(ctx.message.text||'').trim();
  if(text.startsWith('/')) return;

  const tgId=String(ctx.from.id);
  const fname=ctx.from.first_name||'', lname=ctx.from.last_name||'';
  const name=`${fname} ${lname}`.trim()||ctx.from.username||'Player';

  const correct=text.toLowerCase()===game.word.toLowerCase();
  broadcastToGame(game,{type:'guess',name,text,correct});

  if(correct){
    console.log(`[game] Correct! "${text}" by ${name}`);
    const hintsGiven=game.hintRevealed.filter(Boolean).length;
    const elapsed=(Date.now()-game.roundStartTime)/1000;
    const timeBonus=Math.max(0,Math.floor((120-elapsed)/10));
    const pts=Math.max(10,100-hintsGiven*10+timeBonus);
    game.scores.set(name,(game.scores.get(name)||0)+pts);
    game.scores.set(game.drawerName,(game.scores.get(game.drawerName)||0)+50);
    broadcastToGame(game,{type:'score_update',name,pts,timeBonus,board:getLeaderboard(game)});
    try{
      await bot.telegram.sendMessage(chatId,
        `🎉 *${name}* guessed it!\nThe word was *${game.word}* ✅  +${pts} pts${timeBonus?` ⚡ +${timeBonus} time bonus`:''}`,
        {parse_mode:'Markdown'});
    }catch{}
    await endGame(game,name,'guess');
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const wsId=uuidv4();
  const url=new URL(req.url,'http://localhost');
  const chatId=url.searchParams.get('room')||'';
  const name=url.searchParams.get('name')||'Artist';
  const tgId=url.searchParams.get('userId')||'';

  if(!chatId){ ws.close(); return; }

  const game=getOrMakeGame(chatId);
  const isDrawer=tgId&&tgId===game.drawerTgId&&game.phase==='drawing';

  if(isDrawer&&game.drawerWsId){
    const old=game.clients.get(game.drawerWsId);
    if(old&&old.ws.readyState===WebSocket.OPEN){
      console.log(`[ws] Closing duplicate drawer WS for ${name}`);
      old.ws.close();
    }
    game.clients.delete(game.drawerWsId);
    game.drawerWsId=null;
  }

  game.clients.set(wsId,{ws,name,tgId});
  console.log(`[ws] +${name} tgId=${tgId} chatId=${chatId} clients=${game.clients.size}`);

  if(isDrawer){
    game.drawerWsId=wsId;
    ws.send(JSON.stringify({type:'role',role:'drawer',word:game.word,round:1}));
    console.log(`[ws] ${name} = DRAWER, word=${game.word}`);
  } else {
    ws.send(JSON.stringify({type:'init',strokes:game.strokes,players:game.clients.size,board:getLeaderboard(game)}));
    if(game.phase==='drawing'){
      ws.send(JSON.stringify({type:'role',role:'guesser',hint:buildHint(game.word,game.hintRevealed),round:1}));
      ws.send(JSON.stringify({type:'status',message:`${game.drawerName} is drawing! Guess in the Telegram chat!`}));
    } else {
      ws.send(JSON.stringify({type:'status',message:'No game running. Use /startgame in the group!'}));
    }
  }

  broadcastToGame(game,{type:'player_joined',name,count:game.clients.size},wsId);

  ws.on('message', data => {
    let msg; try{ msg=JSON.parse(data); }catch{ return; }

    switch(msg.type){

      case 'draw':
        if(wsId!==game.drawerWsId) return;
        // Save for undo stack
        game.strokesUndo.push({...msg.stroke});
        game.strokes.push(msg.stroke);
        broadcastToGame(game,{type:'draw',stroke:msg.stroke},wsId);
        if(!game.firstStrokeDrawn){
          game.firstStrokeDrawn=true; game.roundStartTime=Date.now();
          console.log(`[game] First stroke by ${name}`);
          setTimeout(()=>pushCanvasToChat(game),500);
        } else {
          scheduleCanvasUpdate(game);
        }
        break;

      case 'undo':
        if(wsId!==game.drawerWsId) return;
        if(game.strokes.length>0){
          game.strokes.pop();
          scheduleCanvasUpdate(game);
        }
        break;

      case 'redo':
        // Redo: re-push from undo stack if available
        if(wsId!==game.drawerWsId) return;
        {
          const last=game.strokesUndo[game.strokes.length];
          if(last){ game.strokes.push(last); scheduleCanvasUpdate(game); }
        }
        break;

      case 'clear':
        if(wsId!==game.drawerWsId) return;
        game.strokes=[]; game.strokesUndo=[]; game.firstStrokeDrawn=false;
        broadcastToGame(game,{type:'clear'});
        break;

      case 'snapshot':
        if(wsId!==game.drawerWsId) return;
        broadcastToGame(game,{type:'snapshot',data:msg.data},wsId);
        break;

      case 'guess':{
        if(wsId===game.drawerWsId) return;
        const t=(msg.text||'').trim(); if(!t) return;
        const ok=game.word&&t.toLowerCase()===game.word.toLowerCase();
        broadcastToGame(game,{type:'guess',name,text:t,correct:ok});
        if(ok){
          const hintsGiven=game.hintRevealed.filter(Boolean).length;
          const elapsed=(Date.now()-game.roundStartTime)/1000;
          const timeBonus=Math.max(0,Math.floor((120-elapsed)/10));
          const pts=Math.max(10,100-hintsGiven*10+timeBonus);
          game.scores.set(name,(game.scores.get(name)||0)+pts);
          game.scores.set(game.drawerName,(game.scores.get(game.drawerName)||0)+50);
          broadcastToGame(game,{type:'score_update',name,pts,timeBonus,board:getLeaderboard(game)});
          bot.telegram.sendMessage(game.chatId,`🎉 *${name}* guessed it! The word was *${game.word}* ✅  +${pts} pts`,{parse_mode:'Markdown'}).catch(()=>{});
          endGame(game,name,'guess');
        }
        break;
      }

      case 'change_word':
        if(wsId!==game.drawerWsId) return;
        {
          const nw=pickWord();
          game.word=nw; game.hintRevealed=new Array(nw.length).fill(false);
          game.strokes=[]; game.strokesUndo=[]; game.firstStrokeDrawn=false; game.lastHintAt=0;
          sendToWs(game,wsId,{type:'role',role:'drawer',word:nw,round:1});
          broadcastToGame(game,{type:'clear'},wsId);
          broadcastToGame(game,{type:'word_skipped',hint:buildHint(nw,game.hintRevealed)},wsId);
        }
        break;

      case 'skip_word':
        if(wsId!==game.drawerWsId) return;
        {
          const nw=pickWord();
          game.word=nw; game.hintRevealed=new Array(nw.length).fill(false);
          game.strokes=[]; game.strokesUndo=[]; game.firstStrokeDrawn=false; game.lastHintAt=0;
          clearTimeout(game.roundTimer); clearTimeout(game.hintTimer);
          game.roundTimer=null; game.hintTimer=null;
          sendToWs(game,wsId,{type:'role',role:'drawer',word:nw,round:1});
          broadcastToGame(game,{type:'clear'},wsId);
          broadcastToGame(game,{type:'word_skipped',hint:buildHint(nw,game.hintRevealed)},wsId);
        }
        break;

      case 'done_drawing':
        if(wsId!==game.drawerWsId) return;
        endGame(game,null,'done');
        break;

      case 'get_logs':
        // Logs are stored client-side — server just acknowledges
        ws.send(JSON.stringify({type:'logs',logs:[]}));
        break;
    }
  });

  ws.on('close', ()=>{
    game.clients.delete(wsId);
    console.log(`[ws] -${name} left chatId=${chatId} remaining=${game.clients.size}`);
    broadcastToGame(game,{type:'player_left',name,count:game.clients.size});
    if(wsId===game.drawerWsId){ game.drawerWsId=null; console.log(`[ws] Drawer closed Mini App`); }
  });

  ws.on('error', err=>{ console.error(`[ws] ${name}:`,err.message); ws.close(); });
});

// ── Bot launch ────────────────────────────────────────────────────────────────
function telegramPost(method, body) {
  return new Promise((resolve,reject)=>{
    const https=require('https');
    const payload=JSON.stringify(body);
    const req=https.request({
      hostname:'api.telegram.org',
      path:`/bot${BOT_TOKEN}/${method}`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},
    },res=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} }); });
    req.on('error',reject); req.write(payload); req.end();
  });
}

async function launchBot() {
  try{
    const me=await bot.telegram.getMe();
    botUsername=me.username;
    console.log(`🤖 @${botUsername} ready`);

    await bot.telegram.setMyCommands([
      {command:'startgame',   description:'Start a new Draw & Guess game'},
      {command:'stopgame',    description:'Stop the current game'},
      {command:'skipword',    description:'Skip current word'},
      {command:'leaderboard', description:'Show scores'},
    ]);

    const info=(await telegramPost('getWebhookInfo',{})).result||{};
    if(info.url===WEBHOOK_URL){
      console.log('[bot] ✅ Webhook already active');
    } else {
      const r=await telegramPost('setWebhook',{url:WEBHOOK_URL,drop_pending_updates:true,allowed_updates:['message','callback_query']});
      console.log('[bot] setWebhook:',r.description||JSON.stringify(r));
    }
  } catch(e){
    console.error('[bot] launchBot error:',e.message);
    setTimeout(launchBot,5000);
  }
}

server.listen(PORT,()=>{
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
  setTimeout(launchBot,1000);
  if(PUBLIC_URL){
    setInterval(()=>{
      const mod=PUBLIC_URL.startsWith('https')?require('https'):require('http');
      mod.get(`${PUBLIC_URL}/ping`,r=>console.log(`[keepalive] ${r.statusCode}`)).on('error',e=>console.warn('[keepalive]',e.message));
    },4*60*1000);
  }
});

process.on('unhandledRejection',r=>console.error('[unhandledRejection]',r?.message||r));
process.on('uncaughtException', e=>console.error('[uncaughtException]',e.message));
process.once('SIGINT', ()=>{ server.close(); process.exit(0); });
process.once('SIGTERM',()=>{ server.close(); process.exit(0); });
