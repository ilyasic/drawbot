'use strict';


const T0=performance.now();let _lt=T0;const logBuf=[];
function addLog(msg,cat='system'){
  const now=performance.now(),ts=(now-T0)/1e3,delta=(now-_lt)/1e3;_lt=now;
  const e={ts,delta,msg,cat};logBuf.push(e);if(logBuf.length>400)logBuf.shift();
  _appendLog(e);
}
function _appendLog(e){
  const c=document.getElementById('log-entries');if(!c)return;
  if(c.firstElementChild?.style?.padding)c.innerHTML='';
  const r=document.createElement('div');r.className='log-entry ev-'+e.cat;
  r.innerHTML=`<span class="log-ts">${e.ts.toFixed(4)}</span><span class="log-delta">${e.delta.toFixed(4)}</span><span class="log-msg">— ${e.msg}</span>`;
  c.appendChild(r);c.scrollTop=c.scrollHeight;
}
function renderAllLogs(){
  const c=document.getElementById('log-entries');if(!c)return;c.innerHTML='';
  if(!logBuf.length){c.innerHTML='<div style="color:var(--text3);font-size:.68rem;padding:6px">No events yet.</div>';return;}
  logBuf.forEach(_appendLog);
}
addLog('Page load started');

const tg=window.Telegram?.WebApp;
if(tg){
  try{tg.ready();}catch(e){}
  try{tg.expand();}catch(e){}
  try{if(typeof tg.requestFullscreen==='function')tg.requestFullscreen();}catch(e){}
  try{tg.onEvent('viewportChanged',()=>{try{if(!tg.isExpanded)tg.expand();}catch(e){}});}catch(e){}
  try{if(tg.SettingsButton){tg.SettingsButton.show();tg.SettingsButton.onClick(()=>togglePanel('settings-popup'));}}catch(e){}
  try{tg.onEvent('viewportChanged',()=>setTimeout(fitCanvas,100));}catch(e){}
}

function makePRNG(seed){
  let s=seed>>>0;
  return()=>{s+=0x6D2B79F5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};
}

// ─── Default canvas: Square 1:1 ───
let CW=1080,CH=1080;
const bgCv  =document.getElementById('cv-bg');
const layersCv=document.getElementById('cv-layers');
const drawCv=document.getElementById('cv-draw');
const prevCv=document.getElementById('cv-preview');
let bgCtx,layersCtx,drawCtx,prevCtx;
const wrap=document.getElementById('canvas-wrap');
const area=document.getElementById('canvas-area');

const MAX_LAYERS=8;
let layers=[],actIdx=0,editMask=false;
const BLENDS=['source-over','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity'];
const BLEND_LBL={'source-over':'Normal','multiply':'Multiply','screen':'Screen','overlay':'Overlay','darken':'Darken','lighten':'Lighten','color-dodge':'Dodge','color-burn':'Burn','hard-light':'H.Light','soft-light':'S.Light','difference':'Diff','exclusion':'Excl','hue':'Hue','saturation':'Sat','color':'Color','luminosity':'Lum'};

