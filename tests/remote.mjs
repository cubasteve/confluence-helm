/* The panel's half of the phone remote: the catalogue it hands netd,
   and what it does with a command that comes back.

   netd's half is tests/remote_test.py. The seam between them is the
   shape of the catalogue, and the two halves have already disagreed
   about it once - netd validated commands against a list of keys while
   the phone page read .name and .sen off the same field - so the first
   thing here is that what this side SENDS is what that side accepts. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true});

t.head('the catalogue is the one netd validates against');
const cat=await p.evaluate(()=>remoteCat());
t.ok(JSON.stringify(cat.slots)===JSON.stringify({mus:['a','p','s'],
       dial:['c0','c1','c2','c3','c4']}),
     'a slot list per page, named as the panel names them',
     JSON.stringify(cat.slots));
t.ok(cat.readings.length>10, 'every reading the panel can show',
     String(cat.readings.length));
/* The shape netd now refuses outright, because accepting it is what let
   the two halves drift: bare keys validate but will not draw. */
t.ok(cat.readings.every(r=>r&&typeof r==='object'&&r.k&&r.name&&r.sen),
     'each one an object with a key, a name and a group');
t.ok(cat.readings.every(r=>Object.keys(r).length===3),
     'and nothing else on it - no value goes over this wire',
     JSON.stringify(cat.readings[0]));
const themes=await p.evaluate(()=>THEMES);
t.ok(JSON.stringify(cat.themes)===JSON.stringify(themes),
     'the themes, from the one list the button cycles', JSON.stringify(cat.themes));

t.head('and it carries what is in each slot right now');
const now=await p.evaluate(()=>remoteNow());
t.ok(Object.keys(now.slots).length===8, 'one entry per slot, flat',
     JSON.stringify(now.slots));
t.ok(now.slots['dial:c1']==='dpt' && now.slots['mus:a']==='hdg',
     'saying what is in them', JSON.stringify(now.slots));
t.ok(now.theme===await p.evaluate(()=>CFG.theme), 'and the theme');
/* A change made ON THE GLASS has to show up here, or the phone draws
   the panel as it was when it booted. */
await p.evaluate(()=>slotSet('dial','c2','cog'));
t.ok((await p.evaluate(()=>remoteNow().slots['dial:c2']))==='cog',
     'and follows a change made at the panel');

t.head('a slot command lands, and is remembered');
await p.evaluate(()=>remoteDo({kind:'slot',page:'dial',slot:'c2',reading:'heel'}));
let st=await p.evaluate(()=>({map:DIAL.slot.c2,
  saved:JSON.parse(localStorage.getItem('dialSlots')||'{}').c2}));
t.ok(st.map==='heel', 'the slot is set', JSON.stringify(st));
t.ok(st.saved==='heel', 'and written down, so a reboot keeps it',
     JSON.stringify(st));

t.head('it swaps rather than duplicates, exactly as a tap does');
/* c0 is the big number and holds SOG. Asking c2 for SOG cannot mean
   two of them, and must not quietly move a reading you never touched. */
await p.evaluate(()=>remoteDo({kind:'slot',page:'dial',slot:'c2',reading:'sog'}));
st=await p.evaluate(()=>({c0:DIAL.slot.c0, c2:DIAL.slot.c2}));
t.ok(st.c2==='sog' && st.c0==='heel', 'the two change places',
     JSON.stringify(st));

t.head('nonsense from the network changes nothing');
const before=await p.evaluate(()=>JSON.stringify(remoteNow()));
await p.evaluate(()=>{
  remoteDo({kind:'slot',page:'nope', slot:'c2', reading:'dpt'});
  remoteDo({kind:'slot',page:'dial', slot:'c9', reading:'dpt'});
  remoteDo({kind:'slot',page:'dial', slot:'c2', reading:'unicorns'});
  remoteDo({kind:'slot',page:'__proto__', slot:'c2', reading:'dpt'});
  remoteDo({kind:'theme',theme:'chartreuse'});
  remoteDo({kind:'burn-the-boat'});
  remoteDo(null); remoteDo({});
});
t.ok((await p.evaluate(()=>JSON.stringify(remoteNow())))===before,
     'a bad page, slot, reading, theme or kind is simply not done');

t.head('the theme comes over, and sticks');
await p.evaluate(()=>remoteDo({kind:'theme',theme:'night'}));
st=await p.evaluate(()=>({cfg:CFG.theme, cls:document.body.className,
  saved:JSON.parse(localStorage.getItem(PREFS_KEY)||'{}').theme}));
t.ok(st.cfg==='night' && /night/.test(st.cls), 'night is on the body',
     JSON.stringify(st));
t.ok(st.saved==='night', 'and saved with the rest of the preferences',
     JSON.stringify(st));
await p.evaluate(()=>remoteDo({kind:'theme',theme:'auto'}));
t.ok((await p.evaluate(()=>CFG.theme))==='auto', 'and auto comes back');

t.head('no flash: the cell is painted by the frame, not by the command');
/* paintDialCells runs before paintRace inside a frame, deliberately, so
   a repaint from outside the loop puts slot text under a race override
   for one frame and the override takes it back on the next. One frame
   is still a flash. The command marks the cells and the loop paints
   them - so the DOM is untouched in the turn the command arrives.
   Both reads are inside ONE evaluate: no frame can land between them. */
const flash=await p.evaluate(()=>{
  const was=$('c2-lbl').textContent;
  remoteDo({kind:'slot',page:'dial',slot:'c2',reading:'twa'});
  return {was:was, straightAfter:$('c2-lbl').textContent,
          key:dialCellKey, map:DIAL.slot.c2};
});
t.ok(flash.map==='twa', 'the command is applied', JSON.stringify(flash));
t.ok(flash.straightAfter===flash.was,
     'the cell is not rewritten on the spot', JSON.stringify(flash));
t.ok(flash.key==='', 'it is marked for the next frame instead', flash.key);
await p.waitForTimeout(300);
t.ok(/TWA/.test(await p.evaluate(()=>$('c2-lbl').textContent)),
     'which paints it, in the frame, in the right order',
     await p.evaluate(()=>$('c2-lbl').textContent));
/* The panel's own menu still paints at once: you have just watched it
   close over that cell and it has to be right. */
const tap=await p.evaluate(()=>{
  const was=$('c2-lbl').textContent;
  slotSet('dial','c2','heel');
  return {was:was, straightAfter:$('c2-lbl').textContent};
});
t.ok(tap.straightAfter!==tap.was, 'a tap on the glass does not wait',
     JSON.stringify(tap));

t.head('a menu open on that very slot does not stay open');
await p.evaluate(()=>musPickOpen('dial','c3',$('c3-lbl')));
await p.waitForTimeout(250);
t.ok(await p.evaluate(()=>!!PICK), 'the picker is up');
await p.evaluate(()=>remoteDo({kind:'slot',page:'dial',slot:'c3',reading:'cog'}));
t.ok(await p.evaluate(()=>!PICK),
     'and the phone answering its question closes it');
await p.evaluate(()=>musPickOpen('dial','c3',$('c3-lbl')));
await p.waitForTimeout(250);
await p.evaluate(()=>remoteDo({kind:'slot',page:'dial',slot:'c1',reading:'awa'}));
t.ok(await p.evaluate(()=>!!PICK),
     'a command for a DIFFERENT slot leaves it alone');
await p.evaluate(()=>pickClose());

t.head('the loop: what it sends, and what it makes of the answer');
/* netApi is stubbed, so this is the loop's own logic and not a network
   test. The real loop's pending timer is cleared first: a genuine tick
   landing inside a stubbed one would show up as a phantom poll.
   The previous version of this section asked whether remoteStart left
   REM.on true after being called twice - which it does either way, so
   the line could not fail and was not worth having. */
const loop=await p.evaluate(async()=>{
  clearTimeout(REM.t);
  const real=netApi, sent=[];
  let reply=null;
  netApi=async(path,body)=>{ sent.push({path:path,body:body}); return reply; };
  const out={};
  try{
    REM.ms=REM.FAST;
    reply=null;                        /* no helper, or it is mid-nmcli */
    await remoteTick();
    out.backoff=REM.ms;
    out.polled=sent[0].path;
    out.sentNow=!!(sent[0].body&&sent[0].body.now&&
                   sent[0].body.now.slots&&sent[0].body.now.theme);
    reply={ok:true,armed:true,have:false,cmds:{}};   /* netd has forgotten */
    await remoteTick();
    out.recovered=REM.ms;
    out.reregistered=sent[sent.length-1].path;
    out.cat=!!(sent[sent.length-1].body||{}).readings;
    reply={ok:true,armed:true,have:true,cmds:{
      'slot:dial:c2':{kind:'slot',page:'dial',slot:'c2',reading:'vmg'},
      'theme':{kind:'theme',theme:'dusk'}}};
    await remoteTick();
    out.applied=DIAL.slot.c2; out.theme=CFG.theme;
    const n=sent.length; remoteStart(); remoteStart();
    out.extraStarts=sent.length-n;
  } finally { netApi=real; }
  return out;
});
t.ok(loop.polled==='/remote/poll', 'it polls one endpoint', loop.polled);
t.ok(loop.sentNow, 'carrying what the panel is showing, so the phone can draw it');
t.ok(loop.backoff===15000,
     'a helper that does not answer backs the poll off to fifteen seconds',
     String(loop.backoff));
t.ok(loop.recovered===1500, 'and an answer brings it straight back',
     String(loop.recovered));
t.ok(loop.reregistered==='/remote/register' && loop.cat,
     'netd admitting it has forgotten gets the catalogue again',
     loop.reregistered);
t.ok(loop.applied==='vmg' && loop.theme==='dusk',
     'and a poll carrying two commands does both',
     JSON.stringify(loop));
t.ok(loop.extraStarts===0,
     'remoteStart is idempotent: a second call is not a second loop',
     String(loop.extraStarts));

await b.close();
t.done();
