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
const ROUND_TIME = 90; // seconds per round

if (!BOT_TOKEN)  { console.error('BOT_TOKEN missing'); process.exit(1); }
if (!PUBLIC_URL) { console.error('PUBLIC_URL missing'); process.exit(1); }

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const bot    = new Telegraf(BOT_TOKEN);
let botUsername = '';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../../client')));

// ── Render PNG ────────────────────────────────────────────────────────────────
const CW = 1600, CH = 1000;

function hexToInt(hex) {
  try {
    const c = (hex||'#000').replace('#','').padEnd(6,'0');
    return Jimp.rgbaToInt(parseInt(c.slice(0,2),16),parseInt(c.slice(2,4),16),parseInt(c.slice(4,6),16),255);
  } catch { return 0x000000FF; }
}

function plotLine(img,x0,y0,x1,y1,col,r) {
  x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1);
  const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;
  let err=dx-dy;
  for(;;){
    for(let tx=-r;tx<=r;tx++) for(let ty=-r;ty<=r;ty++){
      if(tx*tx+ty*ty<=r*r){const px=x0+tx,py=y0+ty;
        if(px>=0&&px<CW&&py>=0&&py<CH)img.setPixelColor(col,px,py);}
    }
    if(x0===x1&&y0===y1)break;
    const e2=2*err;
    if(e2>-dy){err-=dy;x0+=sx;}
    if(e2<dx){err+=dx;y0+=sy;}
  }
}

async function renderPNG(strokes, done) {
  const img = new Jimp(CW, CH, 0xFFFFFFFF);
  for (const s of strokes) {
    const pts=s.points||[];
    if(pts.length<2)continue;
    const col=hexToInt(s.color);
    const r=Math.max(1,Math.round((s.size||4)*1.8));
    for(let i=1;i<pts.length;i++)
      plotLine(img,pts[i-1][0]*2,pts[i-1][1]*2,pts[i][0]*2,pts[i][1]*2,col,r);
  }
  const barCol=done?0x2dc653FF:0x1a1a2eFF;
  for(let x=0;x<CW;x++) for(let y=CH-50;y<CH;y++) img.setPixelColor(barCol,x,y);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

// ── State ─────────────────────────────────────────────────────────────────────
const rooms = new Map();
const WORDS = [
  'cat','dog','house','tree','car','sun','moon','fish','bird','flower',
  'pizza','guitar','elephant','rainbow','rocket','castle','dragon','piano',
  'submarine','tornado','volcano','lighthouse','butterfly','telescope','snowman',
  'dinosaur','waterfall','helicopter','cactus','penguin','banana','scissors',
  'telephone','umbrella','bicycle','glasses','crown','anchor','compass','bridge',
  'robot','alien','wizard','knight','ninja','pirate','mermaid','unicorn',
  'skateboard','parachute','volcano','pineapple','astronaut','fireworks',
];

function makeRoom(id, chatId) {
  return {
    id, chatId,
    clients: new Map(),
    strokes: [],
    currentDrawer: null,
    drawerName: '',
    word: null,
    revealedIndices: new Set(),
    guesses: new Set(),
    roundActive: false,
    liveMessageId: null,
    updateTimer: null,
    roundTimer: null,       // countdown timer
    hintTimers: [],         // scheduled hint reveals
    timeLeft: ROUND_TIME,
    tickInterval: null,
  };
}

function bcast(room, msg, skip=null) {
  const d=JSON.stringify(msg);
  room.clients.forEach((c,id)=>{ if(id!==skip&&c.ws.readyState===1)c.ws.send(d); });
}
function send(room, clientId, msg) {
  const c=room.clients.get(clientId);
  if(c&&c.ws.readyState===1)c.ws.send(JSON.stringify(msg));
}

// ── Canvas push ───────────────────────────────────────────────────────────────
async function pushCanvas(room) {
  if(!room.chatId||!room.roundActive||!room.word)return;
  let png;
  try{png=await renderPNG(room.strokes,false);}catch(e){console.error('render:',e.message);return;}
  const hint=buildHint(room);
  const caption=`🎨 *${room.drawerName}* is drawing!\n🔤 \`${hint}\` — ${room.word.length} letters\n⏱ ${room.timeLeft}s left\n\n💬 Type your guess here!`;
  const canvasUrl=`${PUBLIC_URL}/?room=${encodeURIComponent(room.id)}`;
  try {
    if(!room.liveMessageId){
      const m=await bot.telegram.sendPhoto(room.chatId,{source:png,filename:'drawing.png'},
        {caption,parse_mode:'Markdown',...Markup.inlineKeyboard([Markup.button.url('🖌 Open Canvas',canvasUrl)])});
      room.liveMessageId=m.message_id;
    } else {
      await bot.telegram.editMessageMedia(room.chatId,room.liveMessageId,null,
        {type:'photo',media:{source:png,filename:'drawing.png'},caption,parse_mode:'Markdown'});
    }
  } catch(e){
    if(e.message.includes('not modified'))return;
    console.error('pushCanvas:',e.message);
    if(/(not found|deleted|no message)/.test(e.message))room.liveMessageId=null;
  }
}

function scheduleUpdate(room){
  if(room.updateTimer)return;
  room.updateTimer=setTimeout(async()=>{room.updateTimer=null;await pushCanvas(room);},1200);
}

async function saveFinal(room, guesserName) {
  if(!room.chatId)return;
  let png;
  try{png=await renderPNG(room.strokes,true);}catch(e){console.error('final:',e.message);return;}
  if(room.liveMessageId){try{await bot.telegram.deleteMessage(room.chatId,room.liveMessageId);}catch{}room.liveMessageId=null;}
  const caption=[
    `✅ *Round Complete!*`,``,
    `🖌 Artist: *${room.drawerName}*`,
    `🎯 Word: *${room.word}*`,
    guesserName?`🏆 Guessed by: *${guesserName}*`:`😔 Nobody guessed it!`,
    ``,`_Starting next round..._`
  ].join('\n');
  const canvasUrl=`${PUBLIC_URL}/?room=${encodeURIComponent(room.id)}`;
  try {
    await bot.telegram.sendPhoto(room.chatId,{source:png,filename:`${room.word}.png`},
      {caption,parse_mode:'Markdown',
        ...Markup.inlineKeyboard([Markup.button.url('▶️ New Round',canvasUrl)])});
  }catch(e){console.error('saveFinal:',e.message);}
}

// ── Hint system ───────────────────────────────────────────────────────────────
function buildHint(room) {
  return room.word.split('').map((ch,i)=>
    ch===' '?'/' : room.revealedIndices.has(i)?ch:'_'
  ).join(' ');
}

function revealLetter(room) {
  if(!room.roundActive||!room.word)return;
  // pick a random unrevealed non-space index
  const unrevealed=room.word.split('').map((_,i)=>i)
    .filter(i=>room.word[i]!==' '&&!room.revealedIndices.has(i));
  if(!unrevealed.length)return;
  const idx=unrevealed[Math.floor(Math.random()*unrevealed.length)];
  room.revealedIndices.add(idx);
  const hint=buildHint(room);
  bcast(room,{type:'hint',hint});
  // also push to group
  if(room.chatId){
    bot.telegram.sendMessage(room.chatId,`💡 Hint: \`${hint}\``,{parse_mode:'Markdown'}).catch(()=>{});
  }
  console.log(`Hint revealed: ${hint}`);
}

// ── Round management ──────────────────────────────────────────────────────────
function clearRoundTimers(room) {
  if(room.roundTimer){clearTimeout(room.roundTimer);room.roundTimer=null;}
  if(room.tickInterval){clearInterval(room.tickInterval);room.tickInterval=null;}
  room.hintTimers.forEach(t=>clearTimeout(t));
  room.hintTimers=[];
  if(room.updateTimer){clearTimeout(room.updateTimer);room.updateTimer=null;}
}

function startRound(room) {
  const ids=Array.from(room.clients.keys());
  if(!ids.length)return;
  clearRoundTimers(room);
  room.strokes=[];room.guesses=new Set();room.roundActive=true;
  room.liveMessageId=null;room.revealedIndices=new Set();
  room.timeLeft=ROUND_TIME;
  room.currentDrawer=ids[Math.floor(Math.random()*ids.length)];
  room.drawerName=room.clients.get(room.currentDrawer)?.name||'Someone';
  room.word=WORDS[Math.floor(Math.random()*WORDS.length)];

  // Assign roles
  room.clients.forEach((c,id)=>{
    const isD=id===room.currentDrawer;
    c.ws.send(JSON.stringify(isD
      ?{type:'role',role:'drawer',word:room.word}
      :{type:'role',role:'guesser',hint:room.word.length,hintText:buildHint(room)}
    ));
  });

  bcast(room,{type:'clear'});
  bcast(room,{type:'timer',timeLeft:ROUND_TIME});
  bcast(room,{type:'status',message:`${room.drawerName} is drawing!`});

  // Notify group
  if(room.chatId){
    bot.telegram.sendMessage(room.chatId,
      `🎮 *New Round!*\n\n✏️ *${room.drawerName}* is drawing...\n⏱ ${ROUND_TIME} seconds!\n💬 Guess by typing here!`,
      {parse_mode:'Markdown'}).catch(()=>{});
  }

  // Schedule hint reveals: at 60s, 40s, 20s remaining
  const hintAt=[ROUND_TIME-30, ROUND_TIME-55, ROUND_TIME-75].filter(t=>t>0);
  hintAt.forEach(delay=>{
    room.hintTimers.push(setTimeout(()=>revealLetter(room), delay*1000));
  });

  // Countdown ticker (every second)
  room.tickInterval=setInterval(()=>{
    if(!room.roundActive){clearInterval(room.tickInterval);room.tickInterval=null;return;}
    room.timeLeft=Math.max(0,room.timeLeft-1);
    bcast(room,{type:'timer',timeLeft:room.timeLeft});
  },1000);

  // Round timeout
  room.roundTimer=setTimeout(()=>endRound(room,null),ROUND_TIME*1000);

  // Initial canvas push
  setTimeout(()=>pushCanvas(room),600);
}

async function endRound(room, guesserName) {
  if(!room.roundActive)return;
  room.roundActive=false;
  clearRoundTimers(room);

  bcast(room,{
    type:'round_end',
    word:room.word,
    drawerName:room.drawerName,
    guesser:guesserName||null,
  });

  await saveFinal(room,guesserName);

  // Auto-start next round after 8s
  setTimeout(()=>{
    if(rooms.has(room.id)&&room.clients.size>0)startRound(room);
  },8000);
}

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.command('startgame',async(ctx)=>{
  if(ctx.chat.type==='private')return ctx.reply('Add me to a group and use /startgame there!');
  const roomId=String(ctx.chat.id);
  if(!rooms.has(roomId))rooms.set(roomId,makeRoom(roomId,ctx.chat.id));
  const canvasUrl=`${PUBLIC_URL}/?room=${encodeURIComponent(roomId)}`;
  await ctx.reply(
    `🎨 *Draw & Guess*\n\n1️⃣ Tap *Open Canvas* to draw\n2️⃣ Everyone else: type guesses here\n3️⃣ First to guess wins!\n⏱ ${ROUND_TIME} seconds per round`,
    {parse_mode:'Markdown',...Markup.inlineKeyboard([Markup.button.url('🖌 Open Canvas',canvasUrl)])}
  );
});

bot.command('start',async(ctx)=>{
  if(ctx.chat.type!=='private')return;
  const parts=ctx.message.text.split(' ');
  const roomId=parts[1]?decodeURIComponent(parts[1]):null;
  if(!roomId)return ctx.reply('👋 Use /startgame in a group to begin!');
  const canvasUrl=`${PUBLIC_URL}/?room=${encodeURIComponent(roomId)}`;
  await ctx.reply(
    `🎨 *Draw & Guess*\nTap below to open the canvas inside Telegram!`,
    {parse_mode:'Markdown',...Markup.inlineKeyboard([Markup.button.webApp('🖌 Open Canvas',canvasUrl)])}
  );
});

bot.command('stopgame',async(ctx)=>{
  const roomId=String(ctx.chat.id);
  if(rooms.has(roomId)){
    const room=rooms.get(roomId);
    clearRoundTimers(room);
    rooms.delete(roomId);
    ctx.reply('🛑 Game stopped.');
  } else ctx.reply('No active game.');
});

bot.command('newround',async(ctx)=>{
  const roomId=String(ctx.chat.id);
  const room=rooms.get(roomId);
  if(!room)return ctx.reply('No game. Use /startgame first.');
  if(!room.clients.size)return ctx.reply('No players on canvas yet!');
  await endRound(room,null);
});

bot.on('text',async(ctx)=>{
  if(ctx.chat.type==='private')return;
  const roomId=String(ctx.chat.id);
  const room=rooms.get(roomId);
  if(!room||!room.roundActive||!room.word)return;
  const text=(ctx.message.text||'').trim();
  if(text.startsWith('/'))return;
  const userId=String(ctx.from.id);
  if(room.guesses.has(userId))return;
  const userName=[ctx.from.first_name,ctx.from.last_name].filter(Boolean).join(' ')||ctx.from.username||'Player';
  const correct=text.toLowerCase()===room.word.toLowerCase();
  bcast(room,{type:'guess',name:userName,text,correct});
  if(correct){room.guesses.add(userId);await endRound(room,userName);}
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection',(ws,req)=>{
  const clientId=uuidv4();
  const url=new URL(req.url,'http://localhost');
  const roomId=url.searchParams.get('room')||'default';
  const name=url.searchParams.get('name')||`Player${Math.floor(Math.random()*1000)}`;

  if(!rooms.has(roomId))rooms.set(roomId,makeRoom(roomId,null));
  const room=rooms.get(roomId);
  room.clients.set(clientId,{ws,name});
  console.log(`[+] ${name} → ${roomId} (${room.clients.size})`);

  ws.send(JSON.stringify({type:'init',strokes:room.strokes,players:room.clients.size,
    timeLeft:room.timeLeft,hint:room.word?buildHint(room):null}));
  bcast(room,{type:'player_joined',name,count:room.clients.size},clientId);

  if(!room.currentDrawer)setTimeout(()=>startRound(room),800);

  ws.on('message',data=>{
    let msg;try{msg=JSON.parse(data);}catch{return;}
    switch(msg.type){
      case 'draw':
        if(clientId!==room.currentDrawer)return;
        room.strokes.push(msg.stroke);
        bcast(room,{type:'draw',stroke:msg.stroke},clientId);
        scheduleUpdate(room);
        break;
      case 'clear':
        if(clientId!==room.currentDrawer)return;
        room.strokes=[];bcast(room,{type:'clear'});scheduleUpdate(room);
        break;
      case 'snapshot':
        if(clientId!==room.currentDrawer)return;
        bcast(room,{type:'snapshot',data:msg.data},clientId);
        break;
      case 'guess':
        if(clientId===room.currentDrawer)return;
        const t=(msg.text||'').trim();
        const ok=!!room.word&&t.toLowerCase()===room.word.toLowerCase();
        bcast(room,{type:'guess',name,text:t,correct:ok});
        if(ok)endRound(room,name);
        break;
      case 'done_drawing':
        if(clientId!==room.currentDrawer)return;
        endRound(room,null);
        break;
      case 'request_hint':
        if(clientId===room.currentDrawer)return;
        // manual hint request — reveal one letter
        revealLetter(room);
        break;
    }
  });

  ws.on('close',()=>{
    room.clients.delete(clientId);
    console.log(`[-] ${name} left ${roomId}`);
    bcast(room,{type:'player_left',name,count:room.clients.size});
    if(room.currentDrawer===clientId){
      room.currentDrawer=null;room.roundActive=false;
      clearRoundTimers(room);
      if(room.clients.size>0)setTimeout(()=>startRound(room),1000);
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT,async()=>{
  console.log(`✅ http://localhost:${PORT}  |  📡 ${PUBLIC_URL}`);
  try{
    const me=await bot.telegram.getMe();
    botUsername=me.username;
    await bot.telegram.setMyCommands([
      {command:'startgame',description:'Start Draw & Guess in this group'},
      {command:'stopgame', description:'Stop the game'},
      {command:'newround', description:'Skip to next round'},
    ]);
    bot.launch();
    console.log(`🤖 @${botUsername} running`);
  }catch(e){console.error('Bot:',e.message);}
});

process.once('SIGINT', ()=>{bot.stop('SIGINT'); server.close();});
process.once('SIGTERM',()=>{bot.stop('SIGTERM');server.close();});
