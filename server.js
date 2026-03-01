require('dotenv').config();
const express       = require('express');
const http          = require('http');
const WebSocket     = require('ws');
const path          = require('path');
const { v4: uuidv4 }       = require('uuid');
const { Telegraf, Markup } = require('telegraf');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const Database      = require('better-sqlite3');

const BOT_TOKEN         = process.env.BOT_TOKEN;
const PUBLIC_URL        = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PORT              = process.env.PORT || 3000;
const WEBAPP_SHORT_NAME = process.env.WEBAPP_SHORT_NAME || 'draw1';
const HINT_COOLDOWN_MS  = parseInt(process.env.HINT_COOLDOWN_MS || '30000');
const FIRST_HINT_MS = 30000; // 30s before first hint
const NEXT_HINT_MS  = 15000; // 15s between subsequent hints
function hintCooldownMs(game){
  return (game.hintRevealed||[]).filter(Boolean).length === 0 ? FIRST_HINT_MS : NEXT_HINT_MS;
}
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET || 'tgbot';
const DB_PATH           = process.env.DB_PATH || path.join(__dirname, 'drawbot.db');
const DEFAULT_CW = 1080, DEFAULT_CH = 1080;

if (!BOT_TOKEN)  { console.error('BOT_TOKEN missing');  process.exit(1); }
if (!PUBLIC_URL) { console.error('PUBLIC_URL missing'); process.exit(1); }

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    canvas_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'idle',
    drawer_tg_id TEXT, drawer_name TEXT, word TEXT,
    hint_revealed TEXT, strokes TEXT,
    round_start INTEGER DEFAULT 0, first_stroke INTEGER DEFAULT 0,
    last_hint_at INTEGER DEFAULT 0, pinned_msg_id INTEGER,
    canvas_w INTEGER DEFAULT 1080, canvas_h INTEGER DEFAULT 1080,
    status TEXT DEFAULT 'active',
    final_jpeg TEXT,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS games_chat ON games(chat_id);
`);
try{db.exec(`ALTER TABLE games ADD COLUMN pinned_msg_id INTEGER`);}catch{}
try{db.exec(`ALTER TABLE games ADD COLUMN canvas_w INTEGER DEFAULT 1080`);}catch{}
try{db.exec(`ALTER TABLE games ADD COLUMN canvas_h INTEGER DEFAULT 1080`);}catch{}
try{db.exec(`ALTER TABLE games ADD COLUMN canvas_id TEXT`);}catch{}
try{db.exec(`ALTER TABLE games ADD COLUMN status TEXT DEFAULT 'active'`);}catch{}
try{db.exec(`ALTER TABLE games ADD COLUMN final_jpeg TEXT`);}catch{}
// Migrate old rows: set canvas_id = chat_id if null (backward compat)
try{db.exec(`UPDATE games SET canvas_id=chat_id WHERE canvas_id IS NULL`);}catch{}
try{db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS games_canvas ON games(canvas_id)`);}catch{}
try{db.exec(`CREATE INDEX IF NOT EXISTS games_chat ON games(chat_id)`);}catch{}

const stmtUpsert = db.prepare(`
  INSERT INTO games (canvas_id,chat_id,phase,drawer_tg_id,drawer_name,word,hint_revealed,strokes,
    round_start,first_stroke,last_hint_at,pinned_msg_id,canvas_w,canvas_h,status,final_jpeg,updated_at)
  VALUES (@canvas_id,@chat_id,@phase,@drawer_tg_id,@drawer_name,@word,@hint_revealed,@strokes,
    @round_start,@first_stroke,@last_hint_at,@pinned_msg_id,@canvas_w,@canvas_h,@status,@final_jpeg,@updated_at)
  ON CONFLICT(canvas_id) DO UPDATE SET
    phase=excluded.phase,drawer_tg_id=excluded.drawer_tg_id,drawer_name=excluded.drawer_name,
    word=excluded.word,hint_revealed=excluded.hint_revealed,strokes=excluded.strokes,
    round_start=excluded.round_start,first_stroke=excluded.first_stroke,
    last_hint_at=excluded.last_hint_at,pinned_msg_id=excluded.pinned_msg_id,
    canvas_w=excluded.canvas_w,canvas_h=excluded.canvas_h,
    status=excluded.status,final_jpeg=excluded.final_jpeg,updated_at=excluded.updated_at
`);
const stmtGet    = db.prepare(`SELECT * FROM games WHERE canvas_id = ?`);
const stmtGetChat= db.prepare(`SELECT * FROM games WHERE chat_id = ? ORDER BY updated_at DESC`);
const stmtAll    = db.prepare(`SELECT * FROM games WHERE phase IN ('drawing','waiting_drawer') ORDER BY updated_at DESC`);
// Get active canvas for a chat (the one currently being drawn)
const stmtActive = db.prepare(`SELECT * FROM games WHERE chat_id=? AND phase='drawing' ORDER BY updated_at DESC LIMIT 1`);
// Get latest canvas (any phase) for a chat
const stmtLatest = db.prepare(`SELECT * FROM games WHERE chat_id=? AND phase IN ('drawing','waiting_drawer') ORDER BY updated_at DESC LIMIT 1`);

function persistGame(game){
  try{
    stmtUpsert.run({
      canvas_id:game.canvasId,chat_id:game.chatId,phase:game.phase,
      drawer_tg_id:game.drawerTgId||null,drawer_name:game.drawerName||'',
      word:game.word||null,hint_revealed:JSON.stringify(game.hintRevealed||[]),
      strokes:JSON.stringify(game.strokes||[]),
      round_start:game.roundStartTime||0,first_stroke:game.firstStrokeDrawn?1:0,
      last_hint_at:game.lastHintAt||0,pinned_msg_id:game.pinnedMsgId||null,
      canvas_w:game.canvasW||DEFAULT_CW,canvas_h:game.canvasH||DEFAULT_CH,
      status:game.status||'active',
      final_jpeg:game.finalJpeg||null,
      updated_at:Date.now(),
    });
  }catch(e){console.error('[db]',e.message);}
}
const _pt=new Map();
function persistDebounced(game,ms=500){
  const k=game.chatId;if(_pt.has(k))clearTimeout(_pt.get(k));
  _pt.set(k,setTimeout(()=>{_pt.delete(k);persistGame(game);},ms));
}

const app=express(),server=http.createServer(app),wss=new WebSocket.Server({server,path:'/ws'}),bot=new Telegraf(BOT_TOKEN);
let botUsername='';
app.use(express.json());
app.use((req,res,next)=>{if(req.path!=='/ping')console.log(`[http] ${req.method} ${req.path}`);next();});
app.get('/ping',(_,res)=>res.send('pong'));
const WEBHOOK_PATH=`/webhook/${WEBHOOK_SECRET}`,WEBHOOK_URL=`${PUBLIC_URL}${WEBHOOK_PATH}`;
app.post(WEBHOOK_PATH,async(req,res)=>{res.sendStatus(200);try{await bot.handleUpdate(req.body);}catch(e){console.error('[webhook]',e.message);}});
app.get(WEBHOOK_PATH,(_,res)=>res.send('Webhook active ✅'));
app.use(express.static(path.join(__dirname,'public')));

const WORDS=['cat','dog','sun','car','fish','bird','moon','tree','house','flower','apple','pizza','smile','heart','star','cake','boat','rain','snow','book','guitar','elephant','rainbow','castle','dragon','piano','volcano','butterfly','telescope','snowman','dinosaur','waterfall','helicopter','cactus','penguin','banana','scissors','telephone','umbrella','bicycle','submarine','tornado','lighthouse','compass','anchor','mermaid','unicorn','wizard','knight','ninja','pirate','robot','alien','crown','bridge'];
function pickWord(){return WORDS[Math.floor(Math.random()*WORDS.length)];}

function makePRNG(seed){let s=seed>>>0;return function(){s+=0x6D2B79F5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}

const BD={
  pen:{smoothing:.5,alpha:1.0,widthMult:1.0,cap:'round',pressure:true,flow:.8},
  pencil:{smoothing:.3,alpha:.75,widthMult:.8,cap:'round',pressure:true,flow:.7},
  pastel:{smoothing:.4,alpha:.8,widthMult:1.0,cap:'round',pressure:true,flow:.65},
  marker:{smoothing:.6,alpha:.55,widthMult:1.6,cap:'round',pressure:false,flow:.9},
  bristle:{smoothing:.2,alpha:.5,widthMult:1.0,cap:'round',pressure:true,flow:.6},
  ink:{smoothing:.7,alpha:1.0,widthMult:1.0,cap:'round',pressure:true,flow:1.0},
  watercolor:{smoothing:.6,alpha:.25,widthMult:2.0,cap:'round',pressure:true,flow:.5},
  airbrush:{smoothing:.0,alpha:.04,widthMult:1.0,cap:'round',pressure:false,flow:.7},
  line:{smoothing:.0,alpha:1.0,widthMult:1.0,cap:'round',pressure:false,flow:1.0},
  eraser:{smoothing:.5,alpha:1.0,widthMult:1.0,cap:'round',pressure:false,flow:1.0},
};
function smoothPts(pts,sm){
  if(pts.length<3||sm<0.05)return null;
  const s=sm*0.4,cp=[];
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
    const d1=Math.hypot(p1[0]-p0[0],p1[1]-p0[1])||1,d2=Math.hypot(p2[0]-p1[0],p2[1]-p1[1])||1,d3=Math.hypot(p3[0]-p2[0],p3[1]-p2[1])||1;
    const t1x=(p2[0]-p0[0])*s*(d2/(d1+d2)),t1y=(p2[1]-p0[1])*s*(d2/(d1+d2));
    const t2x=(p3[0]-p1[0])*s*(d2/(d2+d3)),t2y=(p3[1]-p1[1])*s*(d2/(d2+d3));
    cp.push([p1[0]+t1x,p1[1]+t1y,p2[0]-t2x,p2[1]-t2y]);
  }
  return cp;
}
function calcP(pts,pressures,i){
  if(pressures&&pressures[i]!=null&&pressures[i]>0)return Math.max(0.15,Math.min(1.2,pressures[i]*1.3));
  if(i===0||i>=pts.length-1)return 0.7;
  const dx=pts[i+1][0]-pts[i-1][0],dy=pts[i+1][1]-pts[i-1][1];
  return Math.max(0.2,Math.min(1.0,0.35+Math.sqrt(dx*dx+dy*dy)*0.013));
}
function getTaper(i,total){
  if(total<4)return 1;
  const head=Math.min(6,total*0.12),tail=Math.min(10,total*0.18);
  let t=1.0;
  if(i<head)t=Math.min(t,Math.sin((i/head)*Math.PI*0.5));
  if(i>total-tail)t=Math.min(t,Math.sin(((total-i)/tail)*Math.PI*0.5));
  return Math.max(0.04,t);
}
function drawPath(ctx,pts,sm){
  const cp=smoothPts(pts,sm);ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);
  if(!cp){for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);}
  else{for(let i=0;i<cp.length;i++)ctx.bezierCurveTo(cp[i][0],cp[i][1],cp[i][2],cp[i][3],pts[i+1][0],pts[i+1][1]);}
}
function renderStroke(ctx,s){
  const pts=s.points||[];
  if(s.brushType==='_snapshot')return;
  if(pts.length<1)return;
  if(pts.length<2&&s.brushType!=='fill'&&s.brushType!=='eyedrop')return;
  const bt=s.brushType||'pen',sz=s.size||6,col=s.color||'#000',
    op=s.opacity!=null?s.opacity:1.0,fl=s.flow!=null?s.flow:0.8,
    sm=s.smoothing!=null?s.smoothing:(BD[bt]?.smoothing??0.5),
    bd=BD[bt]||BD.pen,rng=makePRNG(s.seed||12345),prs=s.pressures||null,fd=s.fogDensity!=null?s.fogDensity:0.4;
  ctx.save();ctx.setLineDash([]);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  if(bt==='eraser'){
    // Server canvas is flat (no layers) — destination-out makes transparent → black in JPEG
    // Paint white instead to match the white canvas background
    ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
    ctx.strokeStyle='#ffffff';ctx.lineWidth=sz*(bd?.widthMult||1);
    ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([]);
    drawPath(ctx,pts,sm);ctx.stroke();ctx.restore();return;
  }
  if(bt==='line'){ctx.globalCompositeOperation='source-over';ctx.globalAlpha=op*fl;ctx.strokeStyle=col;ctx.lineWidth=sz;ctx.lineCap='round';ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);ctx.lineTo(pts[pts.length-1][0],pts[pts.length-1][1]);ctx.stroke();ctx.restore();return;}
  if(bt==='fill'){
    const[fx,fy]=pts[0],sx=Math.round(fx),sy=Math.round(fy),w=ctx.canvas.width,h=ctx.canvas.height;
    if(sx>=0&&sx<w&&sy>=0&&sy<h){
      const id=ctx.getImageData(0,0,w,h),d=id.data,ix=(sy*w+sx)*4;
      const sr=d[ix],sg=d[ix+1],sb=d[ix+2],sa=d[ix+3];
      const fr=parseInt(col.slice(1,3),16),fg=parseInt(col.slice(3,5),16),fb=parseInt(col.slice(5,7),16);
      if(!(sr===fr&&sg===fg&&sb===fb&&sa===255)){
        const match=i=>{const dr=d[i]-sr,dg=d[i+1]-sg,db=d[i+2]-sb,da=d[i+3]-sa;return dr*dr+dg*dg+db*db+da*da<=900;};
        const stack=[sx+sy*w],vis=new Uint8Array(w*h);vis[sx+sy*w]=1;
        while(stack.length){const pos=stack.pop(),x=pos%w,y=(pos/w)|0,i=pos*4;d[i]=fr;d[i+1]=fg;d[i+2]=fb;d[i+3]=255;[[x-1,y],[x+1,y],[x,y-1],[x,y+1]].forEach(([nx,ny])=>{if(nx>=0&&nx<w&&ny>=0&&ny<h&&!vis[nx+ny*w]&&match((nx+ny*w)*4)){vis[nx+ny*w]=1;stack.push(nx+ny*w);}});}
        ctx.putImageData(id,0,0);
      }
    }
    ctx.restore();return;
  }
  if(bt==='eyedrop'){ctx.restore();return;}
  if(bt==='airbrush'){
    const cr=parseInt(col.slice(1,3),16),cg=parseInt(col.slice(3,5),16),cb=parseInt(col.slice(5,7),16);
    const rad=Math.max(4,sz*(4.5-fd*2.0)),stepDist=Math.max(1,rad*0.15),peakA=op*(0.07+fd*0.20);
    const off=createCanvas(ctx.canvas.width,ctx.canvas.height),oc=off.getContext('2d');
    oc.globalCompositeOperation='source-over';
    const _blob=(bx,by)=>{try{const g=oc.createRadialGradient(bx,by,0,bx,by,rad);g.addColorStop(0,`rgba(${cr},${cg},${cb},${peakA.toFixed(4)})`);g.addColorStop(0.5,`rgba(${cr},${cg},${cb},${(peakA*0.25).toFixed(4)})`);g.addColorStop(1,`rgba(${cr},${cg},${cb},0)`);oc.fillStyle=g;oc.fillRect(bx-rad,by-rad,rad*2,rad*2);}catch(e){}};
    _blob(pts[0][0],pts[0][1]);let lpx=pts[0][0],lpy=pts[0][1];
    for(let i=1;i<pts.length;i++){const dx=pts[i][0]-lpx,dy=pts[i][1]-lpy,d=Math.hypot(dx,dy);if(d<0.5)continue;const steps=Math.ceil(d/stepDist);for(let s=1;s<=steps;s++)_blob(lpx+dx*(s/steps),lpy+dy*(s/steps));lpx=pts[i][0];lpy=pts[i][1];}
    ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.drawImage(off,0,0);ctx.restore();return;
  }
  if(bt==='watercolor'){
    const avgP=prs&&prs.length?prs.reduce((a,b)=>a+(b||0.5),0)/prs.length:0.7,pMult=Math.max(0.4,Math.min(1.4,avgP));
    ctx.strokeStyle=col;ctx.lineCap='round';ctx.lineJoin='round';ctx.globalCompositeOperation='source-over';
    for(let l=0;l<5;l++){ctx.globalAlpha=op*0.06*fl;ctx.lineWidth=sz*bd.widthMult*pMult*(0.75+rng()*0.5);ctx.beginPath();ctx.moveTo(pts[0][0]+(rng()-.5)*sz*.25,pts[0][1]+(rng()-.5)*sz*.25);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0]+(rng()-.5)*sz*.3,pts[i][1]+(rng()-.5)*sz*.3);ctx.stroke();}
    const edge=createCanvas(ctx.canvas.width,ctx.canvas.height),ec=edge.getContext('2d');
    ec.strokeStyle=col;ec.lineCap='round';ec.lineJoin='round';ec.lineWidth=sz*bd.widthMult*pMult+4;ec.globalAlpha=op*0.40*fl;
    ec.beginPath();ec.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)ec.lineTo(pts[i][0],pts[i][1]);ec.stroke();
    ec.globalCompositeOperation='destination-out';ec.lineWidth=sz*bd.widthMult*pMult-1;ec.globalAlpha=1;
    ec.beginPath();ec.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)ec.lineTo(pts[i][0],pts[i][1]);ec.stroke();
    ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.drawImage(edge,0,0);ctx.restore();return;
  }
  if(bt==='bristle'){
    const fiberCount=Math.max(6,Math.floor(sz*0.7)),spread=sz*0.65;
    const fibers=Array.from({length:fiberCount},()=>({ox:(rng()-.5)*spread*2,oy:(rng()-.5)*spread*2,stiffness:0.4+rng()*0.6,thick:0.6+rng()*0.8}));
    ctx.lineCap='round';ctx.lineJoin='round';ctx.globalCompositeOperation='source-over';
    for(let b=0;b<fiberCount;b++){const f=fibers[b];for(let i=1;i<pts.length;i++){const p=calcP(pts,prs,i),lw=Math.max(0.4,f.thick*sz/fiberCount*1.6*p);const nx=pts[Math.min(i+1,pts.length-1)][0],ny=pts[Math.min(i+1,pts.length-1)][1],px2=pts[Math.max(i-1,0)][0],py2=pts[Math.max(i-1,0)][1];const vx=(nx-px2)*0.15*(1-f.stiffness),vy=(ny-py2)*0.15*(1-f.stiffness);const taper=getTaper(i,pts.length);const fx0=pts[i-1][0]+(f.ox+vx)*taper,fy0=pts[i-1][1]+(f.oy+vy)*taper,fx1=pts[i][0]+(f.ox+vx)*taper,fy1=pts[i][1]+(f.oy+vy)*taper;ctx.globalAlpha=Math.min(0.95,op*bd.alpha*fl*f.stiffness*taper*1.4);ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.beginPath();ctx.moveTo(fx0,fy0);ctx.lineTo(fx1,fy1);ctx.stroke();}}
    ctx.restore();return;
  }
  if(bt==='ink'){
    ctx.strokeStyle=col;ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([]);
    for(let i=1;i<pts.length;i++){const p=calcP(pts,prs,i),taper=getTaper(i,pts.length);ctx.globalAlpha=op*fl*Math.min(1,p*0.85+0.15)*taper;ctx.lineWidth=sz*p*bd.widthMult*taper;ctx.beginPath();ctx.moveTo(pts[i-1][0],pts[i-1][1]);ctx.lineTo(pts[i][0],pts[i][1]);ctx.stroke();}
    ctx.restore();return;
  }
  if(bt==='pencil'){
    ctx.fillStyle=col;const grainSz=Math.max(0.8,sz*0.13),coverage=0.6*fl;
    for(let i=1;i<pts.length;i++){const taper=getTaper(i,pts.length),p=calcP(pts,prs,i),hw=sz*0.5*bd.widthMult*taper*p;const dist=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);const steps=Math.max(1,Math.ceil(dist/(grainSz*1.2)));for(let st=0;st<steps;st++){const t=st/steps,sx=pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t,sy=pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t;const pN=Math.floor(hw*2*coverage);for(let g=0;g<pN;g++){const ox=(rng()-.5)*hw*2,oy=(rng()-.5)*hw*2;if((ox*ox)/(hw*hw)+(oy*oy)/(hw*0.45*hw*0.45)>1)continue;const edgeDist=Math.sqrt((ox*ox+oy*oy)/(hw*hw));ctx.globalAlpha=op*(0.25+rng()*0.55)*(1-edgeDist*0.4)*taper;ctx.fillRect(sx+ox,sy+oy,grainSz,grainSz);}}}
    ctx.restore();return;
  }
  if(bt==='pastel'){
    const grainSz=Math.max(1.2,sz*0.18),coverage=0.55*fl;
    const cr=parseInt(col.slice(1,3),16),cg=parseInt(col.slice(3,5),16),cb=parseInt(col.slice(5,7),16);
    for(let i=1;i<pts.length;i++){const taper=getTaper(i,pts.length),p=calcP(pts,prs,i),hw=sz*0.5*bd.widthMult*taper*p*1.2;const dist=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);const steps=Math.max(1,Math.ceil(dist/(grainSz*1.5)));for(let st=0;st<steps;st++){const t=st/steps,sx=pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t,sy=pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t;const pN=Math.floor(hw*2.2*coverage);for(let g=0;g<pN;g++){const ang=rng()*Math.PI*2,rx=hw*(0.9+rng()*0.4),ry=hw*(0.4+rng()*0.3),ox=Math.cos(ang)*rx,oy=Math.sin(ang)*ry;if((ox*ox)/(hw*hw)+(oy*oy)/(hw*hw)>1.2)continue;const edgeDist=Math.min(1,Math.sqrt((ox*ox+oy*oy)/(hw*hw)));const grain=0.15+rng()*0.45,alphaBase=op*grain*(1-edgeDist*0.5)*taper;const varR=cr+(rng()-.5)*18,varG=cg+(rng()-.5)*18,varB=cb+(rng()-.5)*18;ctx.fillStyle=`rgba(${~~Math.max(0,Math.min(255,varR))},${~~Math.max(0,Math.min(255,varG))},${~~Math.max(0,Math.min(255,varB))},1)`;ctx.globalAlpha=alphaBase;const gW=grainSz*(0.6+rng()*1.4),gH=grainSz*(0.3+rng()*0.6);ctx.fillRect(sx+ox-gW/2,sy+oy-gH/2,gW,gH);}}}
    ctx.restore();return;
  }
  ctx.strokeStyle=col;ctx.lineCap=bd.cap||'round';ctx.lineJoin='round';ctx.setLineDash([]);
  if(bd.pressure&&bt!=='marker'&&prs&&prs.length>1){
    const cp=smoothPts(pts,sm);
    for(let i=1;i<pts.length;i++){const p=calcP(pts,prs,i),taper=getTaper(i,pts.length);ctx.globalAlpha=op*bd.alpha*fl;ctx.lineWidth=Math.max(0.5,sz*bd.widthMult*p*taper);ctx.beginPath();if(cp&&cp[i-1]){ctx.moveTo(pts[i-1][0],pts[i-1][1]);ctx.bezierCurveTo(cp[i-1][0],cp[i-1][1],cp[i-1][2],cp[i-1][3],pts[i][0],pts[i][1]);}else{ctx.moveTo(pts[i-1][0],pts[i-1][1]);ctx.lineTo(pts[i][0],pts[i][1]);}ctx.stroke();}
  }else{ctx.globalAlpha=op*bd.alpha*fl;ctx.lineWidth=sz*bd.widthMult;drawPath(ctx,pts,sm);ctx.stroke();}
  ctx.restore();
}

// ── Virtual guesser canvas — incremental, O(1) per stroke ─────────────────
function makeVC(w,h){const canvas=createCanvas(w,h),ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);return{canvas,ctx};}
function vcPaint(game,stroke){
  if(!game.vc)return;
  if(stroke.brushType==='_snapshot'){
    if(stroke.pngB64){loadImage(Buffer.from(stroke.pngB64,'base64')).then(img=>{game.vc.ctx.fillStyle='#ffffff';game.vc.ctx.fillRect(0,0,game.canvasW,game.canvasH);game.vc.ctx.drawImage(img,0,0);}).catch(()=>{});}
    return;
  }
  renderStroke(game.vc.ctx,stroke);
}
function vcJpeg(game){if(!game.vc)return null;try{return game.vc.canvas.toBuffer('image/jpeg',{quality:0.92});}catch(e){console.error('[vc]',e.message);return null;}}
async function vcRebuild(game){
  if(!game.vc)return;
  game.vc.ctx.fillStyle='#ffffff';game.vc.ctx.fillRect(0,0,game.canvasW,game.canvasH);
  for(const s of game.strokes){
    if(s.brushType==='_snapshot'&&s.pngB64){try{const img=await loadImage(Buffer.from(s.pngB64,'base64'));game.vc.ctx.drawImage(img,0,0);}catch{}}
    else{renderStroke(game.vc.ctx,s);}
  }
}

// games Map: chatId → game (one session object per chat, long-lived)
// canvasId is a field inside game — changes on each new_canvas without creating a new object
// This means WS closures always reference the correct game object — no migration needed
const games=new Map();

function makeGame(chatId){
  return{chatId,canvasId:chatId,phase:'idle',drawerTgId:null,drawerName:'',
    drawerWsId:null,word:null,hintRevealed:[],strokes:[],strokesUndo:[],
    roundStartTime:0,firstStrokeDrawn:false,lastHintAt:0,roundTimer:null,
    hintTimer:null,updateTimer:null,pinnedMsgId:null,scores:new Map(),
    clients:new Map(),canvasW:DEFAULT_CW,canvasH:DEFAULT_CH,
    retryAfterUntil:0,vc:null,status:'active',finalJpeg:null};
}
function rowToGame(row){
  const g=makeGame(row.chat_id);
  g.canvasId=row.canvas_id||row.chat_id;
  g.phase=row.phase;g.drawerTgId=row.drawer_tg_id||null;g.drawerName=row.drawer_name||'';
  g.word=row.word||null;g.hintRevealed=JSON.parse(row.hint_revealed||'[]');
  g.strokes=JSON.parse(row.strokes||'[]');g.strokesUndo=[];
  g.roundStartTime=row.round_start||0;g.firstStrokeDrawn=row.first_stroke===1;
  g.lastHintAt=row.last_hint_at||0;g.pinnedMsgId=row.pinned_msg_id||null;
  g.canvasW=row.canvas_w||DEFAULT_CW;g.canvasH=row.canvas_h||DEFAULT_CH;
  g.status=row.status||'active';g.finalJpeg=row.final_jpeg||null;
  if(g.strokes.length>0&&g.phase==='drawing'){g.vc=makeVC(g.canvasW,g.canvasH);vcRebuild(g).catch(()=>{});}
  return g;
}
function getOrMakeGame(chatId){
  const k=String(chatId);
  if(games.has(k))return games.get(k);
  // Try DB — latest row for this chat
  const row=stmtLatest.get(k);
  if(row){const g=rowToGame(row);games.set(k,g);return g;}
  // Brand new
  const g=makeGame(k);games.set(k,g);return g;
}
function restoreAll(){
  const rows=stmtAll.all();
  const seen=new Set();
  for(const row of rows){
    const k=row.chat_id;
    if(seen.has(k))continue; // stmtAll ordered by updated_at DESC — take latest per chat
    seen.add(k);
    const g=rowToGame(row);games.set(k,g);
  }
  console.log(`[db] Restored ${seen.size} game(s)`);
}
function broadcast(game,msg,skip=null){const d=JSON.stringify(msg);game.clients.forEach((c,id)=>{if(id!==skip&&c.ws.readyState===WebSocket.OPEN)c.ws.send(d);});}
function sendWs(game,wsId,msg){const c=game.clients.get(wsId);if(c&&c.ws.readyState===WebSocket.OPEN)c.ws.send(JSON.stringify(msg));}
function leaderboard(game){return Array.from(game.scores.entries()).sort((a,b)=>b[1]-a[1]).map(([name,score],i)=>({rank:i+1,name,score}));}
function fmtLb(game){const lb=leaderboard(game);if(!lb.length)return'No scores yet.';const m=['🥇','🥈','🥉'];return lb.slice(0,10).map(({rank,name,score})=>`${m[rank-1]||`${rank}.`} *${name}* — ${score} pts`).join('\n');}
function buildHint(word,rev){return word.split('').map((c,i)=>c===' '?'  ':(rev[i]?c:'_')).join(' ');}
function hintCaption(game){
  const hint=buildHint(game.word,game.hintRevealed);
  const cd=Math.ceil((hintCooldownMs(game)-(Date.now()-game.lastHintAt))/1000);
  // Before first stroke: no hint button yet, just letter count
  const hintBtn=game.firstStrokeDrawn
    ? Markup.button.callback(cd<=0?'💡 Hint':`⏳ Hint (${cd}s)`,`hint:${game.chatId}`)
    : Markup.button.callback(`${game.word.length} letters — drawing starting…`,`noop:${game.chatId}`);
  const canvasUrl=botUsername
    ? `https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}?startapp=${encodeURIComponent(game.chatId+'__'+game.drawerTgId)}`
    : null;
  const rows=canvasUrl ? [[hintBtn],[Markup.button.url('🖌 Open Canvas',canvasUrl)]] : [[hintBtn]];
  return{
    caption:`🎨 *${game.drawerName}* is drawing!\n🔤 \`${hint}\`  —  ${game.word.length} letters\n\n💬 Type your guess in chat!`,
    kb:Markup.inlineKeyboard(rows)
  };
}

async function pushCanvas(game){
  if(game.phase!=='drawing'||!game.word)return;
  if(game.retryAfterUntil&&Date.now()<game.retryAfterUntil){setTimeout(()=>pushCanvas(game),game.retryAfterUntil-Date.now()+200);return;}
  const jpeg=vcJpeg(game);if(!jpeg){console.warn('[push] no vc');return;}
  const{caption,kb}=hintCaption(game);
  try{
    if(game.pinnedMsgId){await bot.telegram.editMessageMedia(game.chatId,game.pinnedMsgId,null,{type:'photo',media:{source:jpeg,filename:'drawing.jpg'},caption,parse_mode:'Markdown'},kb);}
    else{const m=await bot.telegram.sendPhoto(game.chatId,{source:jpeg,filename:'drawing.jpg'},{caption,parse_mode:'Markdown',...kb});game.pinnedMsgId=m.message_id;try{await bot.telegram.pinChatMessage(game.chatId,m.message_id,{disable_notification:true});}catch{}persistDebounced(game);}
  }catch(e){
    if(/not modified/i.test(e.message))return;
    if(e.response?.error_code===429||/too many requests/i.test(e.message)){const ra=(e.response?.parameters?.retry_after||10)*1000+500;game.retryAfterUntil=Date.now()+ra;setTimeout(()=>pushCanvas(game),ra);return;}
    if(/not found|deleted|ECONNRESET|ETIMEDOUT/i.test(e.message)){game.pinnedMsgId=null;try{const m=await bot.telegram.sendPhoto(game.chatId,{source:jpeg,filename:'drawing.jpg'},{caption,parse_mode:'Markdown',...kb});game.pinnedMsgId=m.message_id;try{await bot.telegram.pinChatMessage(game.chatId,m.message_id,{disable_notification:true});}catch{}persistDebounced(game);}catch{}}
  }
}
function scheduleUpdate(game,delay=3000,force=false){
  if(!game.firstStrokeDrawn)return;
  if(force){clearTimeout(game.updateTimer);game.updateTimer=null;}
  if(game.updateTimer)return;
  game.updateTimer=setTimeout(async()=>{game.updateTimer=null;await pushCanvas(game);},delay);
}

function revealNextHint(game){
  if(game.phase!=='drawing'||!game.word)return null;
  const un=game.word.split('').map((_,i)=>i).filter(i=>game.word[i]!==' '&&!game.hintRevealed[i]);
  if(!un.length)return null;
  game.hintRevealed[un[Math.floor(Math.random()*un.length)]]=true;game.lastHintAt=Date.now();persistDebounced(game);
  const hint=buildHint(game.word,game.hintRevealed);broadcast(game,{type:'hint',hint});
  if(game.word.split('').every((c,i)=>c===' '||game.hintRevealed[i]))setTimeout(()=>endGame(game,null,'all_hints'),2000);
  return hint;
}

async function postResult(game,guesser,reason){
  // Wait up to 2s for browser-sourced final_image (pixel-perfect colors)
  const jpeg = await new Promise(resolve=>{
    if(game.finalJpeg){resolve(Buffer.from(game.finalJpeg,'base64'));return;}
    const deadline=Date.now()+2000;
    const poll=setInterval(()=>{
      if(game.finalJpeg){clearInterval(poll);resolve(Buffer.from(game.finalJpeg,'base64'));return;}
      if(Date.now()>=deadline){clearInterval(poll);resolve(vcJpeg(game));console.warn('[postResult] finalJpeg timeout — using vcJpeg fallback');}
    },100);
  });
  const lines=[`✅ *Round Over!*`,``,`🖌 Drawer: *${game.drawerName}*`,`🎯 Word: *${game.word}*`,
    guesser?`🏆 Guessed by: *${guesser}*`:reason==='all_hints'?`🔤 All hints revealed!`:reason==='stopped'?`🛑 Stopped.`:`😮 Round ended.`,
    ``,`📊 *Leaderboard:*`,fmtLb(game),``,`_Use /startgame to play again!_`].join('\n');
  try{
    if(reason==='guess'&&botUsername&&game.drawerTgId){
      // Guess case: post result as a NEW message with "Continue Drawing" button
      // Keep the pinned message alive (drawer may want to reopen canvas)
      const continueUrl=`https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}?startapp=${encodeURIComponent(`${game.chatId}__${game.drawerTgId}`)}`;
      const kb=Markup.inlineKeyboard([[Markup.button.url('🖌 Continue Drawing',continueUrl)],[Markup.button.callback('▶ New Round',`new_round_btn:${game.chatId}`)]]);
      if(jpeg){await bot.telegram.sendPhoto(game.chatId,{source:jpeg,filename:`${game.word}.jpg`},{caption:lines,parse_mode:'Markdown',...kb});}
      else{await bot.telegram.sendMessage(game.chatId,lines,{parse_mode:'Markdown',...kb});}
      // Also update the pinned message to show the result image with continue button
      if(game.pinnedMsgId&&jpeg){
        try{await bot.telegram.editMessageMedia(game.chatId,game.pinnedMsgId,null,{type:'photo',media:{source:jpeg,filename:`${game.word}.jpg`},caption:`🖌 *${game.drawerName}*'s canvas\n\nRound over! Tap to continue drawing.`,parse_mode:'Markdown'},Markup.inlineKeyboard([[Markup.button.url('🖌 Continue Drawing',continueUrl)]]));}catch{}
      }
    } else {
      // Done/timeout/stopped: replace pinned message with result
      if(game.pinnedMsgId&&jpeg){await bot.telegram.editMessageMedia(game.chatId,game.pinnedMsgId,null,{type:'photo',media:{source:jpeg,filename:`${game.word}.jpg`},caption:lines,parse_mode:'Markdown'},Markup.inlineKeyboard([]));}
      else if(jpeg){await bot.telegram.sendPhoto(game.chatId,{source:jpeg,filename:`${game.word}.jpg`},{caption:lines,parse_mode:'Markdown'});}
      else{await bot.telegram.sendMessage(game.chatId,lines,{parse_mode:'Markdown'});}
    }
  }catch(e){console.error('[postResult]',e.message);try{await bot.telegram.sendMessage(game.chatId,lines,{parse_mode:'Markdown'});}catch{}}
}

async function endGame(game,guesser,reason){
  if(game.phase==='ended'||game.phase==='idle')return;
  game.phase='ended';game.status=guesser?'completed':'pending_guess';
  clearTimeout(game.roundTimer);clearTimeout(game.hintTimer);clearTimeout(game.updateTimer);
  game.roundTimer=game.hintTimer=game.updateTimer=null;
  console.log(`[game] END chatId=${game.chatId} canvasId=${game.canvasId} word=${game.word} guesser=${guesser||'none'} reason=${reason}`);
  if(game.drawerWsId)sendWs(game,game.drawerWsId,{type:'round_end',word:game.word,drawerName:game.drawerName,guesser:guesser||null,reason,board:leaderboard(game),drawerFinish:true,keepDrawing:reason==='guess'});
  broadcast(game,{type:'round_end',word:game.word,drawerName:game.drawerName,guesser:guesser||null,reason,board:leaderboard(game)},game.drawerWsId);
  await postResult(game,guesser,reason);
  const savedScores=new Map(game.scores);
  // On guess: keep pinnedMsgId alive so drawer can reopen canvas; clear it otherwise
  const keepPinned=reason==='guess';
  game.vc=null;game.word=null;game.hintRevealed=[];game.strokes=[];game.strokesUndo=[];
  game.firstStrokeDrawn=false;game.lastHintAt=0;game.drawerTgId=null;game.drawerName='';
  game.drawerWsId=null;if(!keepPinned)game.pinnedMsgId=null;game.scores=savedScores;
  setTimeout(()=>{
    game.phase='idle';
    game.canvasId=game.chatId;
    game.pinnedMsgId=null; // clear after 3s regardless
    persistGame(game);
  },3000);
}

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.command('startgame',async(ctx)=>{
  if(ctx.chat.type==='private')return ctx.reply('➕ Add me to a group!');
  const chatId=String(ctx.chat.id),game=getOrMakeGame(chatId);
  if(game.phase==='waiting_drawer')return ctx.reply('⏳ Already waiting for a drawer!');
  if(game.phase==='drawing')return ctx.reply('🎨 Game in progress! Use /stopgame to end it.');
  game.phase='waiting_drawer';game.scores=new Map();game.strokes=[];game.strokesUndo=[];game.word=null;game.drawerTgId=null;game.drawerName='';game.drawerWsId=null;game.pinnedMsgId=null;game.vc=null;
  if(!botUsername){try{const me=await bot.telegram.getMe();botUsername=me.username;}catch(e){return ctx.reply('Bot still starting.');}}
  const msg=await ctx.reply(`🎨 *Draw & Guess!*\n\nWho wants to draw? ✏️`,{parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('✏️ I Want to Draw!',`claim_draw:${chatId}`)]])});
  game.pinnedMsgId=msg.message_id;
  try{await bot.telegram.pinChatMessage(chatId,msg.message_id,{disable_notification:true});}catch{}
  persistGame(game);
});
bot.command('stopgame',async(ctx)=>{const game=getOrMakeGame(String(ctx.chat.id));if(!game||game.phase==='idle')return ctx.reply('No active game.');await endGame(game,null,'stopped');ctx.reply('🛑 Stopped.');});
bot.command('skipword',async(ctx)=>{
  const game=getOrMakeGame(String(ctx.chat.id));if(!game||game.phase!=='drawing')return ctx.reply('No active round.');
  const nw=pickWord();game.word=nw;game.hintRevealed=new Array(nw.length).fill(false);game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;game.lastHintAt=0;
  if(game.vc){game.vc.ctx.fillStyle='#ffffff';game.vc.ctx.fillRect(0,0,game.canvasW,game.canvasH);}
  clearTimeout(game.hintTimer);game.hintTimer=null;persistGame(game);
  if(game.drawerWsId)sendWs(game,game.drawerWsId,{type:'role',role:'drawer',word:nw,round:1,reconnect:false});
  broadcast(game,{type:'clear'},game.drawerWsId);broadcast(game,{type:'word_skipped',hint:buildHint(nw,game.hintRevealed)},game.drawerWsId);ctx.reply('✅ Word skipped!');
});
bot.command('leaderboard',async(ctx)=>{const game=getOrMakeGame(String(ctx.chat.id));if(!game)return ctx.reply('No game.');ctx.reply(`📊 *Leaderboard*\n\n${fmtLb(game)}`,{parse_mode:'Markdown'});});

bot.action(/^claim_draw:(.+)$/,async(ctx)=>{
  const chatId=ctx.match[1];
  // Always get from Map — claim_draw button only exists after /startgame which puts game in Map
  const game=games.get(String(chatId));
  if(!game||game.phase!=='waiting_drawer')return ctx.answerCbQuery('❌ Game already started or expired!',{show_alert:true});
  const tgId=String(ctx.from.id),uname=`${ctx.from.first_name||''} ${ctx.from.last_name||''}`.trim()||ctx.from.username||'Artist';
  game.drawerTgId=tgId;game.drawerName=uname;game.phase='drawing';
  game.word=pickWord();game.hintRevealed=new Array(game.word.length).fill(false);
  game.strokes=[];game.strokesUndo=[];game.roundStartTime=Date.now();
  game.vc=makeVC(game.canvasW,game.canvasH);
  persistGame(game);await ctx.answerCbQuery('✅ Open your canvas!');
  // canvasId in URL so drawer reconnects to correct canvas always
  const url=`https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}?startapp=${encodeURIComponent(`${chatId}__${tgId}`)}`;
  try{await bot.telegram.editMessageText(chatId,game.pinnedMsgId,null,
    `🎨 *${uname}* is drawing!\n🔤 \`${buildHint(game.word,game.hintRevealed)}\`  —  ${game.word.length} letters\n\n💬 Type your guess!`,
    {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.url('🖌 Open Canvas',url)],[Markup.button.callback('💡 Hint',`hint:${chatId}`)]])});}
  catch(e){console.error('[editInvite]',e.message);}
});

bot.action(/^noop:.+$/,async(ctx)=>{await ctx.answerCbQuery('⏳ Wait for the first stroke!');});
bot.action(/^new_round_btn:(.+)$/,async(ctx)=>{
  const chatId=ctx.match[1],game=getOrMakeGame(chatId);
  await ctx.answerCbQuery('Starting new round…');
  if(game.phase==='waiting_drawer'||game.phase==='drawing')return;
  game.phase='waiting_drawer';game.scores=new Map();game.strokes=[];game.strokesUndo=[];
  game.word=null;game.drawerTgId=null;game.drawerName='';game.drawerWsId=null;
  game.pinnedMsgId=null;game.vc=null;game.finalJpeg=null;game.status='active';
  persistGame(game);
  bot.telegram.sendMessage(chatId,`🎨 *Draw & Guess!*\n\nWho wants to draw? ✏️`,
    {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('✏️ I Want to Draw!',`claim_draw:${chatId}`)]])})
    .then(m=>{game.pinnedMsgId=m.message_id;bot.telegram.pinChatMessage(chatId,m.message_id,{disable_notification:true}).catch(()=>{});persistDebounced(game);})
    .catch(e=>console.error('[new_round_btn]',e.message));
  broadcast(game,{type:'status',message:'Waiting for a drawer… check the group!'});
});
bot.action(/^hint:(.+)$/,async(ctx)=>{
  // canvasId-based routing for hints
  const chatId=ctx.match[1];
  const game=getOrMakeGame(chatId);
  if(!game||game.phase!=='drawing')return ctx.answerCbQuery('❌ No active game!');
  if(!game.firstStrokeDrawn)return ctx.answerCbQuery('⏳ Wait for drawer to start!');
  const cd=Math.ceil((hintCooldownMs(game)-(Date.now()-game.lastHintAt))/1000);
  if(cd>0)return ctx.answerCbQuery(`⏳ Wait ${cd}s!`);
  if(!game.word.split('').some((c,i)=>c!==' '&&!game.hintRevealed[i]))return ctx.answerCbQuery('🤷 No more hints!');
  const hint=revealNextHint(game);if(!hint)return ctx.answerCbQuery('No hints!');
  await ctx.answerCbQuery('💡 Hint revealed!');scheduleUpdate(game,200,true);
});

bot.on('text',async(ctx)=>{
  if(ctx.chat.type==='private')return;
  const chatId=String(ctx.chat.id),game=getOrMakeGame(chatId);
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
  const chatId=url.searchParams.get('room')||'';
  const canvasId=url.searchParams.get('canvas')||chatId; // specific canvas or default to chat
  const name=url.searchParams.get('name')||'Artist';
  const tgId=url.searchParams.get('userId')||'';
  if(!chatId){ws.close();return;}
  // Route to specific canvas if given, else active game for chat
  const game=getOrMakeGame(chatId);
  // If client specified a canvasId and it doesn't match current, 
  // they may be reconnecting to an old finished canvas — still use current game
  const isDrawer=tgId&&tgId===game.drawerTgId&&game.phase==='drawing';
  if(isDrawer&&game.drawerWsId){const old=game.clients.get(game.drawerWsId);if(old&&old.ws.readyState===WebSocket.OPEN)old.ws.close();game.clients.delete(game.drawerWsId);game.drawerWsId=null;}
  game.clients.set(wsId,{ws,name,tgId});
  // game is always keyed by chatId — no separate tracking needed
  console.log(`[ws] +${name} chatId=${chatId} canvasId=${game.canvasId} clients=${game.clients.size} drawer=${isDrawer}`);
  ws.send(JSON.stringify({type:'init',strokes:game.strokes,players:game.clients.size,board:leaderboard(game),canvasId:game.canvasId}));
  if(isDrawer){game.drawerWsId=wsId;ws.send(JSON.stringify({type:'role',role:'drawer',word:game.word,round:1,reconnect:game.strokes.length>0}));}
  else if(game.phase==='drawing'){ws.send(JSON.stringify({type:'role',role:'guesser',hint:buildHint(game.word,game.hintRevealed),round:1}));ws.send(JSON.stringify({type:'status',message:`${game.drawerName} is drawing! Guess in chat!`}));}
  else if(tgId&&tgId===game.drawerTgId&&(game.phase==='ended'||game.phase==='idle')){
    // Drawer reconnecting after round ended — let them in for free drawing (not part of game)
    game.drawerWsId=wsId;
    ws.send(JSON.stringify({type:'role',role:'drawer_free',word:null,round:0,reconnect:true}));
    ws.send(JSON.stringify({type:'status',message:'Round over — you can keep drawing freely!'}));
  }
  else{
    ws.send(JSON.stringify({type:'locked',message:'No active game. Start one with /startgame in the group!'}));
    setTimeout(()=>ws.close(),500);
    return;
  }
  broadcast(game,{type:'player_joined',name,count:game.clients.size},wsId);

  ws.on('message',data=>{
    let msg;try{msg=JSON.parse(data);}catch{return;}
    switch(msg.type){
      case'canvas_size':
        if(wsId!==game.drawerWsId)return;
        if(msg.w>0&&msg.h>0&&msg.w<=4096&&msg.h<=4096){
          const changed=msg.w!==game.canvasW||msg.h!==game.canvasH;
          game.canvasW=msg.w;game.canvasH=msg.h;
          if(changed||!game.vc){game.vc=makeVC(game.canvasW,game.canvasH);if(game.strokes.length>0)vcRebuild(game).catch(()=>{});}
          persistDebounced(game,200);
        }
        break;
      case'draw':
        if(wsId!==game.drawerWsId)return;
        {const inc=msg.stroke;
        if(inc.points&&inc.points.length>300){const step=Math.ceil(inc.points.length/300);inc.points=inc.points.filter((_,i)=>i%step===0||i===inc.points.length-1);if(inc.pressures)inc.pressures=inc.pressures.filter((_,i)=>i%step===0||i===inc.pressures.length-1);}
        if(inc.strokeId){const ei=game.strokes.findIndex(s=>s.strokeId===inc.strokeId);if(ei!==-1){game.strokes[ei]=inc;vcPaint(game,inc);}else{game.strokesUndo.push(inc);game.strokes.push(inc);if(game.strokesUndo.length>30)game.strokesUndo.shift();vcPaint(game,inc);}}
        else{game.strokesUndo.push(inc);game.strokes.push(inc);if(game.strokesUndo.length>30)game.strokesUndo.shift();vcPaint(game,inc);}
        // Only broadcast/push to Telegram during active game — not in drawer_free mode
        if(game.phase==='drawing'){
          broadcast(game,{type:'draw',stroke:inc},wsId);
          if(game.strokes.length>0&&game.strokes.length%20===0){const j=vcJpeg(game);if(j){const snap={brushType:'_snapshot',pngB64:j.toString('base64')};game.strokes=[snap];game.strokesUndo=[snap];persistDebounced(game,400);console.log('[game] Flattened');}}
          else if(game.strokes.length%5===0)persistDebounced(game,800);
          if(!game.firstStrokeDrawn){game.firstStrokeDrawn=true;game.roundStartTime=Date.now();persistDebounced(game,200);setTimeout(()=>pushCanvas(game),500);broadcast(game,{type:'first_stroke'},game.drawerWsId);}
          else{scheduleUpdate(game);}
        }
        }break;
      case'undo':
        if(wsId!==game.drawerWsId)return;
        if(game.strokes.length>0){game.strokes.pop();vcRebuild(game).then(()=>{const j=vcJpeg(game);if(j)broadcast(game,{type:'snapshot',data:'data:image/jpeg;base64,'+j.toString('base64')},game.drawerWsId);}).catch(()=>{});persistDebounced(game);scheduleUpdate(game,800,true);}
        break;
      case'redo':
        if(wsId!==game.drawerWsId)return;
        {const next=game.strokesUndo[game.strokes.length];if(next){game.strokes.push(next);vcPaint(game,next);const j=vcJpeg(game);if(j)broadcast(game,{type:'snapshot',data:'data:image/jpeg;base64,'+j.toString('base64')},game.drawerWsId);persistDebounced(game);scheduleUpdate(game,800,true);}}
        break;
      case'clear':
        if(wsId!==game.drawerWsId)return;
        game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;
        if(game.vc){game.vc.ctx.fillStyle='#ffffff';game.vc.ctx.fillRect(0,0,game.canvasW,game.canvasH);}
        broadcast(game,{type:'clear'});persistDebounced(game);break;
      case'snapshot':
        if(wsId!==game.drawerWsId)return;
        // Update virtual canvas so pushCanvas shows the correct flattened result
        if(msg.data&&game.vc){
          const b64=msg.data.replace(/^data:image\/\w+;base64,/,'');
          loadImage(Buffer.from(b64,'base64')).then(img=>{
            if(!game.vc)return;
            game.vc.ctx.fillStyle='#ffffff';
            game.vc.ctx.fillRect(0,0,game.canvasW,game.canvasH);
            game.vc.ctx.drawImage(img,0,0);
          }).catch(()=>{});
        }
        broadcast(game,{type:'snapshot',data:msg.data},wsId);
        break;
      case'vc_update':
        // Drawer sends flattened snapshot after fill/eraser/layer ops
        // Update virtual canvas only — don't broadcast (guessers already see via stroke)
        if(wsId!==game.drawerWsId||!msg.data||!game.vc)break;
        {const b64=msg.data.replace(/^data:image\/\w+;base64,/,'');
        loadImage(Buffer.from(b64,'base64')).then(img=>{
          if(!game.vc)return;
          game.vc.ctx.fillStyle='#ffffff';
          game.vc.ctx.fillRect(0,0,game.canvasW,game.canvasH);
          game.vc.ctx.drawImage(img,0,0);
        }).catch(()=>{});}
        break;
      case'send_to_chat':
        if(!msg.data||!tgId){sendWs(game,wsId,{type:'toast',message:!tgId?'Cannot identify user':'No image data'});break;}
        (async()=>{try{const buf=Buffer.from(msg.data.replace(/^data:image\/\w+;base64,/,''),'base64');await bot.telegram.sendPhoto(tgId,{source:buf,filename:'drawing.jpg'},{caption:`🎨 *${name}*`+(game.word?` — word: *${game.word}*`:''),parse_mode:'Markdown'});sendWs(game,wsId,{type:'toast',message:'Sent ✅'});}catch(e){sendWs(game,wsId,{type:'toast',message:e.message.includes('bot was blocked')||e.message.includes('chat not found')?'Start the bot privately first!':'Send failed: '+e.message});}})();
        break;
      case'guess':
        {const t=(msg.text||'').trim();if(!t)return;const ok=game.word&&t.toLowerCase()===game.word.toLowerCase();broadcast(game,{type:'guess',name,text:t,correct:ok});if(ok){const hintsGiven=game.hintRevealed.filter(Boolean).length,elapsed=(Date.now()-game.roundStartTime)/1000,timeBonus=Math.max(0,Math.floor((120-elapsed)/10)),pts=Math.max(10,100-hintsGiven*10+timeBonus);game.scores.set(name,(game.scores.get(name)||0)+pts);game.scores.set(game.drawerName,(game.scores.get(game.drawerName)||0)+50);broadcast(game,{type:'score_update',name,pts,timeBonus,board:leaderboard(game)});bot.telegram.sendMessage(game.chatId,`🎉 *${name}* guessed it! Word was *${game.word}* ✅  +${pts} pts`,{parse_mode:'Markdown'}).catch(()=>{});endGame(game,name,'guess');}}
        break;
      case'change_word':case'skip_word':
        if(wsId!==game.drawerWsId)return;
        {const nw=pickWord();game.word=nw;game.hintRevealed=new Array(nw.length).fill(false);game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;game.lastHintAt=0;if(game.vc){game.vc.ctx.fillStyle='#ffffff';game.vc.ctx.fillRect(0,0,game.canvasW,game.canvasH);}clearTimeout(game.roundTimer);clearTimeout(game.hintTimer);game.roundTimer=game.hintTimer=null;persistGame(game);sendWs(game,wsId,{type:'role',role:'drawer',word:nw,round:1,reconnect:false});broadcast(game,{type:'clear'},wsId);broadcast(game,{type:'word_skipped',hint:buildHint(nw,game.hintRevealed)},wsId);}
        break;
      case'set_custom_word':
        if(wsId!==game.drawerWsId||!msg.word||typeof msg.word!=='string')return;
        {const cw=msg.word.trim().toLowerCase().slice(0,40);if(!cw)return;game.word=cw;game.hintRevealed=new Array(cw.length).fill(false);game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;game.lastHintAt=0;if(game.vc){game.vc.ctx.fillStyle='#ffffff';game.vc.ctx.fillRect(0,0,game.canvasW,game.canvasH);}persistGame(game);sendWs(game,wsId,{type:'word_set',word:cw});sendWs(game,wsId,{type:'role',role:'drawer',word:cw,round:1,reconnect:false});broadcast(game,{type:'clear'},wsId);broadcast(game,{type:'word_skipped',hint:buildHint(cw,game.hintRevealed)},wsId);}
        break;
      case'final_image':
        // Drawer sends pixel-perfect flattenTo() JPEG at round end
        // Used for the final Telegram post — correct colors, no napi-rs rendering
        if(wsId!==game.drawerWsId||!msg.data)break;
        {const b64=msg.data.replace(/^data:image\/\w+;base64,/,'');
        game.finalJpeg=b64;persistDebounced(game,200);}
        break;
      case'done_drawing':
        if(wsId!==game.drawerWsId)return;
        // Wait 800ms for final_image to arrive before ending (client sends it first)
        setTimeout(()=>endGame(game,null,'done'),800);
        break;
      case'new_canvas':
        // Drawer requests a new canvas
        // Only allowed if current canvas is completed/pending_guess or idle
        if(wsId!==game.drawerWsId)return;
        {const cur=game;
        if(cur.phase==='drawing'&&cur.firstStrokeDrawn&&cur.status==='active'){
          sendWs(game,wsId,{type:'toast',message:'Finish or complete the current canvas first!'});return;
        }
        // Mutate game in-place: change canvasId, reset drawing state
        // WS closures still reference same game object — no migration needed
        const newId=uuidv4();
        const savedScores=new Map(game.scores);
        game.canvasId=newId;
        game.word=pickWord();game.hintRevealed=new Array(game.word.length).fill(false);
        game.strokes=[];game.strokesUndo=[];game.firstStrokeDrawn=false;game.lastHintAt=0;
        game.roundStartTime=Date.now();game.scores=savedScores;
        game.vc=makeVC(game.canvasW,game.canvasH);
        game.status='active';game.finalJpeg=null;game.pinnedMsgId=null;
        // phase stays 'drawing', drawerTgId/Name/WsId unchanged
        persistGame(game);
        // Tell drawer about new canvas+word
        sendWs(game,wsId,{type:'new_canvas',canvasId:newId,word:game.word});
        // Tell guessers to clear and await new drawing
        broadcast(game,{type:'clear'},wsId);
        broadcast(game,{type:'word_skipped',hint:buildHint(game.word,game.hintRevealed)},wsId);
        // Post new canvas message to Telegram
        if(botUsername){
          const url=`https://t.me/${botUsername}/${WEBAPP_SHORT_NAME}?startapp=${encodeURIComponent(`${game.chatId}__${game.drawerTgId}__${newId}`)}`;
          bot.telegram.sendMessage(game.chatId,`🎨 *${game.drawerName}* started a new canvas!\n🔤 \`${buildHint(game.word,game.hintRevealed)}\` — ${game.word.length} letters\n\n💬 Type your guess!`,
            {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.url('🖌 Open Canvas',url)],[Markup.button.callback('💡 Hint',`hint:${game.chatId}`)]])})
            .then(m=>{game.pinnedMsgId=m.message_id;bot.telegram.pinChatMessage(game.chatId,m.message_id,{disable_notification:true}).catch(()=>{});persistDebounced(game);})
            .catch(e=>console.error('[new_canvas]',e.message));
        }
        }break;
      case'new_round':
        {if(game.phase==='drawing'||game.phase==='waiting_drawer'||!botUsername)return;
        // Reset this canvas for a new round (same canvasId, new word)
        game.phase='waiting_drawer';game.scores=new Map();game.strokes=[];game.strokesUndo=[];
        game.word=null;game.drawerTgId=null;game.drawerName='';game.drawerWsId=null;
        game.pinnedMsgId=null;game.vc=null;game.finalJpeg=null;game.status='active';
        persistGame(game);
        bot.telegram.sendMessage(game.chatId,`🎨 *Draw & Guess!*\n\nWho wants to draw? ✏️`,
          {parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('✏️ I Want to Draw!',`claim_draw:${game.chatId}`)]])})
          .then(m=>{game.pinnedMsgId=m.message_id;bot.telegram.pinChatMessage(game.chatId,m.message_id,{disable_notification:true}).catch(()=>{});persistDebounced(game);})
          .catch(e=>console.error('[new_round]',e.message));
        broadcast(game,{type:'status',message:'Waiting for a drawer… check the group!'});}
        break;
      case'get_logs':ws.send(JSON.stringify({type:'logs',logs:[]}));break;
    }
  });
  ws.on('close',()=>{
    game.clients.delete(wsId);
    broadcast(game,{type:'player_left',name,count:game.clients.size});
    if(wsId===game.drawerWsId)game.drawerWsId=null;
  });
  ws.on('error',err=>{console.error(`[ws] ${name}:`,err.message);ws.close();});
});

function tgPost(method,body){return new Promise((res,rej)=>{const https=require('https'),p=JSON.stringify(body);const r=https.request({hostname:'api.telegram.org',path:`/bot${BOT_TOKEN}/${method}`,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(p)}},rr=>{let d='';rr.on('data',c=>d+=c);rr.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});});r.on('error',rej);r.write(p);r.end();});}
async function launchBot(){
  try{
    const me=await bot.telegram.getMe();botUsername=me.username;console.log(`🤖 @${botUsername} ready`);
    await bot.telegram.setMyCommands([{command:'startgame',description:'🎨 Start a new Draw & Guess game'},{command:'stopgame',description:'🛑 Stop the current game'},{command:'skipword',description:'⏭ Skip the current word'},{command:'leaderboard',description:'📊 Show current scores'}]);
    const info=(await tgPost('getWebhookInfo',{})).result||{};
    if(info.url===WEBHOOK_URL)console.log('[bot] ✅ Webhook already active');
    else{const r=await tgPost('setWebhook',{url:WEBHOOK_URL,drop_pending_updates:true,allowed_updates:['message','callback_query']});console.log('[bot] setWebhook:',r.description||JSON.stringify(r));}
  }catch(e){console.error('[bot] launchBot error:',e.message);setTimeout(launchBot,5000);}
}
server.listen(PORT,()=>{
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
  restoreAll();setTimeout(launchBot,1000);
  if(PUBLIC_URL){setInterval(()=>{const mod=PUBLIC_URL.startsWith('https')?require('https'):require('http');mod.get(`${PUBLIC_URL}/ping`,r=>console.log(`[keepalive] ${r.statusCode}`)).on('error',e=>console.warn('[keepalive]',e.message));},4*60*1000);}
});
process.on('unhandledRejection',r=>console.error('[unhandledRejection]',r?.message||r));
process.on('uncaughtException',e=>console.error('[uncaughtException]',e.message));
process.once('SIGINT',()=>{db.close();server.close();process.exit(0);});
process.once('SIGTERM',()=>{db.close();server.close();process.exit(0);});
