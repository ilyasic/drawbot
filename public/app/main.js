'use strict';
function getTgId(){if(tg){const u=tg.initDataUnsafe?.user;if(u?.id)return String(u.id);}return'';}
function parseStart(){
  let raw='';
  try{if(tg?.initDataUnsafe?.start_param)raw=decodeURIComponent(tg.initDataUnsafe.start_param);}catch{}
  if(!raw){try{raw=decodeURIComponent(new URLSearchParams(location.search).get('startapp')||'');}catch{}}
  if(!raw){try{raw=decodeURIComponent(new URLSearchParams(location.hash.slice(1)).get('startapp')||'');}catch{}}
  if(!raw&&tg?.initData){try{raw=decodeURIComponent(new URLSearchParams(tg.initData).get('start_param')||'');}catch{}}
  const parts=raw.split('__');
  const roomId=(parts[0]||'').trim();
  const canvasId=(parts[2]||'').trim(); // optional 3rd part
  return{roomId,canvasId};
}
let myCanvasId='';
let _joined=false,_canvasInited=false;
function initOnce(){if(_canvasInited)return;_canvasInited=true;try{initCanvases();renderPalette();syncPickerFromColor(currentColor);updateSzLbl();setTimeout(fitCanvas,100);setTimeout(fitCanvas,400);setTimeout(fitCanvas,800);}catch(e){console.error('initOnce error:',e);}}
function doJoin(roomId,playerName,tgId,canvasId){
  if(_joined)return;_joined=true;
  myName=playerName;myRoom=roomId;myTgId=tgId||'';myCanvasId=canvasId||'';
  try{sessionStorage.setItem('dgN',myName);sessionStorage.setItem('dgR',myRoom);sessionStorage.setItem('dgT',myTgId);}catch{}
  addLog(`Joining room=${myRoom} canvas=${myCanvasId||'default'} name=${myName} tgId=${myTgId||'anon'}`,'system');
  document.getElementById('join-overlay').style.display='none';
  initOnce();connect();
}
(function tryAuto(attempt){
  const parsed=parseStart();const tgName=getTgName();const tgId=getTgId();
  if(parsed.roomId){
    document.getElementById('join-overlay').style.display='none';initOnce();
    if(tgName){doJoin(parsed.roomId,tgName,tgId,parsed.canvasId);return;}
    if(attempt<30){setTimeout(()=>tryAuto(attempt+1),100);return;}
    doJoin(parsed.roomId,'Player'+~~(Math.random()*900+100),tgId,parsed.canvasId);
  }else{
    if(attempt<15){setTimeout(()=>tryAuto(attempt+1),100);return;}
    // No room param — show lock screen, canvas only opens from Telegram
    const lock=document.createElement('div');
    lock.style.cssText='position:fixed;inset:0;background:#1a1a2e;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:9999;';
    lock.innerHTML='<div style="font-size:3rem">🔒</div><div style="color:#fff;font-size:1.1rem;font-weight:700;text-align:center;padding:0 24px">Open this from Telegram</div><div style="color:#888;font-size:.85rem;text-align:center;padding:0 32px">This canvas is only accessible during an active game session</div>';
    document.body.appendChild(lock);
    setTimeout(()=>window.Telegram?.WebApp?.close(),3000);
  }
})(0);

document.getElementById('join-btn').addEventListener('click',()=>{const name=document.getElementById('name-in').value.trim()||'Player'+~~(Math.random()*1000);const room=document.getElementById('room-in').value.trim()||'default';doJoin(room,name,'');});
document.getElementById('name-in').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('room-in').focus();});
document.getElementById('room-in').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('join-btn').click();});
addLog('Client ready');

