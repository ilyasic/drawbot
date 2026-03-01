'use strict';
function connect(){
  if(!myName||!myRoom)return;
  addLog(`Connecting… room=${myRoom} name=${myName}`,'system');
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(myRoom)}&name=${encodeURIComponent(myName)}&userId=${encodeURIComponent(myTgId)}`);
  ws.onopen=()=>{document.getElementById('conn-dot').style.background='var(--green)';addLog(`WebSocket connected`,'connect');wsSend({type:'canvas_size',w:CW,h:CH});};
  ws.onmessage=({data})=>{
    let m;try{m=JSON.parse(data);}catch{return;}
    switch(m.type){
      case'init':
        // Always reset to 1 layer for init — drawer will add their own layers,
        // guessers only ever need 1 layer for the composited view
        layers=[mkLayer('Background')];actIdx=0;editMask=false;
        bgCtx.fillStyle='#fff';bgCtx.fillRect(0,0,CW,CH);
        renderLayerPanel();
        if(m.strokes?.length){
          const first=m.strokes[0];
          if(first?.brushType==='_snapshot'&&first.pngB64){
            const img=new Image();
            img.onload=()=>{
              layers[0].ctx.clearRect(0,0,CW,CH);
              layers[0].ctx.drawImage(img,0,0,CW,CH);
              layers[0]._committed=layers[0].ctx.getImageData(0,0,CW,CH);
              m.strokes.slice(1).forEach(s=>renderStroke(layers[0].ctx,s));
              if(m.strokes.length>1)layers[0]._committed=layers[0].ctx.getImageData(0,0,CW,CH);
              composite();
            };
            img.src='data:image/png;base64,'+first.pngB64;
          }else{
            m.strokes.forEach(s=>renderStroke(layers[0].ctx,s));
            layers[0]._committed=layers[0].ctx.getImageData(0,0,CW,CH);
            composite();
          }
        }
        document.getElementById('word-display').textContent=`${m.players} player${m.players!==1?'s':''}`;
        if(m.board){updatePlayers(m.board);updateLb(m.board);}
        addLog(`Init: ${m.players} players, ${(m.strokes||[]).length} strokes restored`,'system');
        break;
      case'draw':
        if(isDrawer){showSyncDone();}
        else{
          // Guessers always draw to layer 0 — they have no multi-layer state
          renderStroke(layers[0].ctx,m.stroke);
          layers[0]._committed=layers[0].ctx.getImageData(0,0,CW,CH);
          composite();
        }
        break;
      case'clear':
        // Drawer: their own layers are source of truth — only clear on explicit action
        if(isDrawer){showSyncDone();}else{clearAll();}
        addLog('Canvas cleared by server','draw');break;
      case'snapshot':{
        // Drawer: ignore server snapshots (their multi-layer canvas is authoritative)
        if(isDrawer){showSyncDone();break;}
        // Guesser: collapse to single layer then draw snapshot onto it
        const img=new Image();
        img.onload=()=>{
          // Collapse to 1 layer so snapshot doesn't conflict with stale layer data
          if(layers.length>1){
            layers=[mkLayer('Background')];actIdx=0;editMask=false;renderLayerPanel();
          }
          layers[0].ctx.clearRect(0,0,CW,CH);
          layers[0].ctx.drawImage(img,0,0,CW,CH);
          layers[0]._committed=layers[0].ctx.getImageData(0,0,CW,CH);
          composite();
        };
        img.src=m.data;addLog('Snapshot received','system');break;
      }
      case'role':
        if(m.role==='drawer'&&!m.reconnect)clearAll();
        // drawer_free: never clear — drawer keeps their canvas to continue drawing
        setRole(m.role,m.role==='drawer'?m.word:(m.role==='drawer_free'?null:m.hint),m.round);
        break;
      case'first_stroke':
        // Drawer started — hint button now active in Telegram chat caption
        if(!isDrawer){
          const wd=document.getElementById('word-display');
          const lc=(wd.textContent.match(/\d+/)||['?'])[0];
          wd.textContent=`${lc} letters — hint in 30s`;
        }
        break;
      case'hint':
        updateHintDisplay(m.hint);
        {const lc=m.hint.replace(/ /g,'').length;
        const nextSec=m.nextCooldownMs?Math.round(m.nextCooldownMs/1000):15;
        document.getElementById('word-display').textContent=`${lc} letters — next hint in ${nextSec}s`;}
        addChat('sys','💡 Hint revealed');
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('warning');
        sfxHint();break;
      case'word_skipped':
        updateHintDisplay(m.hint);
        document.getElementById('word-display').textContent='word skipped';
        addChat('sys','Word skipped');clearAll();break;
      case'guess':
        addChat(m.correct?'ok':'',`<span class="cn">${m.name}:</span> ${m.text}${m.correct?' ✅':''}`);
        if(m.correct){showToast(`🎉 ${m.name} got it!`,'ok');sfxCorrect();}break;
      case'score_update':
        addChat('ok',`🏆 ${m.name} +${m.pts}pts${m.timeBonus?' ⚡+'+m.timeBonus:''}`);
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
        // Drawer sends final image now — arrives before server calls postResult
        if(isDrawer)sendFinalImage(null);
        if(m.board){updatePlayers(m.board);updateLb(m.board);}break;
      case'round_end':
        if(_txActive)cancelTransform();
        sfxRoundEnd();
        // Send final image for timeout/done cases (guess case handled by score_update)
        if(isDrawer&&!m.keepDrawing&&!m.guesser)sendFinalImage(null);
        if(m.keepDrawing&&isDrawer){
          // Someone guessed — drawer keeps canvas active, show persistent overlay
          // Remove any existing continue overlay
          document.getElementById('continue-overlay')?.remove();
          const b=document.createElement('div');
          b.id='continue-overlay';
          b.style.cssText='position:fixed;top:54px;left:0;right:0;background:rgba(0,150,60,.95);color:#fff;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;z-index:900;font-size:.85rem;font-weight:700;';
          b.innerHTML=`<span>🎉 ${m.guesser||'Someone'} guessed it!</span><button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,.25);border:none;color:#fff;padding:4px 10px;border-radius:12px;font-size:.78rem;cursor:pointer;font-weight:700">✕ dismiss</button>`;
          document.body.appendChild(b);
          // Toolbar stays fully visible — drawer can keep drawing freely
          // waiting-overlay stays hidden
        }else{
          // Normal round end — show native popup
          const tg=window.Telegram?.WebApp;
          const emoji=m.guesser?'🎉':(m.reason==='all_hints'?'🔤':'😮');
          const title=m.guesser?`${m.guesser} guessed it!`:(m.reason==='all_hints'?'All hints shown!':'Round over');
          const board=window._lastBoard||[];
          const m2=['🥇','🥈','🥉'];
          const lbText=board.length?'\n\n📊 '+board.slice(0,5).map(({rank,name,score})=>`${m2[rank-1]||rank+'.'} ${name} ${score}pts`).join('  |  '):'';
          const msg=`${emoji} ${title}\n🎯 Word: ${m.word}${lbText}`;
          if(tg){tg.HapticFeedback?.notificationOccurred(m.guesser?'success':'error');tg.showPopup({title:'Round Over',message:msg,buttons:[{type:'close'}]});}
        }
        if(m.board){updatePlayers(m.board);updateLb(m.board);window._lastBoard=m.board;}
        if(m.word&&m.drawerName)saveToGallery(m.word,m.drawerName);
        if(!m.keepDrawing){
          updateHintDisplay('');
          document.getElementById('word-display').textContent='waiting…';
          document.getElementById('role-pill').className='role-pill';document.getElementById('role-pill').textContent='—';
          if(!m.drawerFinish||!isDrawer){document.getElementById('toolbar').classList.remove('visible');isDrawer=false;}
          document.getElementById('start-btn').style.display='block';document.getElementById('lb-btn').style.display='inline-block';
          document.getElementById('waiting-overlay').classList.remove('hidden');
        }
        addLog(`Round end: word=${m.word} guesser=${m.guesser||'none'} reason=${m.reason}`,'round');break;
      case'new_canvas':
        myCanvasId=m.canvasId||myCanvasId;
        isDrawing=false;curStroke=null;
        clearAll();
        if(isDrawer){
          currentWord=m.word||'';
          document.getElementById('word-display').textContent=(m.word||'').toUpperCase();
          document.getElementById('s-current-word').textContent=(m.word||'').toUpperCase();
          // Keep toolbar visible — drawer is still active on new canvas
          document.getElementById('toolbar').classList.add('visible');
          showToast('New canvas! Draw: '+m.word,'ok');
        }
        document.getElementById('waiting-overlay').classList.add('hidden');
        document.getElementById('role-pill').className='role-pill drawer';
        document.getElementById('role-pill').textContent='DRAW';
        addLog(`New canvas: ${m.canvasId}`,'round');
        break;
      case'locked':{
        // No active game — show lock screen and close
        const lock=document.createElement('div');
        lock.style.cssText='position:fixed;inset:0;background:var(--bg,#1a1a2e);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:9999;';
        lock.innerHTML=`<div style="font-size:3rem">🔒</div><div style="color:var(--text1,#fff);font-size:1.1rem;font-weight:700;text-align:center;padding:0 24px">${m.message||'No active game'}</div><div style="color:var(--text3,#888);font-size:.85rem;text-align:center;padding:0 32px">Ask the group admin to start a game with /startgame</div>`;
        document.body.appendChild(lock);
        // Close WebApp after 2.5s
        setTimeout(()=>window.Telegram?.WebApp?.close(),2500);
        break;
      }
      case'status':document.getElementById('word-display').textContent=m.message;addChat('sys',m.message);break;
      case'player_joined':
        addChat('sys',`${m.name} joined (${m.count})`);
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
        sfxJoin();break;
      case'player_left':addChat('sys',`${m.name} left (${m.count})`);break;
      case'toast':showToast(m.message||m.text,'ok');break;
      case'word_set':
        // Drawer set a custom word — update display
        if(isDrawer){currentWord=m.word;document.getElementById('word-display').textContent=m.word.toUpperCase();document.getElementById('s-current-word').textContent=m.word.toUpperCase();}
        break;
      case'toast':
        // Server ack/fail for send_to_chat and other async ops
        showToast(m.message,m.message.includes('✅')?'ok':'warn');
        break;
    }
  };
  ws.onclose=()=>{document.getElementById('conn-dot').style.background='var(--red)';addLog('WebSocket disconnected — reconnecting…','disconnect');scheduleReconnect();};
  ws.onerror=e=>{addLog(`WebSocket error: ${e.message||'unknown'}`,'error');ws.close();};
}
let _rcT=null;
function scheduleReconnect(){clearTimeout(_rcT);_rcT=setTimeout(()=>{if(myName&&myRoom&&(!ws||ws.readyState===WebSocket.CLOSED))connect();},1500);}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&myRoom&&(!ws||ws.readyState===WebSocket.CLOSED))connect();});

function getTgName(){if(!tg)return null;const u=tg.initDataUnsafe?.user;if(!u)return null;return`${u.first_name||''} ${u.last_name||''}`.trim()||u.username||null;}
