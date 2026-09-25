/* Getting about the panel: the two drawers, paging, and the radio
   picker that hangs off the control panel. */
import {open, tally, fling, state} from './helpers.mjs';
const t=tally();
const NETS=[
  {ssid:'Confluence',   secure:true, saved:true,  active:true,  signal:99},
  {ssid:'Marina Guest', secure:true, saved:false, active:false, signal:64},
  {ssid:'Steve iPhone', secure:true, saved:true,  active:false, signal:81}];
const {b,p,posts}=await open(t,{demo:true,
  /* A boat with everything wired, which is also the panel that does not
     fit the glass - see the scrolling checks at the foot of this file. */
  status:{wifi:{available:true, devices:[{dev:'wlan0',up:true,ap:true,ssid:'Confluence'}]},
          bt:{available:true,powered:true}, power:{available:true},
          buzzer:{available:true, mode:'audio',
                  device:'plughw:CARD=Headphones,DEV=0', pinned:false,
                  outs:[{dev:'plughw:CARD=Headphones,DEV=0',name:'3.5 MM JACK'},
                        {dev:'pulse',name:'PIPEWIRE / PULSE'}]}},
  reply:{'/wifi/list':{ok:true, up:true, ap:true, nets:NETS}}});

t.head('the drawers');
let s=await state(p);
t.ok(!s.panel&&!s.dock&&s.page===1, 'the dial, with nothing over it', JSON.stringify(s));
await fling(p,1,0,-260);
t.ok((await state(p)).dock, 'one finger UP pulls the app dock off the bottom');
await fling(p,1,0,240);
t.ok((await state(p)).dock, 'a DOWN flick out on the dial leaves it - not its glass');
await fling(p,1,0,240,480,980);
t.ok(!(await state(p)).dock, 'one on the dock itself sends it back');
await fling(p,1,0,260);
t.ok((await state(p)).panel, 'one finger DOWN pulls the control panel off the top');
await fling(p,1,0,-260);
t.ok(!(await state(p)).panel, 'and UP puts it away');

t.head('paging wants three fingers');
await fling(p,1,-260,0);
t.ok((await state(p)).page===1, 'one finger sideways does not page');
await fling(p,3,-260,0);
t.ok((await state(p)).page===2, 'three reach the music page');
await fling(p,3,260,0);
t.ok((await state(p)).page===1, 'and come back');
await fling(p,3,260,0);
t.ok((await state(p)).page===1, 'stopping there rather than wrapping');

t.head('the radios');
await fling(p,1,0,260);
const tiles=await p.$$eval('#conn-sec .cbtn', n=>n.map(e=>e.dataset.k));
t.ok(tiles.includes('wifi')&&tiles.includes('bt')&&tiles.includes('power'),
     "the helper's three tiles", JSON.stringify(tiles));
await p.click('#conn-sec .cbtn[data-k="wifi"]'); await p.waitForTimeout(1000);
t.ok((await state(p)).sheet, 'the wifi tile opens the picker');
const rows=await p.$$eval('.ns-row .ns-name', n=>n.map(e=>e.textContent));
t.ok(rows.join()==='Confluence,Marina Guest,Steve iPhone', 'all three', JSON.stringify(rows));
const subs=await p.$$eval('.ns-row .ns-sub', n=>n.map(e=>e.textContent));
t.ok(/^HOTSPOT/.test(subs[0]), 'the running hotspot says so', subs[0]);
t.ok(subs[1]==='SECURED · 64%', 'an unsaved secured one', subs[1]);
t.ok(subs[2]==='SAVED · SECURED · 81%', 'a saved one', subs[2]);
const forgets=await p.$$eval('.ns-row [data-forget]',
  n=>n.map(e=>e.closest('.ns-row').querySelector('.ns-name').textContent));
t.ok(forgets.join()==='Steve iPhone',
     'a forget only on what it remembers, never on the hotspot it is running',
     JSON.stringify(forgets));

t.head('joining takes two taps');
posts.length=0;
await p.click('.ns-row[data-i="2"]'); await p.waitForTimeout(250);
t.ok(/TAP AGAIN/.test(await p.textContent('#ns-msg')),
     'the first warns this drops the hotspot', await p.textContent('#ns-msg'));
t.ok(!posts.length, 'and asks the helper nothing', JSON.stringify(posts));
await p.click('.ns-row[data-i="2"]'); await p.waitForTimeout(900);
const join=posts.find(x=>x.path==='/wifi/connect');
t.ok(join&&join.body.ssid==='Steve iPhone', 'the second joins it', JSON.stringify(posts));
t.ok(!(await p.$eval('#ns-pw-view', e=>e.style.display!=='none')),
     'a saved profile carries its own key, so no keyboard');

t.head('an unsaved one wants the keyboard');
await p.click('.ns-row[data-i="1"]'); await p.waitForTimeout(250);
await p.click('.ns-row[data-i="1"]'); await p.waitForTimeout(500);
t.ok(await p.$eval('#ns-pw-view', e=>e.style.display!=='none'), 'it is up');
t.ok((await p.textContent('#pw-for')).includes('Marina Guest'), 'and says which network');
posts.length=0;
await p.click('.kk[data-a="go"]'); await p.waitForTimeout(400);
t.ok(/8/.test(await p.textContent('#pw-msg')),
     'an empty key is refused here, not at the Pi', await p.textContent('#pw-msg'));
t.ok(!posts.length, 'so the helper is never asked', JSON.stringify(posts));
await p.click('.kk[data-a="sym"]'); await p.waitForTimeout(250);
t.ok((await p.$$eval('.kk[data-c]', n=>n.map(e=>e.dataset.c))).includes('@'),
     'the symbol layer has symbols on it');
await p.click('#pw-cancel'); await p.waitForTimeout(400);
t.ok(!(await p.$eval('#ns-pw-view', e=>e.style.display!=='none')), 'cancel puts it away');

t.head('and out again');
await p.click('#ns-done'); await p.waitForTimeout(500);
s=await state(p);
t.ok(!s.sheet && s.panel, 'DONE closes the picker, not the panel', JSON.stringify(s));
await fling(p,1,0,-260);
t.ok(!(await state(p)).panel, 'and the dial is back');

t.head('the sounder says where it comes out, and can be pointed elsewhere');
/* aplay only addresses ALSA, so a Bluetooth speaker is reached through
   whatever sits in front of it - which is why this is a list and not a
   jack-or-nothing.
   Painted and read in ONE turn: the /status poll owns this row and
   repaints it from the stub a few times a second, so anything set by
   hand and asked about later is a race with it. */
await p.evaluate(()=>openPanel()); await p.waitForTimeout(400);
const who=st=>p.evaluate(st=>{ paintSounder(st);
  return {txt:$('snd-who').textContent, pick:$('snd-who').classList.contains('pick'),
          off:$('snd-who').disabled}; }, st);
const OUT2=[{dev:'plughw:CARD=Headphones,DEV=0',name:'3.5 MM JACK'},
            {dev:'pulse',name:'PIPEWIRE / PULSE'}];
let W=await who({available:true, mode:'audio', pinned:false, outs:OUT2,
                 device:'plughw:CARD=Headphones,DEV=0'});
t.ok(/3\.5 MM JACK/.test(W.txt), 'it says where in words, not in an ALSA name', W.txt);
t.ok(/TAP/.test(W.txt) && W.pick, 'and offers the others', W.txt);
posts.length=0;
await p.evaluate(()=>$('snd-who').click()); await p.waitForTimeout(700);
t.ok(posts.some(o=>o.path==='/buzz/out' && o.body.dev==='pulse'),
     'a tap asks netd for the next one',
     JSON.stringify(posts.filter(o=>o.path==='/buzz/out').map(o=>o.body)));

t.head('and offers nothing when there is nothing to offer');
W=await who({available:true, mode:'audio', device:'pulse', pinned:true, outs:OUT2});
t.ok(/PINNED/.test(W.txt) && W.off,
     'a HELM_AUDIO_DEV in the environment is shown and not tappable', W.txt);
W=await who({available:true, mode:'audio', pinned:false,
             device:'plughw:CARD=Headphones,DEV=0', outs:[OUT2[0]]});
t.ok(!/TAP/.test(W.txt) && W.off, 'and one output is not a choice', W.txt);
W=await who({available:true, mode:'gpio', gpio:17});
t.ok(W.txt==='GPIO 17' && W.off, 'a wire on a pin has no output to pick', W.txt);

t.head('the panel fits the glass');
/* It stopped fitting once it was a single 600 px column of sections -
   600 px wide on a circle of radius 540 is only lit between y=91 and
   y=989, and the sheet had passed 1140. Two cards across is the fix;
   the scrolling below is what catches it if it ever grows again. */
await p.evaluate(()=>openPanel()); await p.waitForTimeout(700);
const sh=()=>p.evaluate(()=>{ const e=$('p-sheet'), r=e.getBoundingClientRect();
  /* every corner of every card, against the circle */
  const out=[];
  e.querySelectorAll('.card,.senrow,.conn').forEach(k=>{
    const q=k.getBoundingClientRect(); if(!q.height) return;
    [[q.left,q.top],[q.right,q.top],[q.left,q.bottom],[q.right,q.bottom]]
      .forEach(([x,y])=>{ if(Math.hypot(x-540,y-540)>534) out.push(k.className); }); });
  return {over:e.classList.contains('over'), top:Math.round(e.scrollTop),
          room:e.scrollHeight-e.clientHeight, h:Math.round(r.height),
          cards:[...e.querySelectorAll('.card')].filter(k=>k.offsetHeight).length,
          outside:[...new Set(out)]}; });
let S=await sh();
t.ok(S.cards===3, 'three cards, everything the panel has left - the start '
     +'moved to the course sheet, with the rest of the start', String(S.cards));
t.ok(S.room===0, 'and all of it inside the glass at once', S.h+' px tall');
t.ok(!S.over, 'so nothing is faded off an edge');
t.ok(S.outside.length===0, 'and no card corner is out in the black',
     S.outside.join(' '));
/* A row of two reads as one row only if it IS one row. */
const row=await p.evaluate(()=>{
  const h=[...document.querySelectorAll('#p-sheet .card')]
    .filter(k=>k.offsetHeight).map(k=>Math.round(k.getBoundingClientRect().height));
  const mid=el=>{ const q=el.getBoundingClientRect(); return Math.round(q.top+q.height/2); };
  const card=$('dim').closest('.card').getBoundingClientRect();
  const tr=$('dim').getBoundingClientRect();
  return {h, slider:mid($('dim')), stepper:mid($('d-down')),
          thumbClear:Math.round(card.bottom-(tr.top+tr.height/2+38))}; });
/* Cards two at a time: a row of two is one height. An odd last card
   has no pair and is simply its own. */
const pairs=row.h.reduce((a,_,i)=>i%2?a.concat([row.h.slice(i-1,i+1)]):a,[]);
t.ok(pairs.every(([a,b])=>a===b), 'a row of two is one height, not two',
     JSON.stringify(row.h));
t.ok(Math.abs(row.slider-row.stepper)<=1,
     'the brightness slider sits on the depth steppers\' line',
     row.slider+' vs '+row.stepper);
t.ok(row.thumbClear>0,
     'and its thumb, which stands 31 px proud of a 14 px track, clears the border',
     row.thumbClear+' px');

t.head('and scrolls if it ever stops fitting');
/* The backstop. Forced here rather than waited for: the layout above
   is what stops it happening, and the day a section is added is not
   the day to find out this was never wired. */
await p.evaluate(()=>{ $('p-sheet').style.maxHeight='520px'; sheetFit(); });
await p.waitForTimeout(300);
const pull=(y0,y1)=>p.evaluate(([y0,y1])=>{ const el=$('p-sheet');
  const ev=(t,y)=>el.dispatchEvent(new PointerEvent(t,{pointerId:1,clientX:540,
    clientY:y,bubbles:true,pointerType:'touch'}));
  ev('pointerdown',y0);
  const st=y1>y0?40:-40;
  for(let y=y0; y1>y0?y<=y1:y>=y1; y+=st) ev('pointermove',y);
  ev('pointermove',y1); ev('pointerup',y1); },[y0,y1]);
S=await sh();
t.ok(S.room>0 && S.over, 'it knows, and fades its edges rather than cutting off',
     S.room+' px over');
await pull(660,380); await p.waitForTimeout(400);
S=await sh();
t.ok(S.top>100, 'a drag up scrolls it', S.top+' px down');
t.ok((await state(p)).panel, 'and does NOT close the panel under the finger');
/* Until it runs out, not a fixed count: one drag past the end is the
   drag that gets handed back, and that one closes the panel. */
for(let i=0;i<8;i++){ const q=await sh();
  if(q.room-q.top<2) break;
  await pull(660,380); await p.waitForTimeout(250); }
S=await sh();
t.ok(S.room-S.top<2, 'repeated drags take it to the end', S.top+' of '+S.room);
t.ok((await state(p)).panel, 'and not one of them closes the panel');
await pull(660,380); await p.waitForTimeout(700);
t.ok(!(await state(p)).panel,
     'and at the end the drag is handed back, so the same swipe closes it');
await p.evaluate(()=>{ $('p-sheet').style.maxHeight=''; sheetFit(); });

await t.done(b);
