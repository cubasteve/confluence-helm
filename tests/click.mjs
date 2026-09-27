/* The noise the glass makes under a finger: which controls make one,
   which gestures do not, the cycle that chooses it, and that it survives
   a reload. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true});

/* The listener calls clickPlay, which builds Web Audio nodes. Counting
   the calls is the honest test of 'did this tap make a noise' - the
   sound itself is five oscillators and a headless browser has no ears.
   clickPlay is a function declaration, so the page's own binding is on
   window and can be swapped. */
const arm=()=>p.evaluate(()=>{ window.__clicks=[];
  if(!window.__realPlay) window.__realPlay=window.clickPlay;
  window.clickPlay=k=>{ window.__clicks.push(k||CFG.click); }; });
const heard=()=>p.evaluate(()=>window.__clicks.slice());
const tapAt=async(x,y)=>{ await p.mouse.click(x,y); await p.waitForTimeout(120); };

/* FIRST, before anything in this file has played a note: OFF has to
   cost nothing, and nothing is only checkable while nothing has been
   built yet. An AudioContext is a whole extra Chromium process - 26 MB
   of it - so 'off' meaning 'silent but still running' would be a poor
   trade for a boat computer. */
t.head('OFF builds nothing at all');
t.ok(await p.evaluate(()=>CFG.click)==='glass',
     'the voice out of the box is the pane itself under a fingernail',
     await p.evaluate(()=>CFG.click));
await p.evaluate(()=>{ CFG.click='off'; openCourse(); });
await p.waitForTimeout(800);
await p.evaluate(()=>{ COURSE.marks=['rum']; COURSE.next=0; COURSE.side=['P'];
  courseSave(); openCourse(); });
await p.waitForTimeout(500);
for(const sel of ['.cv-tile[data-mark="gosling"]','#course-edit','#course-edit','#cv-mins'])
  { await p.click(sel); await p.waitForTimeout(120); }
t.ok(await p.evaluate(()=>AC===null),
     'four taps on real controls and there is still no audio context - '
     +'off is off, not silent', String(await p.evaluate(()=>AC)));
await p.evaluate(()=>{ CFG.click='tick'; closeLib(); closeApp(); });
await p.waitForTimeout(400);

t.head('the voices are five, and all of them build');
t.ok((await p.evaluate(()=>CLICK_KEYS.join()))
       === 'off,tick,glass,crystal,pad,frost,drop,key,bell,thock',
     'off and nine to choose from', await p.evaluate(()=>CLICK_KEYS.join()));
t.ok(await p.evaluate(()=>{
       for(const k of CLICK_KEYS){ try{ clickPlay(k); }catch(e){ return 'threw on '+k; } }
       return true; })===true,
     'every one of them builds its graph without throwing');
t.ok(await p.evaluate(()=>!!AC && AC.state==='running'),
     'and the first of them brought the audio context up',
     await p.evaluate(()=>AC?AC.state:'none'));
t.ok(await p.evaluate(()=>CLICK_KEYS.filter(k=>k!=='off')
       .every(k=>typeof CLICK_GAIN[k]==='number')),
     'each carries its own gain - five sounds at one peak are not five '
     +'sounds at one loudness');

t.head('a control makes one, and a gesture does not');
await p.evaluate(()=>{ CFG.click='tick'; openCourse(); });
await p.waitForTimeout(800);
await p.evaluate(()=>{ COURSE.marks=['rum']; COURSE.next=0; COURSE.side=['P'];
  courseSave(); openCourse(); });
await p.waitForTimeout(500);
await arm();
await p.click('.cv-tile[data-mark="gosling"]'); await p.waitForTimeout(150);
t.ok((await heard()).length===1, 'a mark tile', JSON.stringify(await heard()));
await arm(); await p.click('#course-edit'); await p.waitForTimeout(150);
t.ok((await heard()).length===1, 'a heading button');
await arm(); await p.click('#course-edit'); await p.waitForTimeout(150);
await arm(); await p.click('#cv-line'); await p.waitForTimeout(250);
t.ok((await heard()).length===1, 'the line in the route');
await p.evaluate(()=>pickClose());
await arm(); await p.click('#cv-mins'); await p.waitForTimeout(150);
t.ok((await heard()).length===1, 'a setting');
/* bare glass between the sheet's sections is not a control */
await arm(); await tapAt(540, 245);
t.ok((await heard()).length===0, 'and the glass beside them is silent',
     JSON.stringify(await heard()));

t.head('OFF is silent, and the voice chosen is the voice played');
await arm();
await p.evaluate(()=>{ CFG.click='off'; });
await p.click('.cv-tile[data-mark="cb8"]'); await p.waitForTimeout(150);
t.ok((await heard()).length===0, 'nothing at all on OFF');
await p.evaluate(()=>{ CFG.click='bell'; });
await arm(); await p.click('.cv-tile[data-mark="cb8"]'); await p.waitForTimeout(150);
t.ok((await heard()).join()==='bell', 'and the one you chose otherwise',
     (await heard()).join());

t.head('the panel cycles it, and plays what it lands on');
await p.evaluate(()=>{ window.clickPlay=window.__realPlay; closeLib(); closeApp();
  CFG.click='off'; clkPaint(); });
await p.waitForTimeout(300);
const lbl=()=>p.evaluate(()=>$('clk-voice').textContent);
t.ok(await lbl()==='OFF', 'the button says which one is on', await lbl());
await arm();
await p.evaluate(()=>$('clk-voice').click()); await p.waitForTimeout(120);
t.ok(await p.evaluate(()=>CFG.click)==='tick', 'a tap moves it on',
     await p.evaluate(()=>CFG.click));
t.ok(await lbl()==='TICK', 'and the button says so');
t.ok((await heard()).length>=1, 'and plays it - the only way to choose a '
     +'sound is to hear it', JSON.stringify(await heard()));
await p.evaluate(()=>{ window.clickPlay=window.__realPlay; });
for(let i=0;i<9;i++) await p.evaluate(()=>$('clk-voice').click());
t.ok(await p.evaluate(()=>CFG.click)==='off', 'ten taps come back round',
     await p.evaluate(()=>CFG.click));
t.ok(await p.evaluate(()=>CLICK_KEYS.filter(k=>k!=='off')
       .every(k=>CLICK_LBL[k] && typeof CLICK_GAIN[k]==='number')),
     'and every voice has a name on the button and a gain of its own');

t.head('and it is remembered');
await p.evaluate(()=>{ CFG.click='thock'; prefsSave(); });
await p.reload({waitUntil:'load'});
await p.waitForTimeout(1800); await p.evaluate(()=>bootSettle());
await p.waitForTimeout(1500);
t.ok(await p.evaluate(()=>CFG.click)==='thock', 'across a reload',
     await p.evaluate(()=>CFG.click));
t.ok(await p.evaluate(()=>$('clk-voice').textContent)==='THOCK',
     'and the panel comes up saying it');
await p.evaluate(()=>{ localStorage.setItem(PREFS_KEY,
  JSON.stringify({click:'banjo'})); });
await p.reload({waitUntil:'load'});
await p.waitForTimeout(1800); await p.evaluate(()=>bootSettle());
await p.waitForTimeout(1200);
t.ok(await p.evaluate(()=>CFG.click)==='glass',
     'a voice this build has never heard of falls back to the default - '
     +'a fingernail on the pane - rather than going silent',
     await p.evaluate(()=>CFG.click));

await t.done(b);
