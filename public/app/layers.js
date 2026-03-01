'use strict';
function deleteCurrentLayer(){
  if(layers.length<=1){showToast('Cannot delete last layer','warn');return;}
  layers.splice(actIdx,1);actIdx=Math.max(0,actIdx-1);
  renderLayerPanel();composite();showToast('Layer deleted');
}

// ─── Layer Panel ───
function renderLayerPanel(){
  const list=document.getElementById('layer-list');if(!list)return;
  list.innerHTML='';
  for(let i=layers.length-1;i>=0;i--){
    const l=layers[i],isAct=i===actIdx;
    const row=document.createElement('div');
    row.className='layer-row'+(isAct?' active':'')+(isAct&&editMask?' mask-editing':'');
    const vis=document.createElement('span');vis.className='layer-vis'+(l.visible?' on':'');vis.textContent='👁';
    vis.addEventListener('click',ev=>{ev.stopPropagation();l.visible=!l.visible;renderLayerPanel();composite();});
    const name=document.createElement('span');name.className='layer-name';name.textContent=l.name;
    name.addEventListener('dblclick',ev=>{ev.stopPropagation();const inp=document.createElement('input');inp.className='layer-name-input';inp.value=l.name;inp.addEventListener('blur',()=>{l.name=inp.value.trim()||l.name;renderLayerPanel();});inp.addEventListener('keydown',e=>{if(e.key==='Enter'){inp.blur();}e.stopPropagation();});name.replaceWith(inp);inp.focus();inp.select();});
    const blendSel=document.createElement('select');blendSel.className='blend-btn';
    BLENDS.forEach(b=>{const o=document.createElement('option');o.value=b;o.textContent=BLEND_LBL[b];if(b===l.blendMode)o.selected=true;blendSel.appendChild(o);});
    blendSel.addEventListener('change',ev=>{ev.stopPropagation();l.blendMode=blendSel.value;composite();});
    blendSel.addEventListener('pointerdown',ev=>ev.stopPropagation());
    const opSlider=document.createElement('input');opSlider.type='range';opSlider.className='layer-op-slider';opSlider.min=0;opSlider.max=100;opSlider.value=~~(l.opacity*100);
    opSlider.addEventListener('input',ev=>{ev.stopPropagation();l.opacity=+opSlider.value/100;composite();});
    opSlider.addEventListener('pointerdown',ev=>ev.stopPropagation());
    const lock=document.createElement('span');lock.className='layer-lock'+(l.locked?' on':'');lock.textContent='🔒';
    lock.addEventListener('click',ev=>{ev.stopPropagation();l.locked=!l.locked;renderLayerPanel();showToast(l.locked?'Layer locked':'Layer unlocked');});
    row.appendChild(vis);row.appendChild(name);row.appendChild(blendSel);row.appendChild(opSlider);row.appendChild(lock);
    if(layers.length>1){const del=document.createElement('span');del.style.cssText='cursor:pointer;font-size:.72rem;color:var(--red);flex-shrink:0;';del.textContent='✕';del.addEventListener('click',ev=>{ev.stopPropagation();layers.splice(i,1);if(actIdx>=layers.length)actIdx=layers.length-1;editMask=false;composite();renderLayerPanel();});row.appendChild(del);}
    row.addEventListener('click',()=>{actIdx=i;editMask=false;renderLayerPanel();updateMaskInd();});
    list.appendChild(row);
    // Mask sub-row
    if(l.maskCanvas){
      const isMaskEd=isAct&&editMask;
      const mr=document.createElement('div');mr.className='layer-row mask-sub'+(isMaskEd?' mask-editing':'');
      mr.innerHTML=`<span style="font-size:.72rem;flex-shrink:0">⬛</span><span class="layer-name" style="font-style:italic">Mask</span>`;
      const mExit=document.createElement('span');mExit.style.cssText='font-size:.65rem;color:var(--text3);cursor:pointer;flex-shrink:0;padding:2px 4px;border-radius:4px;border:1px solid var(--border)';mExit.textContent=isMaskEd?'✓ Done':'Edit';mExit.addEventListener('click',ev=>{ev.stopPropagation();actIdx=i;editMask=!isMaskEd;renderLayerPanel();updateMaskInd();if(!isMaskEd)showToast('Painting mask — black hides, white reveals');});
      const mDel=document.createElement('span');mDel.style.cssText='font-size:.65rem;color:var(--red);cursor:pointer;flex-shrink:0;padding:2px 4px;';mDel.textContent='✕';mDel.addEventListener('click',ev=>{ev.stopPropagation();layers[i].maskCanvas=null;layers[i].maskCtx=null;if(actIdx===i)editMask=false;composite();renderLayerPanel();updateMaskInd();showToast('Mask removed');});
      mr.appendChild(mExit);mr.appendChild(mDel);
      mr.addEventListener('click',()=>{actIdx=i;editMask=true;renderLayerPanel();updateMaskInd();showToast('Painting mask');});
      list.appendChild(mr);
    }
  }
}
function updateMaskInd(){document.getElementById('mask-indicator').classList.toggle('show',editMask);}

// ─── Layer transform controls ───
// _txLayerIdx stores which layer we are transforming — all ops target only that layer
let _txActive=false,_txLayerIdx=-1,_txOrigData=null;
let _txX=0,_txY=0,_txW=0,_txH=0,_txRot=0,_txCX=0,_txCY=0;
let _txDragging=false,_txHandle=null,_txSX=0,_txSY=0,_txOX=0,_txOY=0,_txOW=0,_txOH=0;

function _exitTransformMode(){
  _txActive=false;_txLayerIdx=-1;_txOrigData=null;
  document.getElementById('transform-overlay').classList.remove('active');
  document.getElementById('transform-indicator').classList.remove('show');
  document.getElementById('layer-transform').classList.remove('on');
  document.getElementById('btn-transform-tb')?.classList.remove('tx-active');
  document.getElementById('transform-btns').classList.remove('show');
}
function startTransform(){
  const l=actLayer();if(!l){showToast('No active layer','warn');return;}
  _txActive=true;_txLayerIdx=actIdx;
  _txOrigData=l.ctx.getImageData(0,0,CW,CH);
  _txX=0;_txY=0;_txW=CW;_txH=CH;_txRot=0;
  _txCX=CW/2;_txCY=CH/2;
  updateTxBox();
  document.getElementById('transform-overlay').classList.add('active');
  document.getElementById('transform-indicator').classList.add('show');
  document.getElementById('layer-transform').classList.add('on');
  document.getElementById('btn-transform-tb')?.classList.add('tx-active');
  document.getElementById('transform-btns').classList.add('show');
  closeAllPanels();showToast('Transform: drag handles • ESC cancel • Enter apply');
}
function updateTxBox(){
  if(!_txActive)return;
  const box=document.getElementById('transform-box');
  const ox=panX+_txX*zoom,oy=panY+_txY*zoom;
  const ow=_txW*zoom,oh=_txH*zoom;
  box.style.left=ox+'px';box.style.top=oy+'px';
  box.style.width=ow+'px';box.style.height=oh+'px';
  box.style.transform=`rotate(${_txRot}rad)`;
  box.style.transformOrigin=`${(_txCX-_txX)*zoom}px ${(_txCY-_txY)*zoom}px`;
}
function _txTargetLayer(){return _txLayerIdx>=0?layers[_txLayerIdx]:null;}
function makeTmpFromData(imgData){
  const c=document.createElement('canvas');c.width=CW;c.height=CH;
  c.getContext('2d').putImageData(imgData,0,0);return c;
}
function _previewTransform(){
  const l=_txTargetLayer();if(!l||!_txOrigData)return;
  const tmp=makeTmp();const tc=tmp.getContext('2d');
  tc.save();
  tc.translate(_txCX,_txCY);tc.rotate(_txRot);tc.translate(-_txCX,-_txCY);
  tc.drawImage(makeTmpFromData(_txOrigData),_txX,_txY,_txW,_txH);
  tc.restore();
  l.ctx.clearRect(0,0,CW,CH);
  l.ctx.drawImage(tmp,0,0);
  composite();
}
function cancelTransform(){
  const l=_txTargetLayer();
  if(l&&_txOrigData){
    l.ctx.putImageData(_txOrigData,0,0);
    l._committed=_txOrigData;
    composite();
  }
  _exitTransformMode();
  showToast('Transform cancelled');
}
function endTransform(){
  const l=_txTargetLayer();if(!l)return;
  _previewTransform();
  l._committed=l.ctx.getImageData(0,0,CW,CH);
  _exitTransformMode();
  showToast('Transform applied ✓','ok');
  // Flatten all visible layers and broadcast so guessers see the result
  try{
    const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;
    flattenTo(tmp.getContext('2d'));
    const dataURL=tmp.toDataURL('image/jpeg',0.82);
    wsSend({type:'snapshot',data:dataURL});
    showSyncSpin();
  }catch(e){console.error('[transform broadcast]',e);}
}

document.getElementById('transform-done').addEventListener('click',e=>{e.stopPropagation();endTransform();});
document.getElementById('transform-cancel').addEventListener('click',e=>{e.stopPropagation();cancelTransform();});
document.getElementById('btn-transform-tb')?.addEventListener('click',()=>{
  if(!isDrawer)return;
  if(_txActive){endTransform();}else{startTransform();}
});


// Handle transform handles
const txOverlay=document.getElementById('transform-overlay');
txOverlay.addEventListener('pointerdown',e=>{
  if(!_txActive)return;
  const hid=e.target.id;
  _txDragging=true;_txHandle=hid;_txSX=e.clientX;_txSY=e.clientY;
  _txOX=_txX;_txOY=_txY;_txOW=_txW;_txOH=_txH;
  txOverlay.setPointerCapture?.(e.pointerId);
  e.stopPropagation();
},{passive:false});
txOverlay.addEventListener('pointermove',e=>{
  if(!_txDragging||!_txActive)return;
  const ddx=(e.clientX-_txSX)/zoom;
  const ddy=(e.clientY-_txSY)/zoom;
  if(_txHandle==='tx-move'||_txHandle==='transform-box'){
    _txX=_txOX+ddx;_txY=_txOY+ddy;_txCX=_txX+_txW/2;_txCY=_txY+_txH/2;
  }else if(_txHandle==='tx-br'){
    _txW=Math.max(20,_txOW+ddx);_txH=Math.max(20,_txOH+ddy);_txCX=_txX+_txW/2;_txCY=_txY+_txH/2;
  }else if(_txHandle==='tx-tl'){
    _txX=_txOX+ddx;_txY=_txOY+ddy;_txW=Math.max(20,_txOW-ddx);_txH=Math.max(20,_txOH-ddy);_txCX=_txX+_txW/2;_txCY=_txY+_txH/2;
  }else if(_txHandle==='tx-tr'){
    _txY=_txOY+ddy;_txW=Math.max(20,_txOW+ddx);_txH=Math.max(20,_txOH-ddy);_txCX=_txX+_txW/2;_txCY=_txY+_txH/2;
  }else if(_txHandle==='tx-bl'){
    _txX=_txOX+ddx;_txW=Math.max(20,_txOW-ddx);_txH=Math.max(20,_txOH+ddy);_txCX=_txX+_txW/2;_txCY=_txY+_txH/2;
  }else if(_txHandle==='tx-rot'){
    const cx=panX+_txCX*zoom,cy=panY+_txCY*zoom;
    const angle=Math.atan2(e.clientY-cy,e.clientX-cx);
    const startAngle=Math.atan2(_txSY-cy,_txSX-cx);
    _txRot=angle-startAngle;
  }
  updateTxBox();_previewTransform();
  e.stopPropagation();
},{passive:false});
txOverlay.addEventListener('pointerup',()=>{_txDragging=false;},{passive:true});

document.getElementById('layer-transform').addEventListener('click',()=>{startTransform();closeAllPanels();});


// Layer actions
document.getElementById('layer-add').addEventListener('click',()=>{if(layers.length>=MAX_LAYERS){showToast('Max layers','warn');return;}const nl=mkLayer(`Layer ${layers.length+1}`);layers.push(nl);actIdx=layers.length-1;renderLayerPanel();composite();showToast('Layer added');});
document.getElementById('layer-add-mask').addEventListener('click',()=>{const l=actLayer();if(!l)return;if(!l.maskCanvas){const mc=document.createElement('canvas');mc.width=CW;mc.height=CH;const mctx=mc.getContext('2d');mctx.fillStyle='#fff';mctx.fillRect(0,0,CW,CH);l.maskCanvas=mc;l.maskCtx=mctx;}actIdx=layers.indexOf(l);editMask=!editMask;renderLayerPanel();updateMaskInd();composite();showToast(editMask?'Editing mask':'Mask added');});
document.getElementById('layer-duplicate').addEventListener('click',()=>{if(layers.length>=MAX_LAYERS){showToast('Max layers','warn');return;}const l=actLayer();if(!l)return;const nl=mkLayer(l.name+' copy');nl.ctx.drawImage(l.canvas,0,0);nl.opacity=l.opacity;nl.blendMode=l.blendMode;nl._committed=nl.ctx.getImageData(0,0,CW,CH);if(l.maskCanvas){const mc=document.createElement('canvas');mc.width=CW;mc.height=CH;const mctx=mc.getContext('2d');mctx.drawImage(l.maskCanvas,0,0);nl.maskCanvas=mc;nl.maskCtx=mctx;}layers.push(nl);actIdx=layers.length-1;renderLayerPanel();composite();showToast('Layer duplicated');});
document.getElementById('layer-merge-down').addEventListener('click',()=>{if(actIdx===0){showToast('Nothing below','warn');return;}const top=layers[actIdx],bot=layers[actIdx-1];bot.ctx.save();bot.ctx.globalAlpha=top.opacity;bot.ctx.globalCompositeOperation=top.blendMode||'source-over';bot.ctx.drawImage(top.canvas,0,0);bot.ctx.restore();bot._committed=bot.ctx.getImageData(0,0,CW,CH);layers.splice(actIdx,1);actIdx--;renderLayerPanel();composite();showToast('Merged down');sendVcUpdate();});
document.getElementById('layer-flatten').addEventListener('click',()=>{if(!confirm('Flatten all layers?'))return;const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;flattenTo(tmp.getContext('2d'));layers=[];layers.push(mkLayer('Background'));layers[0].ctx.drawImage(tmp,0,0);layers[0]._committed=layers[0].ctx.getImageData(0,0,CW,CH);actIdx=0;editMask=false;renderLayerPanel();composite();showToast('Flattened','ok');sendVcUpdate();});

// ─── Color Picker ───
let _cpH=210,_cpS=0.65,_cpV=0.18;
