'use strict';
function mkLayer(name){
  const c=document.createElement('canvas');c.width=CW;c.height=CH;
  const ctx=c.getContext('2d');ctx.lineCap=ctx.lineJoin='round';
  return{id:Date.now()+Math.random(),name,canvas:c,ctx,visible:true,opacity:1,locked:false,blendMode:'source-over',maskCanvas:null,maskCtx:null,_committed:null};
}
function initCanvases(){
  [bgCv,layersCv,drawCv,prevCv].forEach(c=>{c.width=CW;c.height=CH;c.style.width=CW+'px';c.style.height=CH+'px';});
  wrap.style.width=CW+'px';wrap.style.height=CH+'px';
  bgCtx=bgCv.getContext('2d');layersCtx=layersCv.getContext('2d');
  drawCtx=drawCv.getContext('2d');prevCtx=prevCv.getContext('2d');
  bgCtx.fillStyle='#fff';bgCtx.fillRect(0,0,CW,CH);
  drawCtx.lineCap=drawCtx.lineJoin='round';
  layers=[];actIdx=0;editMask=false;
  layers.push(mkLayer('Layer 1'));
  renderLayerPanel();composite();
  setTimeout(fitCanvas,0);setTimeout(fitCanvas,100);setTimeout(fitCanvas,350);setTimeout(fitCanvas,700);
}
function resizeCanvas(newW,newH){
  if(newW===CW&&newH===CH)return;
  if(!confirm(`Resize canvas to ${newW}×${newH}? This will clear all layers.`))return;
  CW=newW;CH=newH;
  [bgCv,layersCv,drawCv,prevCv].forEach(c=>{c.width=CW;c.height=CH;c.style.width=CW+'px';c.style.height=CH+'px';});
  wrap.style.width=CW+'px';wrap.style.height=CH+'px';
  bgCtx=bgCv.getContext('2d');layersCtx=layersCv.getContext('2d');
  drawCtx=drawCv.getContext('2d');prevCtx=prevCv.getContext('2d');
  drawCtx.lineCap=drawCtx.lineJoin='round';
  bgCtx.fillStyle='#fff';bgCtx.fillRect(0,0,CW,CH);
  layers=[];actIdx=0;editMask=false;
  layers.push(mkLayer('Layer 1'));
  renderLayerPanel();composite();fitCanvas();
  document.getElementById('s-canvas-info').textContent=`${CW} × ${CH} px`;
  if(isDrawer)wsSend({type:'canvas_size',w:CW,h:CH});
  showToast(`Canvas: ${CW}×${CH}`,'ok');
}
function actLayer(){return layers[actIdx];}
function actCtx(){const l=actLayer();if(!l){layers.push(mkLayer('Layer 1'));actIdx=0;}const la=actLayer();return(editMask&&la.maskCtx)?la.maskCtx:la.ctx;}

function makeTmp(){const c=document.createElement('canvas');c.width=CW;c.height=CH;return c;}
let _cPending=false;
function scheduleComposite(){if(_cPending)return;_cPending=true;requestAnimationFrame(()=>{_cPending=false;composite();});}
function composite(){
  layersCtx.clearRect(0,0,CW,CH);
  layers.forEach(l=>{
    if(!l.visible)return;
    let src=l.canvas;
    if(l.maskCanvas){const tmp=makeTmp();const tc=tmp.getContext('2d');tc.drawImage(l.canvas,0,0);tc.globalCompositeOperation='destination-in';tc.drawImage(l.maskCanvas,0,0);src=tmp;}
    layersCtx.save();layersCtx.globalAlpha=l.opacity;layersCtx.globalCompositeOperation=l.blendMode||'source-over';layersCtx.drawImage(src,0,0);layersCtx.restore();
  });
}
function flattenTo(tc){
  tc.fillStyle='#fff';tc.fillRect(0,0,CW,CH);
  layers.forEach(l=>{
    if(!l.visible)return;
    let src=l.canvas;
    if(l.maskCanvas){const tmp=makeTmp();const t2=tmp.getContext('2d');t2.drawImage(l.canvas,0,0);t2.globalCompositeOperation='destination-in';t2.drawImage(l.maskCanvas,0,0);src=tmp;}
    tc.save();tc.globalAlpha=l.opacity;tc.globalCompositeOperation=l.blendMode||'source-over';tc.drawImage(src,0,0);tc.restore();
  });
  tc.globalAlpha=1;tc.globalCompositeOperation='source-over';
}
function clearAll(){
  layers.forEach(l=>{l.ctx.clearRect(0,0,CW,CH);l._committed=null;if(l.maskCtx){l.maskCtx.fillStyle='#fff';l.maskCtx.fillRect(0,0,CW,CH);}});
  if(drawCtx)drawCtx.clearRect(0,0,CW,CH);
  bgCtx.fillStyle='#fff';bgCtx.fillRect(0,0,CW,CH);composite();
}

// ─── Canvas Navigation: smooth zoom, smooth pan ───
let zoom=1,panX=0,panY=0,_tz=1,_tx=0,_ty=0,_raf=null,_fz=1;
const zoomEl=document.getElementById('zoom-indicator');
const btnFit=document.getElementById('btn-fit-canvas');
let _zt=null;
function applyT(){wrap.style.transform=`translate(${panX}px,${panY}px) scale(${zoom})`;}
function _animZ(){
  const e=.2,dz=_tz-zoom,dx=_tx-panX,dy=_ty-panY;
  if(Math.abs(dz)<.0004&&Math.abs(dx)<.2&&Math.abs(dy)<.2){zoom=_tz;panX=_tx;panY=_ty;applyT();_raf=null;return;}
  zoom+=dz*e;panX+=dx*e;panY+=dy*e;applyT();_raf=requestAnimationFrame(_animZ);
}
function kick(){if(!_raf)_raf=requestAnimationFrame(_animZ);}
function zoomTo(nz,ox,oy){nz=Math.max(.1,Math.min(16,nz));_tx=ox-(ox-_tx)*(nz/_tz);_ty=oy-(oy-_ty)*(nz/_tz);_tz=nz;kick();showZHUD(nz);}
function showZHUD(z){if(zoomEl){zoomEl.textContent=Math.round(z*100)+'%';zoomEl.classList.add('show');clearTimeout(_zt);_zt=setTimeout(()=>zoomEl.classList.remove('show'),1400);}if(btnFit)btnFit.classList.toggle('visible',Math.abs(z-_fz)>.04);}
function fitCanvas(){
  const r=area.getBoundingClientRect();let aw=r.width,ah=r.height;
  if(aw<10){aw=window.innerWidth;const tb=document.getElementById('topbar');ah=window.innerHeight-(tb?tb.getBoundingClientRect().height:48);}
  if(aw<10){requestAnimationFrame(fitCanvas);return;}
  const fz=Math.min(aw/CW,ah/CH,1);
  _fz=fz;_tz=fz;_tx=(aw-CW*fz)/2;_ty=(ah-CH*fz)/2;
  zoom=_tz;panX=_tx;panY=_ty;applyT();btnFit?.classList.remove('visible');
}
setTimeout(fitCanvas,0);setTimeout(fitCanvas,100);setTimeout(fitCanvas,400);
window.addEventListener('resize',fitCanvas);
function c2cv(cx,cy){const r=area.getBoundingClientRect();return[(cx-r.left-panX)/zoom,(cy-r.top-panY)/zoom];}

// ─── Pan state: Space/Alt drag ───
let _spaceDown=false,_altDown=false,_panDragging=false,_panSX=0,_panSY=0,_panPX=0,_panPY=0;

// ─── Pinch/two-finger pan ───
let _pinch=false,_pinchDist=0,_pinchMx=0,_pinchMy=0,_pinchZoom=1,_twoFinger=false,_tfSX=0,_tfSY=0,_tfPX=0,_tfPY=0;
let _pinchAngle=0,_pinchRotating=false;

area.addEventListener('touchstart',e=>{
  if(e.touches.length===2){
    e.preventDefault();e.stopPropagation();isDrawing=false;
    const t=e.touches;
    _pinchDist=Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
    _pinchZoom=zoom;_pinch=true;_twoFinger=true;
    const r=area.getBoundingClientRect();
    _pinchMx=(t[0].clientX+t[1].clientX)/2-r.left;
    _pinchMy=(t[0].clientY+t[1].clientY)/2-r.top;
    _tfSX=_pinchMx;_tfSY=_pinchMy;_tfPX=panX;_tfPY=panY;
    _pinchAngle=Math.atan2(t[1].clientY-t[0].clientY,t[1].clientX-t[0].clientX);
  } else if(e.touches.length===1&&isDrawer){
    e.preventDefault();
  }
},{passive:false});

area.addEventListener('touchmove',e=>{
  e.preventDefault();e.stopPropagation();
  if(e.touches.length===2&&_pinch){
    const t=e.touches;const r=area.getBoundingClientRect();
    const cx=(t[0].clientX+t[1].clientX)/2-r.left;
    const cy=(t[0].clientY+t[1].clientY)/2-r.top;
    const d=Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
    const nz=Math.max(.1,Math.min(16,_pinchZoom*(d/_pinchDist)));
    // Pan: two-finger drag shifts
    const dpx=cx-_tfSX,dpy=cy-_tfSY;
    _tz=nz;_tx=_tfPX+dpx-(cx-(cx-panX)*(nz/zoom));_ty=_tfPY+dpy-(cy-(cy-panY)*(nz/zoom));
    // Instant update for pinch (no lag)
    zoom=nz;panX=_tz===nz?(_tfPX+(cx-_tfSX)):panX;panY=_tz===nz?(_tfPY+(cy-_tfSY)):panY;
    // Simpler instant update
    const dzoom=d/_pinchDist;
    const nz2=Math.max(.1,Math.min(16,_pinchZoom*dzoom));
    panX=_pinchMx-((_pinchMx-_tfPX)*(nz2/_pinchZoom))+(cx-_tfSX);
    panY=_pinchMy-((_pinchMy-_tfPY)*(nz2/_pinchZoom))+(cy-_tfSY);
    zoom=nz2;_tz=nz2;_tx=panX;_ty=panY;
    applyT();showZHUD(nz2);
  }
},{passive:false});
area.addEventListener('touchend',e=>{if(e.touches.length<2){_pinch=false;_twoFinger=false;}},{passive:true});
area.addEventListener('wheel',e=>{
  e.preventDefault();
  const r=area.getBoundingClientRect();
  const factor=e.ctrlKey?0.95:0.91;
  zoomTo(_tz*(e.deltaY<0?1.1:factor),e.clientX-r.left,e.clientY-r.top);
},{passive:false});
btnFit?.addEventListener('click',()=>{const r=area.getBoundingClientRect();_tz=_fz;_tx=(r.width-CW*_fz)/2;_ty=(r.height-CH*_fz)/2;kick();showZHUD(_fz);});

// ─── Brush definitions ───
const BD={
  pen:       {smoothing:.5,alpha:1.0,widthMult:1.0,cap:'round',pressure:true, flow:.8},
  pencil:    {smoothing:.3,alpha:.75,widthMult:.8, cap:'round',pressure:true, flow:.7},
  pastel:    {smoothing:.4,alpha:.8, widthMult:1.0,cap:'round',pressure:true, flow:.65},
  marker:    {smoothing:.6,alpha:.55,widthMult:1.6,cap:'round',pressure:false,flow:.9},
  bristle:   {smoothing:.2,alpha:.5, widthMult:1.0,cap:'round',pressure:true, flow:.6},
  ink:       {smoothing:.7,alpha:1.0,widthMult:1.0,cap:'round',pressure:true, flow:1.0},
  watercolor:{smoothing:.6,alpha:.25,widthMult:2.0,cap:'round',pressure:true, flow:.5},
  airbrush:  {smoothing:.0,alpha:.04,widthMult:1.0,cap:'round',pressure:false,flow:.7},
  line:      {smoothing:.0,alpha:1.0,widthMult:1.0,cap:'round',pressure:false,flow:1.0},
  eraser:    {smoothing:.5,alpha:1.0,widthMult:1.0,cap:'round',pressure:false,flow:1.0},
  fill:      {smoothing:1, alpha:1.0,widthMult:1.0,cap:'round',pressure:false,flow:1.0},
  eyedrop:   {smoothing:0, alpha:1.0,widthMult:1.0,cap:'round',pressure:false,flow:1.0},
};
const bSettings={};Object.keys(BD).forEach(b=>bSettings[b]={...BD[b]});
let brushType='pen',brushSize=8,brushOpacity=1,brushFlow=.8,currentColor='#1a1a2e';
let fogDensity=0.4; // airbrush fog density 0-1
let isDrawing=false,curStroke=null,lastX=0,lastY=0,ptrId=null,lsx=0,lsy=0;
let lazyX=0,lazyY=0,LAZY_RADIUS=3;

// ─── Undo/Redo ───
const US=new WeakMap(),RS=new WeakMap();
function gs(l,m){if(!m.has(l))m.set(l,[]);return m.get(l);}
function saveUndo(){const l=actLayer();if(!l)return;const ctx=actCtx(),st=gs(l,US);st.push(ctx.getImageData(0,0,CW,CH));if(st.length>24)st.shift();gs(l,RS).length=0;}
function doUndo(){
  const l=actLayer();if(!l)return;
  const ctx=actCtx(),us=gs(l,US),rs=gs(l,RS);if(!us.length)return;
  rs.push(ctx.getImageData(0,0,CW,CH));if(rs.length>24)rs.shift();
  ctx.putImageData(us.pop(),0,0);l._committed=ctx.getImageData(0,0,CW,CH);
  composite();wsSend({type:'undo'});showSyncDone();addLog('Undo','draw');
}
function doRedo(){
  const l=actLayer();if(!l)return;
  const ctx=actCtx(),us=gs(l,US),rs=gs(l,RS);if(!rs.length)return;
  us.push(ctx.getImageData(0,0,CW,CH));if(us.length>24)us.shift();
  ctx.putImageData(rs.pop(),0,0);l._committed=ctx.getImageData(0,0,CW,CH);
  composite();wsSend({type:'redo'});showSyncDone();addLog('Redo','draw');
}

// ─── Curve smoothing (centripetal Catmull-Rom) ───
