require('dotenv').config();
const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const path        = require('path');
const { v4: uuidv4 } = require('uuid');
const { Telegraf, Markup } = require('telegraf');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const Database    = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN         = process.env.BOT_TOKEN;
const PUBLIC_URL        = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT              = process.env.PORT || 3000;
const WEBAPP_SHORT_NAME = process.env.WEBAPP_SHORT_NAME || 'draw1';
const HINT_COOLDOWN_MS  = parseInt(process.env.HINT_COOLDOWN_MS || '30000');
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET || 'tgbot';
const DB_PATH           = process.env.DB_PATH || path.join(__dirname, 'drawbot.db');

if (!BOT_TOKEN)  { console.error('BOT_TOKEN missing');  process.exit(1); }
if (!PUBLIC_URL) { console.error('PUBLIC_URL missing'); process.exit(1); }

console.log(`[config] WEBAPP=${WEBAPP_SHORT_NAME} HINT_COOLDOWN=${HINT_COOLDOWN_MS/1000}s DB=${DB_PATH}`);

// ── SQLite ────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    chat_id TEXT PRIMARY KEY, phase TEXT NOT NULL DEFAULT 'idle',
    drawer_tg_id TEXT, drawer_name TEXT, word TEXT,
    hint_revealed TEXT, strokes TEXT, scores TEXT,
    round_start INTEGER, first_stroke INTEGER DEFAULT 0,
    last_hint_at INTEGER DEFAULT 0,
    invite_msg_id INTEGER, live_msg_id INTEGER, updated_at INTEGER,
    canvas_w INTEGER DEFAULT 1920, canvas_h INTEGER DEFAULT 1080
  );
`);
const stmtUpsert = db.prepare(`
  INSERT INTO games (chat_id,phase,drawer_tg_id,drawer_name,word,hint_revealed,
    strokes,scores,round_start,first_stroke,last_hint_at,invite_msg_id,live_msg_id,canvas_w,canvas_h,updated_at)
  VALUES (@chat_id,@phase,@drawer_tg_id,@drawer_name,@word,@hint_revealed,
    @strokes,@scores,@round_start,@first_stroke,@last_hint_at,@invite_msg_id,@live_msg_id,@canvas_w,@canvas_h,@updated_at)
  ON CONFLICT(chat_id) DO UPDATE SET
    phase=excluded.phase,drawer_tg_id=excluded.drawer_tg_id,drawer_name=excluded.drawer_name,
    word=excluded.word,hint_revealed=excluded.hint_revealed,strokes=excluded.strokes,
    scores=excluded.scores,round_start=excluded.round_start,first_stroke=excluded.first_stroke,
    last_hint_at=excluded.last_hint_at,invite_msg_id=excluded.invite_msg_id,
    live_msg_id=excluded.live_msg_id,canvas_w=excluded.canvas_w,canvas_h=excluded.canvas_h,
    updated_at=excluded.updated_at
`);
const stmtGet = db.prepare(`SELECT * FROM games WHERE chat_id = ?`);
const stmtAll = db.prepare(`SELECT * FROM games WHERE phase != 'idle'`);

// Migration: add canvas_w/canvas_h columns if they don't exist yet
try{db.exec(`ALTER TABLE games ADD COLUMN canvas_w INTEGER DEFAULT 1920`);}catch{}
try{db.exec(`ALTER TABLE games ADD COLUMN canvas_h INTEGER DEFAULT 1080`);}catch{}

function persistGame(game) {
  try {
    stmtUpsert.run({
      chat_id: game.chatId, phase: game.phase,
      drawer_tg_id: game.drawerTgId||null, drawer_name: game.drawerName||'',
      word: game.word||null, hint_revealed: JSON.stringify(game.hintRevealed||[]),
      strokes: JSON.stringify(game.strokes||[]),
      scores: JSON.stringify(Object.fromEntries(game.scores||new Map())),
      round_start: game.roundStartTime||0, first_stroke: game.firstStrokeDrawn?1:0,
      last_hint_at: game.lastHintAt||0, invite_msg_id: game.inviteMessageId||null,
      live_msg_id: game.liveMessageId||null,
      canvas_w: game.canvasW||DEFAULT_CW, canvas_h: game.canvasH||DEFAULT_CH,
      updated_at: Date.now(),
    });
  } catch(e) { console.error('[db] persist error:', e.message); }
}
const _persistTimers = new Map();
function persistDebounced(game, ms=500) {
  const k = game.chatId;
  if (_persistTimers.has(k)) clearTimeout(_persistTimers.get(k));
  _persistTimers.set(k, setTimeout(()=>{ _persistTimers.delete(k); persistGame(game); }, ms));
}
function rowToGame(row) {
  const g = makeGame(row.chat_id);
  g.phase = row.phase; g.drawerTgId = row.drawer_tg_id||null;
  g.drawerName = row.drawer_name||''; g.word = row.word||null;
  g.hintRevealed = JSON.parse(row.hint_revealed||'[]');
  g.strokes = JSON.parse(row.strokes||'[]');
  // FIX S1: strokesUndo must start empty after restore — redo stack is always empty on restart
  g.strokesUndo = [];
  g.roundStartTime = row.round_start||0; g.firstStrokeDrawn = row.first_stroke===1;
  g.lastHintAt = row.last_hint_at||0;
  g.inviteMessageId = row.invite_msg_id||null; g.liveMessageId = row.live_msg_id||null;
  g.scores = new Map(Object.entries(JSON.parse(row.scores||'{}')));
  g.canvasW = row.canvas_w||DEFAULT_CW; g.canvasH = row.canvas_h||DEFAULT_CH;
  return g;
}

// ── Express / WS / Bot ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const bot    = new Telegraf(BOT_TOKEN);
let botUsername = '';

app.use(express.json());
app.use((req,res,next)=>{ if(req.path!=='/ping') console.log(`[http] ${req.method} ${req.path}`); next(); });
app.get('/ping', (_req,res)=>res.send('pong'));
const WEBHOOK_PATH = `/webhook/${WEBHOOK_SECRET}`;
const WEBHOOK_URL  = `${PUBLIC_URL}${WEBHOOK_PATH}`;
app.post(WEBHOOK_PATH, async(req,res)=>{
  res.sendStatus(200);
  console.log('[webhook] update:', JSON.stringify(req.body).slice(0,120));
  try { await bot.handleUpdate(req.body); } catch(e){ console.error('[webhook]',e.message); }
});
app.get(WEBHOOK_PATH, (_req,res)=>res.send('Webhook active ✅'));
app.use(express.static(path.join(__dirname,'../../client')));

// ── Words ─────────────────────────────────────────────────────────────────────
const WORDS=['cat','dog','sun','car','fish','bird','moon','tree','house','flower','apple','pizza',
  'smile','heart','star','cake','boat','rain','snow','book','guitar','elephant','rainbow','castle',
  'dragon','piano','volcano','butterfly','telescope','snowman','dinosaur','waterfall','helicopter',
  'cactus','penguin','banana','scissors','telephone','umbrella','bicycle','submarine','tornado',
  'lighthouse','compass','anchor','mermaid','unicorn','wizard','knight','ninja','pirate','robot',
  'alien','crown','bridge'];
function pickWord(){ return WORDS[Math.floor(Math.random()*WORDS.length)]; }

// ── PRNG ──────────────────────────────────────────────────────────────────────
function makePRNG(seed){
  let s=seed>>>0;
  return function(){ s+=0x6D2B79F5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296; };
}

// ── Render engine ─────────────────────────────────────────────────────────────
const DEFAULT_CW=1920,DEFAULT_CH=1080;
const BD={
  pen:      {smoothing:.5,alpha:1.0,widthMult:1.0,cap:'round',pressure:true, flow:.8},
  pencil:   {smoothing:.3,alpha:.75,widthMult:.8, cap:'round',pressure:true, flow:.7},
  marker:   {smoothing:.6,alpha:.55,widthMult:1.6,cap:'round',pressure:false,flow:.9},
  bristle:  {smoothing:.2,alpha:.5, widthMult:1.0,cap:'round',pressure:true, flow:.6},
  ink:      {smoothing:.7,alpha:1.0,widthMult:1.0,cap:'round',pressure:true, flow:1.0},
  watercolor:{smoothing:.6,alpha:.25,widthMult:2.0,cap:'round',pressure:true,flow:.5},
  airbrush: {smoothing:.0,alpha:.04,widthMult:1.0,cap:'round',pressure:false,flow:.7},
  line:     {smoothing:.0,alpha:1.0,widthMult:1.0,cap:'round',pressure:false,flow:1.0},
  eraser:   {smoothing:.5,alpha:1.0,widthMult:1.0,cap:'round',pressure:false,flow:1.0},
};
function smoothPts(pts,sm){
  if(pts.length<3||sm<0.05)return null;
  const s=sm*0.4,cp=[];
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
    cp.push([p1[0]+(p2[0]-p0[0])*s,p1[1]+(p2[1]-p0[1])*s,p2[0]-(p3[0]-p1[0])*s,p2[1]-(p3[1]-p1[1])*s]);
  }
  return cp;
}
function pressure(pts,i){
  if(i===0||i>=pts.length-1)return 0.8;
  const dx=pts[i+1][0]-pts[i-1][0],dy=pts[i+1][1]-pts[i-1][1];
  return Math.max(0.3,Math.min(1.2,1.4-Math.sqrt(dx*dx+dy*dy)*0.018));
}
function drawPath(ctx,pts,sm){
  const cp=smoothPts(pts,sm);
  ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);
  if(!cp){for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);}
  else{for(let i=0;i<cp.length;i++)ctx.bezierCurveTo(cp[i][0],cp[i][1],cp[i][2],cp[i][3],pts[i+1][0],pts[i+1][1]);}
}
function renderStroke(ctx,s){
  const pts=s.points||[];
  const bt0=s.brushType||'pen';
  if(bt0==='_snapshot')return; // handled by renderPNG directly
  if(pts.length<1)return;
  if(pts.length<2&&bt0!=='fill'&&bt0!=='eyedrop')return;
  const bt=s.brushType||'pen',sz=s.size||6,col=s.color||'#000',
        op=s.opacity!=null?s.opacity:1.0,fl=s.flow!=null?s.flow:0.8,
        sm=s.smoothing!=null?s.smoothing:(BD[bt]?.smoothing??0.5),
        bd=BD[bt]||BD.pen,rng=makePRNG(s.seed||12345);
  ctx.save();
  ctx.setLineDash([]);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  if(bt==='eraser'){
    ctx.globalCompositeOperation='destination-out';ctx.globalAlpha=1;
    ctx.strokeStyle='rgba(0,0,0,1)';ctx.lineWidth=sz*bd.widthMult;
    ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([]);
    drawPath(ctx,pts,sm);ctx.stroke();ctx.restore();return;
  }
  if(bt==='line'){
    ctx.globalCompositeOperation='source-over';ctx.globalAlpha=op*fl;
    ctx.strokeStyle=col;ctx.lineWidth=sz;ctx.lineCap='round';ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);ctx.lineTo(pts[pts.length-1][0],pts[pts.length-1][1]);ctx.stroke();
    ctx.restore();return;
  }
  if(bt==='fill'){
    const[fx,fy]=pts[0];const sx=Math.round(fx),sy=Math.round(fy);
    const w=ctx.canvas.width,h=ctx.canvas.height;
    if(sx>=0&&sx<w&&sy>=0&&sy<h){
      const id=ctx.getImageData(0,0,w,h),d=id.data,ix=(sy*w+sx)*4;
      const sr=d[ix],sg=d[ix+1],sb=d[ix+2],sa=d[ix+3];
      const fr=parseInt(col.slice(1,3),16),fg=parseInt(col.slice(3,5),16),fb=parseInt(col.slice(5,7),16);
      if(!(sr===fr&&sg===fg&&sb===fb&&sa===255)){
        const match=i=>{const dr=d[i]-sr,dg=d[i+1]-sg,db=d[i+2]-sb,da=d[i+3]-sa;return dr*dr+dg*dg+db*db+da*da<=900;};
        const stack=[sx+sy*w],vis=new Uint8Array(w*h);vis[sx+sy*w]=1;
        while(stack.length){
          const pos=stack.pop(),x=pos%w,y=(pos/w)|0,i=pos*4;
          d[i]=fr;d[i+1]=fg;d[i+2]=fb;d[i+3]=255;
          [[x-1,y],[x+1,y],[x,y-1],[x,y+1]].forEach(([nx,ny])=>{
            if(nx>=0&&nx<w&&ny>=0&&ny<h&&!vis[nx+ny*w]&&match((nx+ny*w)*4)){vis[nx+ny*w]=1;stack.push(nx+ny*w);}
          });
        }
        ctx.putImageData(id,0,0);
      }
    }
    ctx.restore();return;
  }
  if(bt==='eyedrop'){ctx.restore();return;}
  if(bt==='airbrush'){
    ctx.globalCompositeOperation='source-over';ctx.fillStyle=col;
    const rad=sz*3.5,count=Math.floor(rad*rad*0.35*fl);
    for(let i=0;i<pts.length;i++){
      for(let d=0;d<count;d++){
        const u1=Math.max(rng(),1e-10),u2=rng();
        const mag=Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
        const r=Math.abs(mag)*rad*0.45,angle=rng()*Math.PI*2;
        const norm=Math.min(r/rad,1);
        ctx.globalAlpha=op*bd.alpha*(1-norm*norm*norm)*0.55;
        ctx.beginPath();ctx.arc(pts[i][0]+Math.cos(angle)*r,pts[i][1]+Math.sin(angle)*r,0.3+rng()*1.8+norm*0.8,0,Math.PI*2);ctx.fill();
      }
    }
    ctx.restore();return;
  }
  if(bt==='watercolor'){
    ctx.globalCompositeOperation='source-over';ctx.strokeStyle=col;ctx.lineCap='round';ctx.lineJoin='round';
    for(let l=0;l<6;l++){
      ctx.globalAlpha=op*bd.alpha*fl/6;ctx.lineWidth=sz*bd.widthMult*(0.7+rng()*0.6);
      ctx.beginPath();ctx.moveTo(pts[0][0]+(rng()-.5)*sz*.3,pts[0][1]+(rng()-.5)*sz*.3);
      for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0]+(rng()-.5)*sz*.4,pts[i][1]+(rng()-.5)*sz*.4);
      ctx.stroke();
    }
    ctx.restore();return;
  }
  if(bt==='bristle'){
    ctx.globalCompositeOperation='source-over';ctx.lineCap='round';ctx.lineJoin='round';
    const br=Math.max(4,Math.floor(sz*0.7));ctx.lineWidth=Math.max(0.8,sz/br*1.2);
    for(let b=0;b<br;b++){
      ctx.globalAlpha=op*bd.alpha*fl*(0.5+rng()*.5);ctx.strokeStyle=col;
      const r=sz*0.55,ox=(rng()-.5)*r*2,oy=(rng()-.5)*r*2;
      ctx.beginPath();ctx.moveTo(pts[0][0]+ox,pts[0][1]+oy);
      for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0]+ox*(0.85+rng()*.3),pts[i][1]+oy*(0.85+rng()*.3));
      ctx.stroke();
    }
    ctx.restore();return;
  }
  if(bt==='ink'){
    ctx.globalCompositeOperation='source-over';ctx.strokeStyle=col;ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([]);
    for(let i=1;i<pts.length;i++){
      const p=pressure(pts,i);ctx.globalAlpha=op*fl*Math.min(1,p*0.9+0.1);
      ctx.lineWidth=sz*p*bd.widthMult;ctx.beginPath();ctx.moveTo(pts[i-1][0],pts[i-1][1]);ctx.lineTo(pts[i][0],pts[i][1]);ctx.stroke();
    }
    ctx.restore();return;
  }
  if(bt==='pencil'){
    ctx.globalCompositeOperation='source-over';ctx.strokeStyle=col;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.setLineDash([]);ctx.lineWidth=sz*bd.widthMult;
    for(let pass=0;pass<2;pass++){
      ctx.globalAlpha=op*bd.alpha*fl*(pass===0?0.7:0.45);
      ctx.beginPath();ctx.moveTo(pts[0][0]+(rng()-.5)*1.5,pts[0][1]+(rng()-.5)*1.5);
      for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0]+(rng()-.5)*1.5,pts[i][1]+(rng()-.5)*1.5);
      ctx.stroke();
    }
    ctx.restore();return;
  }
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=op*bd.alpha*fl;
  ctx.strokeStyle=col;ctx.lineCap=bd.cap||'round';ctx.lineJoin='round';ctx.setLineDash([]);
  if(bd.pressure&&bt!=='marker'){
    for(let i=1;i<pts.length;i++){
      const p=pressure(pts,i);ctx.lineWidth=sz*bd.widthMult*p;
      ctx.beginPath();ctx.moveTo(pts[i-1][0],pts[i-1][1]);ctx.lineTo(pts[i][0],pts[i][1]);ctx.stroke();
    }
  }else{ctx.lineWidth=sz*bd.widthMult;drawPath(ctx,pts,sm);ctx.stroke();}
  ctx.restore();
}

async function renderPNG(strokes,cw,ch){
  cw=cw||DEFAULT_CW;ch=ch||DEFAULT_CH;
  const canvas=createCanvas(cw,ch);const ctx=canvas.getContext('2d');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,cw,ch);
  for(const s of(strokes||[])){
    if(s.brushType==='_snapshot'){
      if(s.pngB64){try{const img=await loadImage(Buffer.from(s.pngB64,'base64'));ctx.drawImage(img,0,0);}catch(e){console.error('[renderPNG] snapshot err',e);}}
    }else{renderStroke(ctx,s);}
  }
  return canvas.toBuffer('image/png');
}

// ── Game state ────────────────────────────────────────────────────────────────
const games=new Map();
function makeGame(chatId){
  return{chatId,phase:'idle',drawerTgId:null,drawerName:'',drawerWsId:null,
    word:null,hintRevealed:[],strokes:[],strokesUndo:[],roundStartTime:0,
    firstStrokeDrawn:false,lastHintAt:0,roundTimer:null,hintTimer:null,updateTimer:null,
    inviteMessageId:null,liveMessageId:null,scores:new Map(),clients:new Map(),
    canvasW:DEFAULT_CW,canvasH:DEFAULT_CH,
    retryAfterUntil:0};  // FIX S4: track 429 retry-after
}
function getOrMakeGame(chatId){
  const k=String(chatId);
  if(!games.has(k)){
    const row=stmtGet.get(k);
    if(row){const g=rowToGame(row);games.set(k,g);console.log(`[db] Loaded chatId=${k} phase=${g.phase} strokes=${g.strokes.length}`);return g;}
    games.set(k,makeGame(k));
  }
  return games.get(k);
}
function restoreAll(){
  const rows=stmtAll.all();
  for(const row of rows){const g=rowToGame(row);games.set(row.chat_id,g);}
  console.log(`[db] Restored ${rows.length} active game(s)`);
}
function broadcast(game,msg,skip=null){
  const d=JSON.stringify(msg);
  game.clients.forEach((c,id)=>{if(id!==skip&&c.ws.readyState===WebSocket.OPEN)c.ws.send(d);});
}
function sendWs(game,wsId,msg){
  const c=game.clients.get(wsId);
  if(c&&c.ws.readyState===WebSocket.OPEN)c.ws.send(JSON.stringify(msg));
}
function leaderboard(game){
  return Array.from(game.scores.entries()).sort((a,b)=>b[1]-a[1]).map(([name,score],i)=>({rank:i+1,name,score}));
}
function fmtLb(game){
  const lb=leaderboard(game);if(!lb.length)return'No scores yet.';
  const m=['🥇','🥈','🥉'];
  return lb.slice(0,10).map(({rank,name,score})=>`${m[rank-1]||`${rank}.`} *${name}* — ${score} pts`).join('\n');
}
function buildHint(word,rev){return word.split('').map((c,i)=>c===' '?'  ':(rev[i]?c:'_')).join(' ');}

function revealNextHint(game){
  if(game.phase!=='drawing'||!game.word)return null;
  const un=game.word.split('').map((_,i)=>i).filter(i=>game.word[i]!==' '&&!game.hintRevealed[i]);
  if(!un.length)return null;
  game.hintRevealed[un[Math.floor(Math.random()*un.length)]]=true;
  game.lastHintAt=Date.now();persistDebounced(game);
  const hint=buildHint(game.word,game.hintRevealed);
  broadcast(game,{type:'hint',hint});
  if(game.word.split('').every((c,i)=>c===' '||game.hintRevealed[i]))setTimeout(()=>endGame(game,null,'all_hints'),2000);
  return hint;
}

async function pushCanvas(game){
  if(game.phase!=='drawing'||!game.word)return;
  // FIX S4: respect Telegram 429 retry-after
  if(game.retryAfterUntil&&Date.now()<game.retryAfterUntil){
    const wait=game.retryAfterUntil-Date.now();
    console.log(`[pushCanvas] Rate limited, retry in ${Math.ceil(wait/1000)}s`);
    setTimeout(()=>pushCanvas(game),wait+200);
    return;
  }
  let png;try{png=await renderPNG(game.strokes,game.canvasW,game.canvasH);}catch(e){console.error('[render]',e.message);return;}
  const hint=buildHint(game.word,game.hintRevealed);
  const caption=`🎨 *${game.drawerName}* is drawing!\n🔤 \`${hint}\`  —  ${game.word.length} letters\n\n💬 Type your guess in the chat!`;
  const cd=Math.ceil((HINT_COOLDOWN_MS-(Date.now()-game.lastHintAt))/1000);
  const kb=Markup.inlineKeyboard([[Markup.button.callback(cd<=0?'💡 Hint':`⏳ Hint (${cd}s)`,`hint:${game.chatId}`)]]);
  try{
    if(game.liveMessageId){
      await bot.telegram.editMessageMedia(game.chatId,game.liveMessageId,null,{type:'photo',media:{source:png,filename:'drawing.png'},caption,parse_mode:'Markdown'},kb);
    }else{
      const m=await bot.telegram.sendPhoto(game.chatId,{source:png,filename:'drawing.png'},{caption,parse_mode:'Markdown',...kb});
      game.liveMessageId=m.message_id;persistDebounced(game);
    }
  }catch(e){
    if(/not modified/i.test(e.message))return;
    // FIX S4: handle 429 Too Many Requests
    if(e.response?.error_code===429||/too many requests/i.test(e.message)){
      const retryAfter=(e.response?.parameters?.retry_after||10)*1000+500;
      game.retryAfterUntil=Date.now()+retryAfter;
      console.warn(`[pushCanvas] 429 — backing off ${Math.ceil(retryAfter/1000)}s`);
      setTimeout(()=>pushCanvas(game),retryAfter);
      return;
    }
    console.error('[pushCanvas]',e.message);
    if(/not found|deleted|message to edit|socket hang up|ECONNRESET|ETIMEDOUT/i.test(e.message)){
      game.liveMessageId=null;
      try{const m=await bot.telegram.sendPhoto(game.chatId,{source:png,filename:'drawing.png'},{caption,parse_mode:'Markdown',...kb});game.liveMessageId=m.message_id;persistDebounced(game);}catch{}
    }
  }
}
function scheduleUpdate(game,delay=1500,force=false){
  if(!game.firstStrokeDrawn)return;
  if(force){clearTimeout(game.updateTimer);game.updateTimer=null;}
  if(game.updateTimer)return;
  game.updateTimer=setTimeout(async()=>{game.updateTimer=null;await pushCanvas(game);},delay);
}

async function endGame(game,guesser,reason){
  if(game.phase==='ended'||game.phase==='idle')return;
  game.phase='ended';
  clearTimeout(game.roundTimer);clearTimeout(game.hintTimer);clearTimeout(game.updateTimer);
  game.roundTimer=game.hintTimer=game.updateTimer=null;
  console.log(`[game] END chatId=${game.chatId} word=${game.word} guesser=${guesser||'none'} reason=${reason}`);
  if(game.drawerWsId)sendWs(game,game.drawerWsId,{type:'round_end',word:game.word,drawerName:game.drawerName,guesser:guesser||null,reason,board:leaderboard(game),drawerFinish:true});
  broadcast(game,{type:'round_end',word:game.word,drawerName:game.drawerName,guesser:guesser||null,reason,board:leaderboard(game)},game.drawerWsId);
  await postResult(game,guesser,reason);
  const savedScores=new Map(game.scores);
  game.word=null;game.hintRevealed=[];game.strokes=[];game.strokesUndo=[];
  game.firstStrokeDrawn=false;game.lastHintAt=0;game.drawerTgId=null;
  game.drawerName='';game.drawerWsId=null;game.inviteMessageId=null;game.scores=savedScores;
  setTimeout(()=>{game.phase='idle';persistGame(game);},3000);
}
async function postResult(game,guesser,reason){
  let png;try{png=await renderPNG(game.strokes,game.canvasW,game.canvasH);}catch(e){console.error('[postResult render]',e.message);}
  const lines=[`✅ *Round Over!*`,``,`🖌 Drawer: *${game.drawerName}*`,`🎯 Word: *${game.word}*`,
    guesser?`🏆 Guessed by: *${guesser}*`:reason==='all_hints'?`🔤 All hints revealed!`:reason==='stopped'?`🛑 Stopped.`:`😮 Round ended.`,
    ``,`📊 *Leaderboard:*`,fmtLb(game),``,`_Use /startgame to play again!_`].join('\n');
  try{
    if(game.liveMessageId&&png){await bot.telegram.editMessageMedia(game.chatId,game.liveMessageId,null,{type:'photo',media:{source:png,filename:`${game.word}.png`},caption:lines,parse_mode:'Markdown'},Markup.inlineKeyboard([]));}
    else if(png){await bot.telegram.sendPhoto(game.chatId,{source:png,filename:`${game.word}.png`},{caption:lines,parse_mode:'Markdown'});}
    else{await bot.telegram.sendMessage(game.chatId,lines,{parse_mode:'Markdown'});}
  }catch(e){console.error('[postResult]',e.message);try{await bot.telegram.sendMessage(game.chatId,lines,{parse_mode:'Markdown'});}catch{}}
}

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.command('startgame',async(ctx)=>{
  if(ctx.chat.type==='private')return ctx.reply('➕ Add me to a group!');
  const chatId=String(ctx.chat.id),game=getOrMakeGame(chatId);
  if(game.phase==='waiting_drawer')return ctx.reply('⏳ Already waiting for a drawer!');
  if(game.phase==='drawing')return ctx.reply('🎨 Game in progress!');
  game.phase='waiting_drawer';game.scores=new Map();game.strokes=[];game.strokesUndo=[];
  game.word=null;game.drawerTgId=null;game.drawerName='';game.drawerWsId=null;game.liveMessageId=null;
  if(!botUsername){try{const me=await bot.telegram.getMe();botUsername=me.username;}catch(e){return ctx.reply('Bot still starting.');}}
  const msg=await ctx.reply(`🎨 *Draw & Guess!*\n\nWho wants to draw? ✏️`,{parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('✏️ I Want to Draw!',`claim_draw:${chatId}`)]])});
  game.inviteMessageId=msg.message_id;persistGame(game);
  console.log(`[bot] /startgame chatId=${chatId}`);
});
bot.command('stopgame',async(ctx)=>{
  const game=games.get(String(ctx.chat.id));
  if(!game||game.phase==='idle')return ctx.reply('No active game.');
  await endGame(game,null,'stopped');ctx.reply('🛑 Stopped.');
});
bot.command('skipword',async(ctx)=>{
  const game=games.get(String(ctx.chat.id));
  if(!game||game.phase!=='drawing')return ctx.reply('No active round.');
  const nw=pickWord();game.word=nw;game.hintRevealed=new Array(nw.length).fill(false);
  game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;game.lastHintAt=0;
  clearTimeout(game.hintTimer);game.hintTimer=null;persistGame(game);
  if(game.drawerWsId)sendWs(game,game.drawerWsId,{type:'role',role:'drawer',word:nw,round:1,reconnect:false});
  broadcast(game,{type:'clear'},game.drawerWsId);broadcast(game,{type:'word_skipped',hint:buildHint(nw,game.hintRevealed)},game.drawerWsId);
  ctx.reply('✅ Word skipped!');
});
bot.command('leaderboard',async(ctx)=>{
  const game=games.get(String(ctx.chat.id));
  if(!game)return ctx.reply('No game.');
  ctx.reply(`📊 *Leaderboard*\n\n${fmtLb(game)}`,{parse_mode:'Markdown'});
});

bot.action(/^claim_draw:(.+)$/,async(ctx)=>{
  const chatId=ctx.match[1],game=games.get(chatId);
  if(!game)return ctx.answerCbQuery('❌ No active game.',{show_alert:true});
  if(game.phase!=='waiting_drawer')return ctx.answerCbQuery('❌ Already claimed!',{show_alert:true});
  const tgId=String(ctx.from.id),uname=`${ctx.from.first_name||''} ${ctx.from.last_name||''}`.trim()||ctx.from.username||'Artist';
  game.drawerTgId=tgId;game.drawerName=uname;game.phase='drawing';
  game.word=pickWord();game.hintRevealed=new Array(game.word.length).fill(false);
  game.strokes=[];game.strokesUndo=[];game.roundStartTime=Date.now();persistGame(game);
  console.log(`[game] Drawer: ${uname}(${tgId}) word=${game.word} chatId=${chatId}`);
  await ctx.answerCbQuery('✅ Open your canvas!');
  const url=`https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}?startapp=${encodeURIComponent(`${chatId}__${tgId}`)}`;
  try{await bot.telegram.editMessageText(chatId,game.inviteMessageId,null,
    `🎨 *${uname}* is drawing!\n🔤 \`${buildHint(game.word,game.hintRevealed)}\`  —  ${game.word.length} letters\n\n💬 Type your guess!`,
    {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.url('🖌 Open Canvas',url)]])});}catch(e){console.error('[editInvite]',e.message);}
});
bot.action(/^hint:(.+)$/,async(ctx)=>{
  const chatId=ctx.match[1],game=games.get(chatId);
  if(!game||game.phase!=='drawing')return ctx.answerCbQuery('❌ No active game!');
  if(!game.firstStrokeDrawn)return ctx.answerCbQuery('⏳ Wait for drawer to start!');
  const cd=Math.ceil((HINT_COOLDOWN_MS-(Date.now()-game.lastHintAt))/1000);
  if(cd>0)return ctx.answerCbQuery(`⏳ Wait ${cd}s!`);
  if(!game.word.split('').some((c,i)=>c!==' '&&!game.hintRevealed[i]))return ctx.answerCbQuery('🤷 No more hints!');
  const hint=revealNextHint(game);if(!hint)return ctx.answerCbQuery('No hints!');
  await ctx.answerCbQuery('💡 Hint revealed!');await pushCanvas(game);
});
bot.on('text',async(ctx)=>{
  if(ctx.chat.type==='private')return;
  const chatId=String(ctx.chat.id),game=games.get(chatId);
  if(!game||game.phase!=='drawing'||!game.word)return;
  const text=(ctx.message.text||'').trim();if(text.startsWith('/'))return;
  const name=`${ctx.from.first_name||''} ${ctx.from.last_name||''}`.trim()||ctx.from.username||'Player';
  const correct=text.toLowerCase()===game.word.toLowerCase();
  broadcast(game,{type:'guess',name,text,correct});
  if(correct){
    const hintsGiven=game.hintRevealed.filter(Boolean).length,elapsed=(Date.now()-game.roundStartTime)/1000;
    const timeBonus=Math.max(0,Math.floor((120-elapsed)/10)),pts=Math.max(10,100-hintsGiven*10+timeBonus);
    game.scores.set(name,(game.scores.get(name)||0)+pts);game.scores.set(game.drawerName,(game.scores.get(game.drawerName)||0)+50);
    broadcast(game,{type:'score_update',name,pts,timeBonus,board:leaderboard(game)});
    try{await bot.telegram.sendMessage(chatId,`🎉 *${name}* guessed it!\nWord was *${game.word}* ✅  +${pts} pts`,{parse_mode:'Markdown'});}catch{}
    await endGame(game,name,'guess');
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection',(ws,req)=>{
  const wsId=uuidv4(),url=new URL(req.url,'http://localhost');
  const chatId=url.searchParams.get('room')||'',name=url.searchParams.get('name')||'Artist',tgId=url.searchParams.get('userId')||'';
  if(!chatId){ws.close();return;}
  const game=getOrMakeGame(chatId);
  const isDrawer=tgId&&tgId===game.drawerTgId&&game.phase==='drawing';

  if(isDrawer&&game.drawerWsId){
    const old=game.clients.get(game.drawerWsId);
    if(old&&old.ws.readyState===WebSocket.OPEN){console.log(`[ws] Closing stale drawer for ${name}`);old.ws.close();}
    game.clients.delete(game.drawerWsId);game.drawerWsId=null;
  }
  game.clients.set(wsId,{ws,name,tgId});
  console.log(`[ws] +${name} tgId=${tgId} chatId=${chatId} clients=${game.clients.size} drawer=${isDrawer}`);

  if(isDrawer){
    game.drawerWsId=wsId;
    const isReconnect=game.strokes.length>0;
    ws.send(JSON.stringify({type:'init',strokes:game.strokes,players:game.clients.size,board:leaderboard(game)}));
    ws.send(JSON.stringify({type:'role',role:'drawer',word:game.word,round:1,reconnect:isReconnect}));
    console.log(`[ws] ${name} = DRAWER restored, word=${game.word} strokes=${game.strokes.length}`);
  }else{
    ws.send(JSON.stringify({type:'init',strokes:game.strokes,players:game.clients.size,board:leaderboard(game)}));
    if(game.phase==='drawing'){
      ws.send(JSON.stringify({type:'role',role:'guesser',hint:buildHint(game.word,game.hintRevealed),round:1}));
      ws.send(JSON.stringify({type:'status',message:`${game.drawerName} is drawing! Guess in chat!`}));
    }else{
      ws.send(JSON.stringify({type:'status',message:'No game running. Use /startgame in the group!'}));
    }
  }
  broadcast(game,{type:'player_joined',name,count:game.clients.size},wsId);

  ws.on('message',data=>{
    let msg;try{msg=JSON.parse(data);}catch{return;}
    switch(msg.type){
      case'canvas_size':
        if(wsId!==game.drawerWsId)return;
        if(msg.w>0&&msg.h>0&&msg.w<=4096&&msg.h<=4096){
          game.canvasW=msg.w;game.canvasH=msg.h;
          console.log(`[game] Canvas size set to ${msg.w}×${msg.h}`);
          persistDebounced(game,200);
        }
        break;
      case'draw':
        if(wsId!==game.drawerWsId)return;
        {
          // FIX S2: Use strokeId to replace partials — prevents N copies of same stroke being rendered
          const incoming=msg.stroke;
          if(incoming.strokeId){
            const existingIdx=game.strokes.findIndex(s=>s.strokeId===incoming.strokeId);
            if(existingIdx!==-1){
              // Replace the existing partial with the latest (longer) version
              game.strokes[existingIdx]=incoming;
            }else{
              // New stroke we haven't seen before
              game.strokesUndo.push(incoming);
              game.strokes.push(incoming);
            }
          }else{
            // No strokeId (legacy / fill): always append
            game.strokesUndo.push(incoming);
            game.strokes.push(incoming);
          }
          broadcast(game,{type:'draw',stroke:incoming},wsId);
          persistDebounced(game,600);
          // Flatten to snapshot every 60 strokes — keeps memory and init payload small
          if(game.strokes.length>0&&game.strokes.length%60===0){
            renderPNG(game.strokes,game.canvasW,game.canvasH).then(png=>{
              const pngB64=png.toString('base64');
              // FIX S6: mirror strokes and strokesUndo so undo/redo work after flatten
              const snap={brushType:'_snapshot',pngB64};
              game.strokes=[snap];
              game.strokesUndo=[snap];
              persistDebounced(game,200);
              console.log(`[game] Flattened strokes to snapshot`);
            }).catch(e=>console.error('[flatten]',e.message));
          }
          if(!game.firstStrokeDrawn){
            game.firstStrokeDrawn=true;game.roundStartTime=Date.now();
            persistDebounced(game,200);
            console.log(`[game] First stroke — pushing canvas to chat`);
            setTimeout(()=>pushCanvas(game),500);
          }else{scheduleUpdate(game);}
        }
        break;
      case'undo':
        if(wsId!==game.drawerWsId)return;
        if(game.strokes.length>0){
          game.strokes.pop();
          renderPNG(game.strokes,game.canvasW,game.canvasH).then(png=>{
            const b64='data:image/png;base64,'+png.toString('base64');
            // FIX S3: skip drawerWsId so drawer doesn't destroy their own layered canvas
            broadcast(game,{type:'snapshot',data:b64},game.drawerWsId);
          }).catch(()=>{});
          persistDebounced(game);
          scheduleUpdate(game,800,true);
        }
        break;
      case'redo':
        if(wsId!==game.drawerWsId)return;
        {const next=game.strokesUndo[game.strokes.length];
        if(next){
          game.strokes.push(next);
          renderPNG(game.strokes,game.canvasW,game.canvasH).then(png=>{
            const b64='data:image/png;base64,'+png.toString('base64');
            // FIX S3: skip drawerWsId here too
            broadcast(game,{type:'snapshot',data:b64},game.drawerWsId);
          }).catch(()=>{});
          persistDebounced(game);scheduleUpdate(game,800,true);
        }}
        break;
      case'clear':
        if(wsId!==game.drawerWsId)return;
        game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;
        broadcast(game,{type:'clear'});persistDebounced(game);
        break;
      case'snapshot':
        if(wsId!==game.drawerWsId)return;
        broadcast(game,{type:'snapshot',data:msg.data},wsId);
        break;
      case'guess':{
        const t=(msg.text||'').trim();if(!t)return;
        const ok=game.word&&t.toLowerCase()===game.word.toLowerCase();
        broadcast(game,{type:'guess',name,text:t,correct:ok});
        if(ok){
          const hintsGiven=game.hintRevealed.filter(Boolean).length,elapsed=(Date.now()-game.roundStartTime)/1000;
          const timeBonus=Math.max(0,Math.floor((120-elapsed)/10)),pts=Math.max(10,100-hintsGiven*10+timeBonus);
          game.scores.set(name,(game.scores.get(name)||0)+pts);game.scores.set(game.drawerName,(game.scores.get(game.drawerName)||0)+50);
          broadcast(game,{type:'score_update',name,pts,timeBonus,board:leaderboard(game)});
          bot.telegram.sendMessage(game.chatId,`🎉 *${name}* guessed it! Word was *${game.word}* ✅  +${pts} pts`,{parse_mode:'Markdown'}).catch(()=>{});
          endGame(game,name,'guess');
        }
        break;
      }
      case'change_word':
        if(wsId!==game.drawerWsId)return;
        {const nw=pickWord();game.word=nw;game.hintRevealed=new Array(nw.length).fill(false);
        game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;game.lastHintAt=0;persistGame(game);
        sendWs(game,wsId,{type:'role',role:'drawer',word:nw,round:1,reconnect:false});
        broadcast(game,{type:'clear'},wsId);broadcast(game,{type:'word_skipped',hint:buildHint(nw,game.hintRevealed)},wsId);}
        break;
      case'skip_word':
        if(wsId!==game.drawerWsId)return;
        {const nw=pickWord();game.word=nw;game.hintRevealed=new Array(nw.length).fill(false);
        game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;game.lastHintAt=0;
        clearTimeout(game.roundTimer);clearTimeout(game.hintTimer);game.roundTimer=game.hintTimer=null;
        persistGame(game);sendWs(game,wsId,{type:'role',role:'drawer',word:nw,round:1,reconnect:false});
        broadcast(game,{type:'clear'},wsId);broadcast(game,{type:'word_skipped',hint:buildHint(nw,game.hintRevealed)},wsId);}
        break;
      case'done_drawing':
        if(wsId!==game.drawerWsId)return;endGame(game,null,'done');break;
      // FIX S5: handle 'new_round' from the client start button
      case'new_round':
        {
          if(game.phase==='drawing')return; // already running
          if(game.phase==='waiting_drawer')return; // already waiting
          if(!botUsername)return;
          game.phase='waiting_drawer';
          game.scores=new Map();game.strokes=[];game.strokesUndo=[];
          game.word=null;game.drawerTgId=null;game.drawerName='';game.drawerWsId=null;game.liveMessageId=null;
          persistGame(game);
          const url=`https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}`;
          bot.telegram.sendMessage(game.chatId,
            `🎨 *Draw & Guess!*\n\nWho wants to draw? ✏️`,
            {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('✏️ I Want to Draw!',`claim_draw:${game.chatId}`)]])}
          ).then(m=>{game.inviteMessageId=m.message_id;persistDebounced(game);}).catch(e=>console.error('[new_round]',e.message));
          broadcast(game,{type:'status',message:'Waiting for a drawer… check the group!'});
        }
        break;
      case'get_logs':
        ws.send(JSON.stringify({type:'logs',logs:[]}));break;
    }
  });
  ws.on('close',()=>{
    game.clients.delete(wsId);
    console.log(`[ws] -${name} chatId=${chatId} remaining=${game.clients.size}`);
    broadcast(game,{type:'player_left',name,count:game.clients.size});
    if(wsId===game.drawerWsId){game.drawerWsId=null;console.log('[ws] Drawer disconnected — persisted, will restore on reconnect');}
  });
  ws.on('error',err=>{console.error(`[ws] ${name}:`,err.message);ws.close();});
});

// ── Launch ────────────────────────────────────────────────────────────────────
function tgPost(method,body){
  return new Promise((res,rej)=>{
    const https=require('https'),p=JSON.stringify(body);
    const r=https.request({hostname:'api.telegram.org',path:`/bot${BOT_TOKEN}/${method}`,method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(p)}},
      rr=>{let d='';rr.on('data',c=>d+=c);rr.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});});
    r.on('error',rej);r.write(p);r.end();
  });
}
async function launchBot(){
  try{
    const me=await bot.telegram.getMe();botUsername=me.username;console.log(`🤖 @${botUsername} ready`);
    await bot.telegram.setMyCommands([
      {command:'startgame',description:'Start a new Draw & Guess game'},
      {command:'stopgame',description:'Stop the current game'},
      {command:'skipword',description:'Skip current word'},
      {command:'leaderboard',description:'Show scores'},
    ]);
    const info=(await tgPost('getWebhookInfo',{})).result||{};
    if(info.url===WEBHOOK_URL){console.log('[bot] ✅ Webhook already active');}
    else{const r=await tgPost('setWebhook',{url:WEBHOOK_URL,drop_pending_updates:true,allowed_updates:['message','callback_query']});console.log('[bot] setWebhook:',r.description||JSON.stringify(r));}
  }catch(e){console.error('[bot] launchBot error:',e.message);setTimeout(launchBot,5000);}
}
server.listen(PORT,()=>{
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
  restoreAll();
  setTimeout(launchBot,1000);
  if(PUBLIC_URL){
    setInterval(()=>{
      const mod=PUBLIC_URL.startsWith('https')?require('https'):require('http');
      mod.get(`${PUBLIC_URL}/ping`,r=>console.log(`[keepalive] ${r.statusCode}`)).on('error',e=>console.warn('[keepalive]',e.message));
    },4*60*1000);
  }
});
process.on('unhandledRejection',r=>console.error('[unhandledRejection]',r?.message||r));
process.on('uncaughtException',e=>console.error('[uncaughtException]',e.message));
process.once('SIGINT',()=>{db.close();server.close();process.exit(0);});
process.once('SIGTERM',()=>{db.close();server.close();process.exit(0);});
