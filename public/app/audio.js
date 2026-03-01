'use strict';
function getAC(){if(!ac)ac=new AC();if(ac.state==='suspended')ac.resume();return ac;}
function tone(f,t,d,v=.12){if(!soundEnabled)return;try{const ctx=getAC(),o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.type=t;o.frequency.value=f;g.gain.setValueAtTime(v,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+d);o.start(ctx.currentTime);o.stop(ctx.currentTime+d);}catch(e){}}
function sfxCorrect(){[523,659,784].forEach((f,i)=>setTimeout(()=>tone(f,'sine',.4),i*80));}
function sfxRoundStart(){tone(440,'triangle',.15);setTimeout(()=>tone(660,'triangle',.2),120);}
function sfxRoundEnd(){[392,349,294].forEach((f,i)=>setTimeout(()=>tone(f,'sine',.35),i*100));}
function sfxHint(){tone(880,'sine',.12);}
function sfxJoin(){tone(600,'sine',.1);}

// ─── Theme ───
let isDark=true;
function applyTheme(dark){isDark=dark;const r=document.documentElement.style;if(dark){r.setProperty('--bg','#161c1d');r.setProperty('--surface','#1e2829');r.setProperty('--surface2','#263233');r.setProperty('--surface3','#2e3c3d');r.setProperty('--border','#344748');r.setProperty('--text','#eef2f2');r.setProperty('--text2','#8aabac');r.setProperty('--text3','#4a6a6b');}else{r.setProperty('--bg','#eef2f2');r.setProperty('--surface','#ffffff');r.setProperty('--surface2','#f3f7f7');r.setProperty('--surface3','#e6eded');r.setProperty('--border','#c8d8d8');r.setProperty('--text','#1e2829');r.setProperty('--text2','#4a6a6b');r.setProperty('--text3','#8aabac');}localStorage.setItem('theme',dark?'dark':'light');}
applyTheme(localStorage.getItem('theme')!=='light');

// ─── Gallery ───
