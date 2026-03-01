'use strict';
function galKey(){return'dg_gallery__'+(myRoom||'default');}
function saveToGallery(word,drawer){
  try{
    const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;
    flattenTo(tmp.getContext('2d'));
    const g=JSON.parse(localStorage.getItem(galKey())||'[]');
    g.unshift({word,drawer,date:new Date().toISOString(),img:tmp.toDataURL('image/jpeg',.75)});
    localStorage.setItem(galKey(),JSON.stringify(g.slice(0,20)));
  }catch(e){console.warn('gallery save error',e);}
}
function openGallery(){
  const g=JSON.parse(localStorage.getItem(galKey())||'[]');
  if(!g.length){showToast('Gallery empty','warn');return;}
  closeAllPanels();
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:900;overflow-y:auto;padding:14px;backdrop-filter:blur(10px)';
  ov.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px"><div style="font-size:1rem;font-weight:800;color:var(--accent)">🖼 Gallery</div><button id="gc" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 12px;border-radius:18px;cursor:pointer;font-size:.8rem">✕</button></div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px">${g.map(it=>`<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden"><img src="${it.img}" style="width:100%;display:block"/><div style="padding:5px 7px"><div style="font-weight:700;font-size:.76rem;color:var(--accent)">${it.word}</div><div style="font-size:.66rem;color:var(--text2)">${it.drawer}</div></div></div>`).join('')}</div>`;
  document.body.appendChild(ov);
  document.getElementById('gc').addEventListener('click',()=>ov.remove());
}

// ─── Save image (actually downloads as PNG) ───
function saveDrawingFile(){
  try{
    const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;
    flattenTo(tmp.getContext('2d'));
    tmp.toBlob(blob=>{
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download=`drawing_${currentWord||'untitled'}_${Date.now()}.png`;
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url),2000);
      showToast('Image saved 💾','ok');
    },'image/png');
  }catch(e){
    // Fallback: open in new tab
    try{
      const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;
      flattenTo(tmp.getContext('2d'));
      const url=tmp.toDataURL('image/png');
      window.open(url,'_blank');
      showToast('Opened in new tab 💾','ok');
    }catch(e2){showToast('Save failed','warn');}
  }
}

// ─── Send to Telegram chatbot — non-blocking JPEG export ───
function sendToTg(){
  if(!ws||ws.readyState!==1){showToast('Not connected','warn');return;}
  showToast('Preparing…');
  // setTimeout(0): yields to render the toast first, then runs export sync
  setTimeout(()=>{
    try{
      const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;
      flattenTo(tmp.getContext('2d'));
      let dataURL=tmp.toDataURL('image/jpeg',0.82);
      // Size guard: downsample if base64 >1.5MB
      if(dataURL.length>1.5*1024*1024){
        const half=document.createElement('canvas');
        half.width=~~(CW/2);half.height=~~(CH/2);
        half.getContext('2d').drawImage(tmp,0,0,half.width,half.height);
        dataURL=half.toDataURL('image/jpeg',0.82);
      }
      addLog('sendToTg payload '+(dataURL.length/1024).toFixed(0)+'KB ws='+ws?.readyState,'system');
      if(!ws||ws.readyState!==1){showToast('Connection lost','warn');return;}
      try{
        ws.send(JSON.stringify({type:'send_to_chat',data:dataURL}));
        showToast('Sending…');
      }catch(sendErr){
        showToast('Send error: '+sendErr.message,'warn');
        addLog('sendToTg ws.send err: '+sendErr.message,'error');
      }
    }catch(e){
      showToast('Export failed','warn');
      addLog('sendToTg err: '+e.message,'error');
      console.error('[sendToTg]',e);
    }
  },0);
}

// ─── Settings actions ───
document.getElementById('s-players').addEventListener('click',()=>togglePanel('players-popup'));
document.getElementById('s-leaderboard').addEventListener('click',()=>togglePanel('lb-popup'));
document.getElementById('s-skip').addEventListener('click',()=>{if(!isDrawer){showToast('Only drawer can skip','warn');return;}if(confirm('Skip word?'))wsSend({type:'skip_word'});closeAllPanels();});
document.getElementById('s-done').addEventListener('click',()=>{if(!isDrawer){showToast('Only drawer can finish','warn');return;}if(confirm('Finish?')){sendFinalImage(()=>wsSend({type:'done_drawing'}));}closeAllPanels();});
document.getElementById('s-new-canvas').addEventListener('click',()=>{if(!isDrawer){showToast('Only drawer can start a new canvas','warn');return;}if(confirm('Start a new canvas? Current canvas stays in chat.')){sendFinalImage(()=>wsSend({type:'new_canvas'}));}closeAllPanels();});
document.getElementById('s-theme').addEventListener('click',()=>{isDark=!isDark;applyTheme(isDark);document.getElementById('s-theme-val').textContent=isDark?'Off':'On';document.querySelector('#s-theme .s-icon').textContent=isDark?'☀️':'🌙';});
document.getElementById('s-sound').addEventListener('click',()=>{soundEnabled=!soundEnabled;document.getElementById('s-sound-val').textContent=soundEnabled?'On':'Off';showToast(soundEnabled?'Sound on 🔊':'Sound off 🔇');});
document.getElementById('s-save-drawing').addEventListener('click',()=>{saveDrawingFile();closeAllPanels();});
document.getElementById('s-send-bot').addEventListener('click',()=>{sendToTg();closeAllPanels();});
document.getElementById('s-logs').addEventListener('click',()=>{closeAllPanels();setTimeout(()=>{togglePanel('logs-popup');renderAllLogs();},10);});
document.getElementById('s-gallery').addEventListener('click',()=>{openGallery();closeAllPanels();});
document.querySelectorAll('.canvas-size-btn').forEach(btn=>{btn.addEventListener('click',()=>{const w=+btn.dataset.w,h=+btn.dataset.h;resizeCanvas(w,h);document.querySelectorAll('.canvas-size-btn').forEach(b=>b.classList.remove('on'));btn.classList.add('on');});});
document.getElementById('s-change-word').addEventListener('click',()=>{if(!isDrawer){showToast('Only drawer can change word','warn');return;}wsSend({type:'change_word'});showToast('New word…');closeAllPanels();});

// ─── Custom word popup ───
document.getElementById('s-custom-word').addEventListener('click',()=>{
  if(!isDrawer){showToast('Only drawer can set word','warn');return;}
  closeAllPanels();
  togglePanel('word-input-popup');
  document.getElementById('word-custom-in').value='';
  setTimeout(()=>document.getElementById('word-custom-in').focus(),50);
});
document.getElementById('word-custom-ok').addEventListener('click',()=>{
  const w=document.getElementById('word-custom-in').value.trim();
  if(!w){showToast('Enter a word first','warn');return;}
  wsSend({type:'set_custom_word',word:w});
  showToast(`Word set: ${w}`,'ok');
  closeAllPanels();
});
document.getElementById('word-custom-cancel').addEventListener('click',()=>closeAllPanels());
document.getElementById('word-custom-in').addEventListener('keydown',e=>{
  e.stopPropagation();
  if(e.key==='Enter')document.getElementById('word-custom-ok').click();
  if(e.key==='Escape')closeAllPanels();
});

// ─── Log controls ───
document.getElementById('log-refresh-btn').addEventListener('click',renderAllLogs);
document.getElementById('log-clear-btn').addEventListener('click',()=>{logBuf.length=0;const el=document.getElementById('log-entries');if(el)el.innerHTML='<div style="color:var(--text3);font-size:.68rem;padding:6px">Cleared.</div>';});
document.getElementById('log-copy-btn').addEventListener('click',()=>{const text=logBuf.map(e=>`${e.ts.toFixed(4).padStart(9)}  ${e.delta.toFixed(4).padStart(9)} — ${e.msg}`).join('\n');const copy=s=>{const ta=document.createElement('textarea');ta.value=s;ta.style.cssText='position:fixed;opacity:0;';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();};if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>showToast('Logs copied ✅','ok')).catch(()=>{copy(text);showToast('Logs copied ✅','ok');});}else{copy(text);showToast('Logs copied ✅','ok');}});

// ─── Start button ───
document.getElementById('start-btn').addEventListener('click',()=>{wsSend({type:'new_round'});document.getElementById('start-btn').style.display='none';addLog('New round requested','round');});

// ─── WebSocket ───
// ── Apply Telegram theme + setup ─────────────────────────────────────────────
(function applyTgTheme(){
  const tg=window.Telegram?.WebApp;
  if(!tg)return;
  tg.expand();
  tg.disableVerticalSwipes?.();
  const tp=tg.themeParams||{};
  const root=document.documentElement;
  if(tp.bg_color)          root.style.setProperty('--bg',      tp.bg_color);
  if(tp.secondary_bg_color)root.style.setProperty('--surface', tp.secondary_bg_color);
  if(tp.text_color)        root.style.setProperty('--text',     tp.text_color);
  if(tp.hint_color)        root.style.setProperty('--text2',    tp.hint_color);
  if(tp.button_color)      root.style.setProperty('--green',    tp.button_color);
  if(tp.button_text_color) root.style.setProperty('--btn-text', tp.button_text_color);
  if(tp.accent_text_color) root.style.setProperty('--yellow',   tp.accent_text_color);
  tg.setHeaderColor?.(tp.bg_color||'#1a1a2e');
  tg.setBackgroundColor?.(tp.bg_color||'#1a1a2e');
})();

let ws=null,myName='',myRoom='',myTgId='';
function wsSend(obj){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}
