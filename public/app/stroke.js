'use strict';
function smoothPts(pts,sm){
  if(pts.length<3||sm<.05)return null;
  const s=sm*.4,cp=[];
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
    const d1=Math.hypot(p1[0]-p0[0],p1[1]-p0[1])||1,d2=Math.hypot(p2[0]-p1[0],p2[1]-p1[1])||1,d3=Math.hypot(p3[0]-p2[0],p3[1]-p2[1])||1;
    const t1x=(p2[0]-p0[0])*s*(d2/(d1+d2)),t1y=(p2[1]-p0[1])*s*(d2/(d1+d2)),t2x=(p3[0]-p1[0])*s*(d2/(d2+d3)),t2y=(p3[1]-p1[1])*s*(d2/(d2+d3));
    cp.push([p1[0]+t1x,p1[1]+t1y,p2[0]-t2x,p2[1]-t2y]);
  }
  return cp;
}
function calcP(pts,pressures,i){
  if(pressures&&pressures[i]!=null&&pressures[i]>0)return Math.max(0.15,Math.min(1.2,pressures[i]*1.3));
  if(i===0||i>=pts.length-1)return 0.7;
  const dx=pts[i+1][0]-pts[i-1][0],dy=pts[i+1][1]-pts[i-1][1],speed=Math.sqrt(dx*dx+dy*dy);
  return Math.max(0.2,Math.min(1.0,0.35+speed*0.013));
}
function getTaper(i,total){
  if(total<4)return 1;
  const head=Math.min(6,total*0.12),tail=Math.min(10,total*0.18);let t=1.0;
  if(i<head)t=Math.min(t,Math.sin((i/head)*Math.PI*0.5));
  if(i>total-tail)t=Math.min(t,Math.sin(((total-i)/tail)*Math.PI*0.5));
  return Math.max(0.04,t);
}
function dPath(ctx,pts,sm){
  const cp=smoothPts(pts,sm);ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);
  if(!cp)for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);
  else for(let i=0;i<cp.length;i++)ctx.bezierCurveTo(cp[i][0],cp[i][1],cp[i][2],cp[i][3],pts[i+1][0],pts[i+1][1]);
}

// ─── Render Engine ───
function renderStroke(ctx,s){
  const pts=s.points||[];const bt0=s.brushType||'pen';
  if(pts.length<1)return;if(pts.length<2&&bt0!=='fill'&&bt0!=='eyedrop')return;
  const bt=s.brushType||'pen',sz=s.size||6,col=s.color||'#000',op=s.opacity??1,fl=s.flow??.8,
        sm=s.smoothing??(BD[bt]?.smoothing??.5),bd=BD[bt]||BD.pen,
        rng=makePRNG(s.seed||12345),prs=s.pressures||null,
        fd=s.fogDensity??0.4;
  ctx.save();ctx.setLineDash([]);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  if(s.isMask){ctx.globalAlpha=op;ctx.strokeStyle=col;ctx.lineWidth=sz;ctx.lineCap='round';ctx.lineJoin='round';dPath(ctx,pts,sm);ctx.stroke();ctx.restore();return;}
  if(bt==='eraser'){ctx.globalCompositeOperation='destination-out';ctx.globalAlpha=1;ctx.strokeStyle='rgba(0,0,0,1)';ctx.lineWidth=sz*(bd?.widthMult||1);ctx.lineCap='round';ctx.lineJoin='round';dPath(ctx,pts,sm);ctx.stroke();ctx.restore();return;}
  if(bt==='line'){ctx.globalAlpha=op*fl;ctx.strokeStyle=col;ctx.lineWidth=sz;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);ctx.lineTo(pts[pts.length-1][0],pts[pts.length-1][1]);ctx.stroke();ctx.restore();return;}
  if(bt==='fill'||bt==='eyedrop'){ctx.restore();return;}

  // ── Airbrush: true continuous fog — off-screen accumulate, step=rad*0.20 ────
  // Single composited drawImage prevents alpha stacking artifacts.
  // No PRNG on radius = perfectly consistent mist texture.
  // fd=0: wide, very soft mist; fd=1: narrower, denser cloud.
  if(bt==='airbrush'){
    const cr=parseInt(col.slice(1,3),16),cg=parseInt(col.slice(3,5),16),cb=parseInt(col.slice(5,7),16);
    const rad=Math.max(4,sz*(4.5-fd*2.0));
    const stepDist=Math.max(1,rad*0.15);
    // op baked into peakA — final drawImage at 1.0 prevents per-segment opacity stacking
    const peakA=op*(0.07+fd*0.20);
    const off=makeTmp();const oc=off.getContext('2d');
    oc.globalCompositeOperation='source-over';
    const _paintBlob=(bx,by)=>{
      try{
        const g=oc.createRadialGradient(bx,by,0,bx,by,rad);
        g.addColorStop(0,   `rgba(${cr},${cg},${cb},${peakA.toFixed(4)})`);
        g.addColorStop(0.5, `rgba(${cr},${cg},${cb},${(peakA*0.25).toFixed(4)})`);
        g.addColorStop(1,   `rgba(${cr},${cg},${cb},0)`);
        oc.fillStyle=g;
        oc.beginPath();oc.arc(bx,by,rad,0,Math.PI*2);oc.fill();
      }catch(e2){}
    };
    _paintBlob(pts[0][0],pts[0][1]);
    let lpx=pts[0][0],lpy=pts[0][1];
    for(let i=1;i<pts.length;i++){
      const dx=pts[i][0]-lpx,dy=pts[i][1]-lpy,d=Math.hypot(dx,dy);
      if(d<0.5)continue;
      const steps=Math.ceil(d/stepDist);
      for(let s=1;s<=steps;s++)_paintBlob(lpx+dx*(s/steps),lpy+dy*(s/steps));
      lpx=pts[i][0];lpy=pts[i][1];
    }
    // drawImage at 1.0 — opacity already in peakA, no per-segment stacking
    ctx.globalAlpha=1;
    ctx.globalCompositeOperation='source-over';
    ctx.drawImage(off,0,0);
    ctx.restore();return;
  }

  // ── Watercolor ─────────────────────────────────────────────────────────────
  if(bt==='watercolor'){
    // Pressure varies width: heavier press = wider wet pool
    const avgP=prs&&prs.length?prs.reduce((a,b)=>a+(b||0.5),0)/prs.length:0.7;
    const pMult=Math.max(0.4,Math.min(1.4,avgP));
    ctx.strokeStyle=col;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.globalCompositeOperation='source-over';
    for(let l=0;l<5;l++){ctx.globalAlpha=op*0.06*fl;ctx.strokeStyle=col;ctx.lineWidth=sz*bd.widthMult*pMult*(0.75+rng()*0.5);ctx.beginPath();ctx.moveTo(pts[0][0]+(rng()-.5)*sz*.25,pts[0][1]+(rng()-.5)*sz*.25);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0]+(rng()-.5)*sz*.3,pts[i][1]+(rng()-.5)*sz*.3);ctx.stroke();}
    const edge=makeTmp();const ec=edge.getContext('2d');ec.strokeStyle=col;ec.lineCap='round';ec.lineJoin='round';ec.lineWidth=sz*bd.widthMult*pMult+4;ec.globalAlpha=op*0.40*fl;ec.beginPath();ec.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)ec.lineTo(pts[i][0],pts[i][1]);ec.stroke();ec.globalCompositeOperation='destination-out';ec.lineWidth=sz*bd.widthMult*pMult-1;ec.globalAlpha=1;ec.beginPath();ec.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)ec.lineTo(pts[i][0],pts[i][1]);ec.stroke();ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.drawImage(edge,0,0);ctx.restore();return;
  }

  // ── Bristle ────────────────────────────────────────────────────────────────
  if(bt==='bristle'){
    const fiberCount=Math.max(6,Math.floor(sz*0.7)),spread=sz*0.65;
    const fibers=Array.from({length:fiberCount},()=>({
      ox:(rng()-.5)*spread*2,oy:(rng()-.5)*spread*2,
      stiffness:0.4+rng()*0.6,thick:0.6+rng()*0.8
    }));
    ctx.lineCap='round';ctx.lineJoin='round';
    ctx.globalCompositeOperation='source-over';
    for(let b=0;b<fiberCount;b++){
      const f=fibers[b];
      for(let i=1;i<pts.length;i++){
        const p=calcP(pts,prs,i); // pressure varies fiber width
        const lw=Math.max(0.4,f.thick*sz/fiberCount*1.6*p);
        const nx=pts[Math.min(i+1,pts.length-1)][0],ny=pts[Math.min(i+1,pts.length-1)][1];
        const px2=pts[Math.max(i-1,0)][0],py2=pts[Math.max(i-1,0)][1];
        const vx=(nx-px2)*0.15*(1-f.stiffness),vy=(ny-py2)*0.15*(1-f.stiffness);
        const taper=getTaper(i,pts.length);
        const fx0=pts[i-1][0]+(f.ox+vx)*taper,fy0=pts[i-1][1]+(f.oy+vy)*taper;
        const fx1=pts[i][0]+(f.ox+vx)*taper,fy1=pts[i][1]+(f.oy+vy)*taper;
        const a=Math.min(0.95,op*bd.alpha*fl*f.stiffness*taper*1.4);
        ctx.globalAlpha=Math.min(0.95,op*bd.alpha*fl*f.stiffness*taper*1.4);ctx.strokeStyle=col;ctx.lineWidth=lw;
        ctx.beginPath();ctx.moveTo(fx0,fy0);ctx.lineTo(fx1,fy1);ctx.stroke();
      }
    }
    ctx.restore();return;
  }

  // ── Ink ────────────────────────────────────────────────────────────────────
  if(bt==='ink'){
    ctx.lineCap='round';ctx.lineJoin='round';
    for(let i=1;i<pts.length;i++){const p=calcP(pts,prs,i),taper=getTaper(i,pts.length);ctx.globalAlpha=op*fl*Math.min(1,p*.85+.15)*taper;ctx.strokeStyle=col;ctx.lineWidth=sz*p*bd.widthMult*taper;ctx.beginPath();ctx.moveTo(pts[i-1][0],pts[i-1][1]);ctx.lineTo(pts[i][0],pts[i][1]);ctx.stroke();}
    ctx.restore();return;
  }

  // ── Pencil: graphite grain texture ────────────────────────────────────────
  if(bt==='pencil'){
    ctx.fillStyle=col;const grainSz=Math.max(0.8,sz*0.13),coverage=0.6*fl;
    for(let i=1;i<pts.length;i++){
      const taper=getTaper(i,pts.length),p=calcP(pts,prs,i),hw=sz*0.5*bd.widthMult*taper*p;
      const dist=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]),steps=Math.max(1,Math.ceil(dist/(grainSz*1.2)));
      for(let st=0;st<steps;st++){const t=st/steps,sx=pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t,sy=pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t,particleN=Math.floor(hw*2*coverage);
        for(let g=0;g<particleN;g++){const ox=(rng()-.5)*hw*2,oy=(rng()-.5)*hw*2;if((ox*ox)/(hw*hw)+(oy*oy)/(hw*0.45*hw*0.45)>1)continue;const edgeDist=Math.sqrt((ox*ox)/(hw*hw)+(oy*oy)/(hw*hw));ctx.globalAlpha=op*(0.25+rng()*0.55)*(1-edgeDist*0.4)*taper;ctx.fillRect(sx+ox,sy+oy,grainSz,grainSz);}}
    }
    ctx.restore();return;
  }

  // ── Pastel: chalk texture with soft grain and natural blending ───────────
  if(bt==='pastel'){
    const grainSz=Math.max(1.2,sz*0.18);
    const coverage=0.55*fl;
    const [cr,cg,cb]=[parseInt(col.slice(1,3),16),parseInt(col.slice(3,5),16),parseInt(col.slice(5,7),16)];
    for(let i=1;i<pts.length;i++){
      const taper=getTaper(i,pts.length),p=calcP(pts,prs,i),hw=sz*0.5*bd.widthMult*taper*p*1.2;
      const dist=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);
      const steps=Math.max(1,Math.ceil(dist/(grainSz*1.5)));
      for(let st=0;st<steps;st++){
        const t=st/steps;
        const sx=pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t;
        const sy=pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t;
        const pN=Math.floor(hw*2.2*coverage);
        for(let g=0;g<pN;g++){
          // Oval distribution (chalk pressed sideways)
          const ang=rng()*Math.PI*2;
          const rx=hw*(0.9+rng()*0.4),ry=hw*(0.4+rng()*0.3);
          const ox=Math.cos(ang)*rx,oy=Math.sin(ang)*ry;
          if((ox*ox)/(hw*hw)+(oy*oy)/(hw*hw)>1.2)continue;
          const edgeDist=Math.min(1,Math.sqrt((ox*ox+oy*oy)/(hw*hw)));
          // Chalk grain: soft pastel opacity with edge softness
          const grain=0.15+rng()*0.45;
          const alphaBase=op*grain*(1-edgeDist*0.5)*taper;
          // Slight color variation for chalk naturalness
          const varR=cr+(rng()-.5)*18,varG=cg+(rng()-.5)*18,varB=cb+(rng()-.5)*18;
          ctx.fillStyle=`rgba(${~~Math.max(0,Math.min(255,varR))},${~~Math.max(0,Math.min(255,varG))},${~~Math.max(0,Math.min(255,varB))},1)`;
          ctx.globalAlpha=alphaBase;
          // Chalky strokes: small elongated marks
          const gW=grainSz*(0.6+rng()*1.4),gH=grainSz*(0.3+rng()*0.6);
          ctx.fillRect(sx+ox-gW/2,sy+oy-gH/2,gW,gH);
        }
      }
    }
    ctx.restore();return;
  }

  // ── Pen/Marker: smooth path, per-segment pressure for pen ───────────────
  ctx.strokeStyle=col;ctx.lineCap=bd.cap||'round';ctx.lineJoin='round';
  if(bd.pressure&&bt!=='marker'&&prs&&prs.length>1){
    // Per-segment: pressure varies width, taper fades ends naturally
    const cp=smoothPts(pts,sm);
    for(let i=1;i<pts.length;i++){
      const p=calcP(pts,prs,i),taper=getTaper(i,pts.length);
      ctx.globalAlpha=op*bd.alpha*fl;
      ctx.lineWidth=Math.max(0.5,sz*bd.widthMult*p*taper);
      ctx.beginPath();
      if(cp&&cp[i-1]){
        ctx.moveTo(pts[i-1][0],pts[i-1][1]);
        ctx.bezierCurveTo(cp[i-1][0],cp[i-1][1],cp[i-1][2],cp[i-1][3],pts[i][0],pts[i][1]);
      }else{
        ctx.moveTo(pts[i-1][0],pts[i-1][1]);ctx.lineTo(pts[i][0],pts[i][1]);
      }
      ctx.stroke();
    }
  }else{
    ctx.globalAlpha=op*bd.alpha*fl;
    ctx.lineWidth=sz*bd.widthMult;
    dPath(ctx,pts,sm);ctx.stroke();
  }
  ctx.restore();
}

// ─── Flood Fill ───
function floodFill(ctx,sx,sy,hex,tol){
  sx=Math.round(sx);sy=Math.round(sy);const w=ctx.canvas.width,h=ctx.canvas.height;
  if(sx<0||sx>=w||sy<0||sy>=h)return;
  const id=ctx.getImageData(0,0,w,h),d=id.data,ix=(sy*w+sx)*4;
  const sr=d[ix],sg=d[ix+1],sb=d[ix+2],sa=d[ix+3];
  const fr=parseInt(hex.slice(1,3),16),fg=parseInt(hex.slice(3,5),16),fb=parseInt(hex.slice(5,7),16);
  if(sr===fr&&sg===fg&&sb===fb&&sa===255)return;
  const t=(tol||30)*(tol||30);
  const match=i=>{const dr=d[i]-sr,dg=d[i+1]-sg,db=d[i+2]-sb,da=d[i+3]-sa;return dr*dr+dg*dg+db*db+da*da<=t;};
  const stack=[sx+sy*w],vis=new Uint8Array(w*h);vis[sx+sy*w]=1;
  while(stack.length){const pos=stack.pop(),x=pos%w,y=(pos/w)|0,i=pos*4;d[i]=fr;d[i+1]=fg;d[i+2]=fb;d[i+3]=255;[[x-1,y],[x+1,y],[x,y-1],[x,y+1]].forEach(([nx,ny])=>{if(nx>=0&&nx<w&&ny>=0&&ny<h&&!vis[nx+ny*w]&&match((nx+ny*w)*4)){vis[nx+ny*w]=1;stack.push(nx+ny*w);}});}
  ctx.putImageData(id,0,0);
}

function pickColor(x,y){
  x=Math.round(x);y=Math.round(y);
  const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;const tc=tmp.getContext('2d');
  tc.drawImage(bgCv,0,0);layers.forEach(l=>{if(l.visible)tc.drawImage(l.canvas,0,0);});
  const d=tc.getImageData(x,y,1,1).data;
  return'#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
}

// ─── Pointer Input ───
function onDown(e){
  if(!isDrawer)return;
  if(_txActive)return;  // block drawing while transform mode is active
  if(_twoFinger)return;
  if(_spaceDown||_altDown){
    // Space/Alt drag to pan
    _panDragging=true;_panSX=e.clientX;_panSY=e.clientY;_panPX=panX;_panPY=panY;
    body.classList.add('dragging');
    return;
  }
  if(e.pointerType==='touch'&&e.touches?.length>1)return;
  e.preventDefault();
  const[x,y]=c2cv(e.clientX,e.clientY);
  if(brushType==='eyedrop'){const h=pickColor(x,y);if(h){setColor(h);syncPickerFromColor(h);showToast('Color picked 💉','ok');}return;}
  if(brushType==='fill'){
    saveUndo();const ctx=actCtx();floodFill(ctx,x,y,currentColor,30);
    if(actLayer())actLayer()._committed=ctx.getImageData(0,0,CW,CH);composite();
    wsSend({type:'draw',stroke:{color:currentColor,size:brushSize,opacity:brushOpacity,flow:brushFlow,brushType:'fill',smoothing:0,points:[[x,y]],seed:0,isMask:editMask,fogDensity}});
    // Send flattened canvas to server so virtual canvas matches (fill is layer-dependent)
    sendVcUpdate();
    showSyncSpin();addLog(`Fill (${~~x},${~~y})=${currentColor}`,'draw');return;
  }
  ptrId=e.pointerId;area.setPointerCapture?.(ptrId);saveUndo();isDrawing=true;
  lastX=x;lastY=y;lsx=x;lsy=y;lazyX=x;lazyY=y;
  const sm=bSettings[brushType]?.smoothing??BD[brushType]?.smoothing??.5;
  const seed=Math.floor(Math.random()*0xFFFFFF);
  const initP=e.pressure||0;
  const strokeId=Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  curStroke={color:currentColor,size:brushSize,opacity:brushOpacity,flow:brushFlow,
    brushType,smoothing:sm,seed,isMask:editMask,strokeId,fogDensity,points:[[x,y]],pressures:[initP]};
  renderStroke(actCtx(),{...curStroke,points:[[x,y],[x+.01,y+.01]]});scheduleComposite();
}
function onMove(e){
  // Pan mode (space/alt drag)
  if(_panDragging){
    const dx=e.clientX-_panSX,dy=e.clientY-_panSY;
    panX=_panPX+dx;panY=_panPY+dy;_tz=zoom;_tx=panX;_ty=panY;
    applyT();return;
  }
  if(!isDrawing||!isDrawer||e.pointerId!==ptrId)return;e.preventDefault();
  const[rawX,rawY]=c2cv(e.clientX,e.clientY);
  const ldx=rawX-lazyX,ldy=rawY-lazyY,ldist=Math.sqrt(ldx*ldx+ldy*ldy);
  const noLazy=(brushType==='eraser'||brushType==='airbrush'||LAZY_RADIUS<1);
  let x,y;
  if(noLazy||ldist<=LAZY_RADIUS){x=rawX;y=rawY;}
  else{lazyX+=ldx/ldist*(ldist-LAZY_RADIUS);lazyY+=ldy/ldist*(ldist-LAZY_RADIUS);x=lazyX;y=lazyY;}
  const dx=x-lastX,dy=y-lastY;if(dx*dx+dy*dy<.3)return;
  if(brushType==='line'){
    actCtx().clearRect(0,0,CW,CH);if(actLayer()?._committed)actCtx().putImageData(actLayer()._committed,0,0);
    renderStroke(actCtx(),{...curStroke,points:[[lsx,lsy],[x,y]]});curStroke.points=[[lsx,lsy],[x,y]];lastX=x;lastY=y;scheduleComposite();return;
  }
  const prev=curStroke.points[curStroke.points.length-1];
  curStroke.points.push([x,y]);curStroke.pressures.push(e.pressure||0);lastX=x;lastY=y;
  const needsFullRedraw=(brushType==='pen'||brushType==='marker'||brushType==='ink'||brushType==='pencil'||brushType==='pastel'||brushType==='watercolor');
  if(needsFullRedraw){actCtx().clearRect(0,0,CW,CH);if(actLayer()?._committed)actCtx().putImageData(actLayer()._committed,0,0);renderStroke(actCtx(),curStroke);}
  else{renderStroke(actCtx(),{...curStroke,points:[prev,[x,y]],pressures:curStroke.pressures.slice(-2)});}
  scheduleComposite();
  if(curStroke.points.length%8===0){wsSend({type:'draw',stroke:{...curStroke}});showSyncSpin();}
}
function sendVcUpdate(){
  // Send flattened canvas to server so virtual canvas matches client exactly.
  // Used after fill, layer merge/delete — layer-dependent operations.
  if(!isDrawer)return;
  try{
    const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;
    flattenTo(tmp.getContext('2d'));
    wsSend({type:'vc_update',data:tmp.toDataURL('image/jpeg',0.82)});
  }catch(e){console.error('[vc_update]',e);}
}
function sendFinalImage(cb){
  if(!isDrawer){if(cb)cb();return;}
  try{
    // Capture exactly what the drawer sees: bgCv (white) + layersCv (composited layers)
    // This is pixel-identical to the screen — no flattenTo approximation needed
    const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;
    const tc=tmp.getContext('2d');
    tc.drawImage(bgCv,0,0);       // white background
    tc.drawImage(layersCv,0,0);   // all layers composited exactly as shown
    wsSend({type:'final_image',data:tmp.toDataURL('image/jpeg',0.92)});
    addLog('Final image sent to server','system');
  }catch(e){console.error('[final_image]',e);}
  if(cb)setTimeout(cb,100);
}
function sendVcUpdate(){
// Send flattened canvas to server so virtual canvas matches client exactly.
  // Used after operations that are layer-dependent: fill, eraser, layer merge/delete.
  if(!isDrawer)return;
  try{
    const tmp=document.createElement('canvas');tmp.width=CW;tmp.height=CH;
    flattenTo(tmp.getContext('2d'));
    wsSend({type:'vc_update',data:tmp.toDataURL('image/jpeg',0.82)});
  }catch(e){console.error('[vc_update]',e);}
}
function onUp(){
  if(_panDragging){_panDragging=false;body.classList.remove('dragging');return;}
  if(!isDrawing||!isDrawer)return;isDrawing=false;ptrId=null;
  if(curStroke?.points.length>0){
    if(brushType!=='bristle'&&brushType!=='airbrush'){
      actCtx().clearRect(0,0,CW,CH);if(actLayer()?._committed)actCtx().putImageData(actLayer()._committed,0,0);
      renderStroke(actCtx(),curStroke);
    }
    if(actLayer())actLayer()._committed=actCtx().getImageData(0,0,CW,CH);
    composite();wsSend({type:'draw',stroke:{...curStroke}});showSyncSpin();
    addLog(`Stroke: ${curStroke.brushType} pts=${curStroke.points.length}`,'draw');
  }
  curStroke=null;
}

const body=document.body;
area.addEventListener('pointerdown',onDown,{passive:false});
area.addEventListener('pointermove',onMove,{passive:false});
area.addEventListener('pointerup',onUp,{passive:true});
area.addEventListener('pointercancel',onUp,{passive:true});

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown',e=>{
  const tag=e.target.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA')return;
  if(e.key===' '){e.preventDefault();_spaceDown=true;body.classList.add('panning');}
  if(e.altKey&&!e.ctrlKey&&!e.metaKey){_altDown=true;body.classList.add('panning');}
  if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();doUndo();}
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z'))){e.preventDefault();doRedo();}
  if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveDrawingFile();}
  if((e.ctrlKey||e.metaKey)&&e.key==='+'){e.preventDefault();const r=area.getBoundingClientRect();zoomTo(_tz*1.15,r.width/2,r.height/2);}
  if((e.ctrlKey||e.metaKey)&&e.key==='-'){e.preventDefault();const r=area.getBoundingClientRect();zoomTo(_tz*0.87,r.width/2,r.height/2);}
  if(e.key==='b'&&!e.ctrlKey&&!e.metaKey){setBrush('pen');showToast('Pen B');}
  if(e.key==='e'&&!e.ctrlKey&&!e.metaKey){setBrush('eraser');showToast('Eraser E');}
  // [ = smaller brush, ] = bigger brush
  if(e.key==='['&&!e.ctrlKey&&!e.metaKey){e.preventDefault();brushSize=Math.max(1,brushSize-2);document.getElementById('sz-range').value=brushSize;updateSzLbl();showToast(brushSize+'px');}
  if(e.key===']'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();brushSize=Math.min(120,brushSize+2);document.getElementById('sz-range').value=brushSize;updateSzLbl();showToast(brushSize+'px');}
  if(e.key==='Delete'||e.key==='Backspace'){if(e.ctrlKey||e.metaKey){deleteCurrentLayer();}}
  // Transform mode: ESC cancels, Enter applies
  if(e.key==='Escape'){if(_txActive){e.preventDefault();cancelTransform();return;}closeAllPanels();}
  if(e.key==='Enter'){if(_txActive){e.preventDefault();endTransform();return;}}
});
document.addEventListener('keyup',e=>{
  if(e.key===' '){_spaceDown=false;if(!_altDown)body.classList.remove('panning');if(!_panDragging){}else{_panDragging=false;body.classList.remove('dragging');}}
  if(e.key==='Alt'){_altDown=false;if(!_spaceDown)body.classList.remove('panning');if(_panDragging){_panDragging=false;body.classList.remove('dragging');}}
});

