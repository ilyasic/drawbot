'use strict';
function hsvToRgb(h,s,v){const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;let r=0,g=0,b=0;if(h<60){r=c;g=x;}else if(h<120){r=x;g=c;}else if(h<180){g=c;b=x;}else if(h<240){g=x;b=c;}else if(h<300){r=x;b=c;}else{r=c;b=x;}return[~~((r+m)*255),~~((g+m)*255),~~((b+m)*255)];}
function rgbToHsv(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0,s=max===0?0:d/max,v=max;if(d!==0){if(max===r)h=((g-b)/d+6)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;}return[h,s,v];}
function toHex(r,g,b){return'#'+[r,g,b].map(v=>Math.max(0,Math.min(255,~~v)).toString(16).padStart(2,'0')).join('');}
function hexToRgb(h){const c=parseInt(h.replace('#',''),16);return[(c>>16)&255,(c>>8)&255,c&255];}
function drawSBCanvas(){const cv=document.getElementById('cp-sb');if(!cv)return;const ctx=cv.getContext('2d'),w=cv.width,h=cv.height;const gS=ctx.createLinearGradient(0,0,w,0);gS.addColorStop(0,'#fff');gS.addColorStop(1,`hsl(${_cpH},100%,50%)`);ctx.fillStyle=gS;ctx.fillRect(0,0,w,h);const gV=ctx.createLinearGradient(0,0,0,h);gV.addColorStop(0,'rgba(0,0,0,0)');gV.addColorStop(1,'#000');ctx.fillStyle=gV;ctx.fillRect(0,0,w,h);const cur=document.getElementById('cp-cursor');if(cur){cur.style.left=(_cpS*100)+'%';cur.style.top=((1-_cpV)*100)+'%';}}
function drawHueBar(){const cv=document.getElementById('cp-hue');if(!cv)return;const ctx=cv.getContext('2d'),w=cv.width,h=cv.height;const g=ctx.createLinearGradient(0,0,w,0);for(let i=0;i<=12;i++)g.addColorStop(i/12,`hsl(${i*30},100%,50%)`);ctx.fillStyle=g;ctx.fillRect(0,0,w,h);const cur=document.getElementById('cp-hue-cursor');if(cur)cur.style.left=(_cpH/360*100)+'%';}
function syncPickerFromColor(hex){try{const[r,g,b]=hexToRgb(hex);[_cpH,_cpS,_cpV]=rgbToHsv(r,g,b);['cp-r','cp-g','cp-b'].forEach((id,i)=>{const el=document.getElementById(id);if(el)el.value=[r,g,b][i];});['cp-r-lbl','cp-g-lbl','cp-b-lbl'].forEach((id,i)=>{const el=document.getElementById(id);if(el)el.textContent=[r,g,b][i];});const eh=document.getElementById('cp-hex');if(eh)eh.value=hex;const ep=document.getElementById('cp-preview');if(ep)ep.style.background=hex;drawSBCanvas();drawHueBar();}catch(e){}}
function applyPickerColor(){const[r,g,b]=hsvToRgb(_cpH,_cpS,_cpV);const hex=toHex(r,g,b);['cp-r','cp-g','cp-b'].forEach((id,i)=>{document.getElementById(id).value=[r,g,b][i];document.getElementById(id+'-lbl').textContent=[r,g,b][i];});document.getElementById('cp-hex').value=hex;document.getElementById('cp-preview').style.background=hex;setColorRaw(hex);}
function applyRgbSliders(){const r=+document.getElementById('cp-r').value,g=+document.getElementById('cp-g').value,b=+document.getElementById('cp-b').value;['cp-r-lbl','cp-g-lbl','cp-b-lbl'].forEach((id,i)=>{document.getElementById(id).textContent=[r,g,b][i];});[_cpH,_cpS,_cpV]=rgbToHsv(r,g,b);const hex=toHex(r,g,b);document.getElementById('cp-hex').value=hex;document.getElementById('cp-preview').style.background=hex;drawSBCanvas();drawHueBar();setColorRaw(hex);}
function sbInteract(e){const cv=document.getElementById('cp-sb');const r=cv.getBoundingClientRect();_cpS=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));_cpV=Math.max(0,Math.min(1,1-(e.clientY-r.top)/r.height));applyPickerColor();}
function hueInteract(e){const cv=document.getElementById('cp-hue');const r=cv.getBoundingClientRect();_cpH=Math.max(0,Math.min(360,((e.clientX-r.left)/r.width)*360));drawSBCanvas();drawHueBar();applyPickerColor();}
let _sbDrag=false,_hueDrag=false;
document.addEventListener('DOMContentLoaded',()=>{
  const sb=document.getElementById('cp-sb'),hue=document.getElementById('cp-hue');if(!sb)return;
  sb.addEventListener('pointerdown',e=>{_sbDrag=true;sb.setPointerCapture(e.pointerId);sbInteract(e);e.stopPropagation();},{passive:false});sb.addEventListener('pointermove',e=>{if(_sbDrag){sbInteract(e);e.stopPropagation();}},{passive:false});sb.addEventListener('pointerup',()=>_sbDrag=false);
  hue.addEventListener('pointerdown',e=>{_hueDrag=true;hue.setPointerCapture(e.pointerId);hueInteract(e);e.stopPropagation();},{passive:false});hue.addEventListener('pointermove',e=>{if(_hueDrag){hueInteract(e);e.stopPropagation();}},{passive:false});hue.addEventListener('pointerup',()=>_hueDrag=false);
  ['cp-r','cp-g','cp-b'].forEach(id=>document.getElementById(id)?.addEventListener('input',applyRgbSliders));
  document.getElementById('cp-apply-hex')?.addEventListener('click',()=>{let h=document.getElementById('cp-hex').value.trim();if(!h.startsWith('#'))h='#'+h;if(/^#[0-9a-fA-F]{6}$/.test(h)){syncPickerFromColor(h);setColorRaw(h);}});
  document.getElementById('cp-hex')?.addEventListener('keydown',e=>{if(e.key==='Enter'){let h=e.target.value.trim();if(!h.startsWith('#'))h='#'+h;if(/^#[0-9a-fA-F]{6}$/.test(h)){syncPickerFromColor(h);setColorRaw(h);}}e.stopPropagation();});
  drawSBCanvas();drawHueBar();
});

// ─── Color Palette ───
const PAL={basic:['#000000','#ffffff','#e63946','#f4842d','#ffd166','#3dd68c','#118ab2','#7c6ff7'],pastel:['#ffb3ba','#ffdfba','#ffffba','#baffc9','#bae1ff','#e8baff','#ffd4ba','#c9ffba'],neon:['#ff0090','#ff6600','#ffee00','#00ff41','#00cfff','#7b00ff','#ff00ff','#00ffcc']};
function renderPalette(){['basic','pastel','neon'].forEach(g=>{const row=document.getElementById('colors-'+g);if(!row)return;row.innerHTML='';PAL[g].forEach(hex=>{const d=document.createElement('div');d.className='cswatch';d.style.background=hex;if(hex===currentColor)d.classList.add('on');d.addEventListener('click',()=>{setColor(hex);});row.appendChild(d);});});}
function setColorRaw(hex){if(!/^#[0-9a-fA-F]{6}$/.test(hex))return;currentColor=hex;updateColorDot(hex);document.querySelectorAll('.cswatch').forEach(s=>{const bg=s.style.background;const sw=bg.startsWith('#')?bg:cssToHex(bg);s.classList.toggle('on',sw===hex);});if(brushType==='eraser'){brushType='pen';updateBrushBtn();}}
function cssToHex(css){const m=css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);if(!m)return css;return toHex(+m[1],+m[2],+m[3]);}
function setColor(hex){if(!/^#[0-9a-fA-F]{6}$/.test(hex))return;setColorRaw(hex);syncPickerFromColor(hex);closeAllPanels();}
function updateColorDot(hex){const d=document.getElementById('color-dot');if(d)d.style.background=hex;const s=document.getElementById('sz-dot');if(s)s.style.background=hex;}

// ─── Brush icon map ───
const IC={pen:'🖊',pencil:'✏️',pastel:'🖍',marker:'〰',bristle:'🎨',ink:'🪶',watercolor:'💧',airbrush:'🌫',line:'╱',eraser:'🧽',fill:'🪣',eyedrop:'💉'};
function updateBrushBtn(){const btn=document.getElementById('btn-brush');if(btn)btn.innerHTML=(IC[brushType]||'🖊')+`<div class="color-dot" id="color-dot" style="background:${currentColor}"></div>`;document.getElementById('btn-fill')?.classList.toggle('on',brushType==='fill');document.getElementById('btn-eyedrop')?.classList.toggle('on',brushType==='eyedrop');document.getElementById('btn-brush')?.classList.toggle('on',brushType!=='fill'&&brushType!=='eyedrop');}
function setBrush(t){brushType=t;document.querySelectorAll('.brush-opt').forEach(b=>b.classList.toggle('on',b.dataset.brush===t));updateBrushBtn();updateSmoothSlider();
  // Show/hide fog density for airbrush
  document.getElementById('airbrush-density-wrap').style.display=(t==='airbrush')?'block':'none';
}
function updateSmoothSlider(){const sm=bSettings[brushType]?.smoothing??.5,fl=bSettings[brushType]?.flow??.8;document.getElementById('smooth-range').value=~~(sm*100);document.getElementById('smooth-lbl').textContent=~~(sm*100)+'%';document.getElementById('flow-range').value=~~(fl*100);document.getElementById('flow-lbl').textContent=~~(fl*100)+'%';}
document.querySelectorAll('.brush-opt').forEach(el=>el.addEventListener('click',()=>setBrush(el.dataset.brush)));
document.getElementById('stab-range').addEventListener('input',e=>{LAZY_RADIUS=+e.target.value;document.getElementById('stab-lbl').textContent=e.target.value+'px';});
document.getElementById('smooth-range').addEventListener('input',e=>{const v=+e.target.value/100;document.getElementById('smooth-lbl').textContent=e.target.value+'%';bSettings[brushType].smoothing=v;});
document.getElementById('flow-range').addEventListener('input',e=>{brushFlow=+e.target.value/100;document.getElementById('flow-lbl').textContent=e.target.value+'%';bSettings[brushType].flow=brushFlow;});
document.getElementById('fog-range').addEventListener('input',e=>{fogDensity=+e.target.value/100;document.getElementById('fog-lbl').textContent=e.target.value+'%';});

// ─── Size slider with live preview ───
function updateSzLbl(){
  const sz=brushSize;
  document.getElementById('sz-op-size').textContent=sz+'px';
  document.getElementById('sz-op-opacity').textContent=~~(brushOpacity*100)+'%';
  document.getElementById('sz-lbl').textContent=sz+'px';
  // Live preview dot - scaled to show exact brush size feel
  const dot=document.getElementById('sz-dot');if(dot){
    const vis=Math.max(3,Math.min(32,sz*0.8));
    dot.style.width=vis+'px';dot.style.height=vis+'px';
    dot.style.background=currentColor;
    dot.style.borderRadius='50%';
    dot.style.transition='all .1s';
  }
}
document.getElementById('sz-range').addEventListener('input',e=>{brushSize=+e.target.value;updateSzLbl();});
document.getElementById('op-range').addEventListener('input',e=>{brushOpacity=+e.target.value/100;document.getElementById('op-lbl').textContent=e.target.value+'%';updateSzLbl();});

// ─── Panels ───
