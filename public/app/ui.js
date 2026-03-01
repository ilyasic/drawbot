'use strict';
function closeAllPanels(){document.querySelectorAll('.popup').forEach(p=>p.classList.remove('open'));}
function togglePanel(id){const el=document.getElementById(id);const was=el.classList.contains('open');closeAllPanels();if(!was)el.classList.add('open');}
document.getElementById('btn-brush').addEventListener('click',()=>togglePanel('brush-popup'));
document.getElementById('btn-color').addEventListener('click',()=>{togglePanel('color-popup');renderPalette();setTimeout(()=>{drawSBCanvas();drawHueBar();},10);});
document.getElementById('btn-opacity').addEventListener('click',()=>{togglePanel('opacity-popup');updateSzLbl();});
document.getElementById('btn-layers').addEventListener('click',()=>{renderLayerPanel();togglePanel('layer-popup');});
document.getElementById('btn-menu').addEventListener('click',()=>togglePanel('settings-popup'));
document.getElementById('btn-undo').addEventListener('click',doUndo);
document.getElementById('btn-redo').addEventListener('click',doRedo);
document.getElementById('btn-clear').addEventListener('click',()=>{if(!isDrawer)return;if(!confirm('Clear canvas?'))return;saveUndo();clearAll();wsSend({type:'clear'});showSyncSpin();});
document.getElementById('btn-fill').addEventListener('click',()=>{setBrush('fill');closeAllPanels();showToast('Flood fill — tap to fill 🪣');});
document.getElementById('btn-eyedrop').addEventListener('click',()=>{setBrush('eyedrop');closeAllPanels();showToast('Pick color 💉');});
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.tbtn')&&!e.target.closest('.top-icon')&&!e.target.closest('.popup'))closeAllPanels();});

// Brush wheel cycle
const BORDER=['pen','pencil','pastel','marker','bristle','ink','watercolor','airbrush','eraser'];
document.getElementById('btn-brush').addEventListener('wheel',e=>{e.preventDefault();const c=BORDER.indexOf(brushType);setBrush(BORDER[(c+(e.deltaY>0?1:-1)+BORDER.length)%BORDER.length]);showToast(brushType);},{passive:false});
document.getElementById('btn-opacity').addEventListener('wheel',e=>{e.preventDefault();if(e.shiftKey){brushOpacity=Math.min(1,Math.max(.05,brushOpacity+(e.deltaY<0?.05:-.05)));document.getElementById('op-range').value=~~(brushOpacity*100);document.getElementById('op-lbl').textContent=~~(brushOpacity*100)+'%';}else{brushSize=Math.min(120,Math.max(1,brushSize+(e.deltaY<0?1:-1)));document.getElementById('sz-range').value=brushSize;}updateSzLbl();},{passive:false});
let _tsY=null,_tsS=null;
document.getElementById('btn-opacity').addEventListener('touchstart',e=>{_tsY=e.touches[0].clientY;_tsS=brushSize;e.preventDefault();},{passive:false});
document.getElementById('btn-opacity').addEventListener('touchmove',e=>{if(_tsY===null)return;e.preventDefault();brushSize=Math.min(120,Math.max(1,~~(_tsS+(_tsY-e.touches[0].clientY)*.3)));document.getElementById('sz-range').value=brushSize;updateSzLbl();showToast(brushSize+'px');},{passive:false});
document.getElementById('btn-opacity').addEventListener('touchend',()=>_tsY=null);

// ─── Sync Indicator ───
let _st=null;
function showSyncSpin(){document.getElementById('sync-spin').style.display='block';document.getElementById('sync-check').style.display='none';clearTimeout(_st);}
function showSyncDone(){document.getElementById('sync-spin').style.display='none';document.getElementById('sync-check').style.display='inline';clearTimeout(_st);_st=setTimeout(()=>document.getElementById('sync-check').style.display='none',2000);}

// ─── Toast ───
let _tt=null;const toastEl=document.getElementById('toast');
// Game events that deserve a Telegram native popup
const GAME_TOASTS=new Set(['round_end','leaderboard','score','guessed','correct']);
function showToast(msg,cls='',important=false){
  const tg=window.Telegram?.WebApp;
  // Haptic for all toasts
  if(tg){
    if(cls==='ok')tg.HapticFeedback?.notificationOccurred('success');
    else if(cls==='err')tg.HapticFeedback?.notificationOccurred('error');
    else if(cls==='warn')tg.HapticFeedback?.notificationOccurred('warning');
    else tg.HapticFeedback?.impactOccurred('light');
  }
  // Important game events → Telegram popup; tool feedback → lightweight DOM toast
  if(important&&tg){
    tg.showPopup({message:msg,buttons:[{type:'close'}]});
    return;
  }
  // DOM toast — fast, non-blocking, no tap needed
  toastEl.textContent=msg;toastEl.className='show '+(cls||'');
  clearTimeout(_tt);_tt=setTimeout(()=>toastEl.className='',2000);
}

// ─── Chat ───
const chatLog=document.getElementById('chat-log');
function addChat(cls,html){const d=document.createElement('div');d.className='cmsg '+cls;d.innerHTML=html;chatLog.appendChild(d);chatLog.scrollTop=chatLog.scrollHeight;}

// ─── Guess input (guessers only, disabled for drawer) ───
function sendGuess(){
  if(isDrawer){showToast('Drawer cannot guess 🎨','warn');return;}
  const t=document.getElementById('guess-in').value.trim();
  if(!t||!ws||ws.readyState!==1)return;
  ws.send(JSON.stringify({type:'guess',text:t}));
  document.getElementById('guess-in').value='';
}
document.getElementById('guess-go').addEventListener('click',sendGuess);
document.getElementById('guess-in').addEventListener('keydown',e=>{if(e.key==='Enter')sendGuess();});

// ─── Hint display — letter placeholders ───
function updateHintDisplay(hint){
  const hd=document.getElementById('hint-display');if(!hd)return;
  if(!hint||isDrawer){hd.style.display='none';hd.innerHTML='';return;}
  hd.style.display='flex';
  hd.innerHTML='';
  const chars=hint.split('');
  chars.forEach(ch=>{
    const span=document.createElement('span');
    span.className='hint-char';
    if(ch===' '||ch==='  '){span.className+=' space';span.textContent=' ';}
    else if(ch==='_'){span.textContent='_';}
    else{span.className+=' revealed';span.textContent=ch;}
    hd.appendChild(span);
  });
}

// ─── Round Overlay ───
const roundOv=document.getElementById('round-overlay');let currentWord='';
function showResult(emoji,title,word,sub){document.getElementById('re-emoji').textContent=emoji;document.getElementById('re-title').textContent=title;document.getElementById('re-word').textContent=word;document.getElementById('re-sub').textContent=sub;roundOv.classList.add('show');setTimeout(()=>roundOv.classList.remove('show'),9000);}
document.getElementById('re-newround').addEventListener('click',()=>roundOv.classList.remove('show'));
document.getElementById('dfo-keep').addEventListener('click',()=>{document.getElementById('drawer-finish-overlay').style.display='none';showToast('Keep drawing! 🎨');});
document.getElementById('dfo-close').addEventListener('click',()=>{document.getElementById('drawer-finish-overlay').style.display='none';document.getElementById('toolbar').classList.remove('visible');isDrawer=false;try{tg?.close();}catch(e){}});

function updatePlayers(board){const list=document.getElementById('player-list');if(!board?.length){list.innerHTML='<div style="font-size:.74rem;color:var(--text2);padding:3px 5px">No players</div>';return;}list.innerHTML=board.map(({name,score,rank})=>`<div style="display:flex;align-items:center;gap:6px;padding:4px 5px;font-size:.78rem"><div style="width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0"></div><div style="flex:1;font-weight:600">${name}</div><div style="color:var(--yellow);font-weight:700;font-size:.72rem;font-family:'JetBrains Mono',monospace">${score}pts${rank===1?' 👑':''}</div></div>`).join('');}
function updateLb(board){
  // Store board for on-demand popup — no DOM widget needed
  window._lastBoard=board||[];
}
function showLeaderboard(){
  const board=window._lastBoard||[];
  if(!board.length){window.Telegram?.WebApp?.showAlert('No scores yet.');return;}
  const m=['🥇','🥈','🥉'];
  const text=board.slice(0,8).map(({rank,name,score})=>`${m[rank-1]||rank+'.'}  ${name}  —  ${score}pts`).join('\n');
  window.Telegram?.WebApp?.showPopup({title:'📊 Leaderboard',message:text,buttons:[{type:'close'}]});
}

let isDrawer=false;
function setRole(role,wordOrHint,round){
  isDrawer=role==='drawer'||role==='drawer_free';
  document.getElementById('toolbar').classList.toggle('visible',isDrawer);
  document.getElementById('chat-panel').classList.add('visible');
  document.getElementById('waiting-overlay').classList.add('hidden');
  const guessRow=document.getElementById('guess-row');
  if(isDrawer){
    document.getElementById('lb-btn').style.display='inline-block';
    guessRow.style.display='none';
    document.getElementById('hint-display').style.display='none';
  }else{
    guessRow.style.display='none';
    const tg=window.Telegram?.WebApp;
    if(tg){
      tg.MainButton.setText('💬 Type Guess');tg.MainButton.show();
      tg.MainButton.onClick(()=>{const guess=prompt('Your guess:');if(guess&&guess.trim()){const t=guess.trim();wsSend({type:'guess',text:t});addChat('me',t);}});
    }else{guessRow.style.display='flex';document.getElementById('guess-in').disabled=false;}
  }
  const pill=document.getElementById('role-pill');
  if(role==='drawer_free'){
    pill.className='role-pill drawer';pill.textContent='FREE DRAW';
  }else{
    pill.className='role-pill '+role;pill.textContent=isDrawer?'DRAWING':'GUESSING';
  }
  const wd=document.getElementById('word-display');
  if(role==='drawer_free'){
    currentWord='';
    wd.textContent='Free Drawing';
    document.getElementById('s-current-word').textContent='—';
    showToast('Draw freely — round is over','ok');
    updateHintDisplay('');
  }else if(isDrawer){
    currentWord=wordOrHint||'';
    wd.textContent=(wordOrHint||'').toUpperCase();
    document.getElementById('s-current-word').textContent=(wordOrHint||'').toUpperCase();
    showToast(`Word: ${wordOrHint}`,'ok');sfxRoundStart();addLog(`Round started — you are DRAWER`,'round');
    updateHintDisplay('');
  }else{
    currentWord='';
    const hint=typeof wordOrHint==='number'?'_'.repeat(wordOrHint):wordOrHint;
    const lc=typeof wordOrHint==='number'?wordOrHint:(hint||'').replace(/ /g,'').length;
    wd.textContent=`${lc} letters`;
    updateHintDisplay(hint);
    setTimeout(fitCanvas,50);addLog(`Role: GUESSER — hint: ${hint}`,'round');
  }
  if(round)addChat('sys',`Round ${round}`);
  setTimeout(fitCanvas,50);setTimeout(fitCanvas,300);
}

// ─── Sounds ───
const AC=window.AudioContext||window.webkitAudioContext;let ac=null,soundEnabled=true;
