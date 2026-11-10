/* The house bank, and the one thing this app must never do.

   A battery page reading 0% because nothing is connected is
   indistinguishable from a flat bank, and it is the one number anybody
   would act on at two in the morning. So the shape of this probe is:
   with a feed, the readings are right; WITHOUT one, every single one of
   them is an em dash and the page says why.

   The app reads Signal K paths and nothing else. Whatever ends up
   reading the BMS - a plugin over Bluetooth, a wire into netd - arrives
   through the same door, which is why the probe can feed it directly
   and still be testing the real thing.

       python3 -m http.server 8080   (run.sh does this)
       node tests/energy.mjs
*/
import {open, tally} from './helpers.mjs';
const t=tally();
/* The harness's `demo` option only ever turns it ON, and CFG.windDemo
   is TRUE by default - so this has to be explicit or the invented bank
   sits on top of everything fed below and half of this probe passes by
   luck. */
const {b,p}=await open(t,{});
await p.evaluate(()=>demoSet(false)); await p.waitForTimeout(300);

const BP='electrical.batteries.house.';
/* Straight into the store, the way the socket would. put() and not
   feedPut(): a real BMS carries no demo stamp. */
const feed=(o)=>p.evaluate(([bp,o])=>{
  Object.entries(o).forEach(([k,v])=>put(bp+k,v)); }, [BP,o]);
const blank=()=>p.evaluate(bp=>{ Object.keys(S).forEach(k=>{
  if(k.startsWith(bp)) delete S[k]; }); }, BP);
const face=()=>p.evaluate(()=>({
  pct:$('en-pct').textContent, v:$('en-v').textContent,
  a:$('en-a').textContent,     alab:$('en-alab').textContent,
  w:$('en-w').textContent,     link:$('en-link').textContent,
  fill:$('en-fill').style.width, low:$('en-fill').classList.contains('low'),
  none:$('en-soc').classList.contains('none'),
  cv:[...document.querySelectorAll('.en-c s')].map(e=>e.textContent),
  bars:[...document.querySelectorAll('.en-c u')].map(e=>e.style.height),
  foot:$('en-foot').textContent}));
const paint=async()=>{ await p.evaluate(()=>enPaint()); await p.waitForTimeout(80); };

t.head('it is an app on the dock, like the other four');
await p.evaluate(()=>drawApps());
const dock=await p.evaluate(()=>({
  ids:APPS.map(a=>a.id),
  tiles:[...document.querySelectorAll('#app-row [data-app]')]
          .map(e=>e.querySelector('span').textContent)}));
t.ok(dock.ids.includes('energy'), 'Energy is in APPS', dock.ids.join());
t.ok(dock.tiles.includes('ENERGY'), 'and has a tile with a name on it',
     dock.tiles.join('|'));

t.head('with a bank feeding, it reads the bank');
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='energy')));
await p.waitForTimeout(500);
await feed({'voltage':13.28, 'current':-18.4, 'power':-244.4,
            'capacity.stateOfCharge':0.76, 'capacity.timeRemaining':15120,
            'temperature':273.15+21,
            'cells.0.voltage':3.320, 'cells.1.voltage':3.322,
            'cells.2.voltage':3.318, 'cells.3.voltage':3.320});
await paint();
let f=await face();
t.ok(f.pct==='76', 'the state of charge, as a percentage of the ratio Signal '
     +'K publishes', f.pct);
t.ok(f.fill==='76%', 'and the bar agrees with the number above it', f.fill);
t.ok(f.v==='13.28', 'the volts', f.v);
t.ok(f.a==='18.4' && f.alab==='AMPS OUT',
     'the amps as a magnitude and a word - Signal K signs current INTO the '
     +'battery, which is correct and is the opposite of how anyone says it',
     f.a+' '+f.alab);
t.ok(f.w==='244', 'the watts', f.w);
t.ok(f.cv.join()==='3.320,3.322,3.318,3.320', 'every cell', f.cv.join());
t.ok(/SPREAD 4 MV/.test(f.foot), 'and the spread between them, in millivolts, '
     +'which is the number that says whether the pack is healthy', f.foot);
t.ok(/21°C/.test(f.foot), 'with the temperature, in C off Signal K\'s kelvin',
     f.foot);
t.ok(/4 H 12 M LEFT/.test(f.foot), 'and what is left, in hours and minutes - '
     +'15120 seconds is a number nobody converts in their head', f.foot);

t.head('charging says so');
await feed({'current':24.2, 'power':321, 'capacity.timeRemaining':null});
await paint(); f=await face();
t.ok(f.a==='24.2' && f.alab==='AMPS IN', 'in, not minus', f.a+' '+f.alab);
t.ok(!/LEFT/.test(f.foot),
     'and no time remaining - time-to-empty while the charger is on is a '
     +'number with nothing behind it', f.foot);

t.head('the cells are a balance view, not a charge view');
/* Four bars of absolute voltage on lithium are four identical bars: the
   plateau is the whole character of the chemistry. The bar is each
   cell's distance from the pack mean over a fixed +/-30 mV window. */
await feed({'cells.0.voltage':3.320, 'cells.1.voltage':3.320,
            'cells.2.voltage':3.320, 'cells.3.voltage':3.320});
await paint(); f=await face();
t.ok(f.bars.every(h=>Math.abs(parseFloat(h)-50)<0.2),
     'a pack in balance is a level row at half height', f.bars.join());
await feed({'cells.2.voltage':3.350});
await paint(); f=await face();
const h=await p.evaluate(()=>[...document.querySelectorAll('.en-c u')]
  .map(e=>parseFloat(e.style.height)));
t.ok(h[2]>h[0] && h[2]>h[1] && h[2]>h[3],
     'and one cell walking away is the only thing that moves', h.join());
t.ok(h[2]<=100 && Math.min(...h)>=0, 'clamped, so a dead cell cannot draw '
     +'outside its own box', h.join());
await feed({'cells.2.voltage':3.320});

t.head('a flat bank is coloured like one');
await feed({'capacity.stateOfCharge':0.55}); await paint();
t.ok(!(await face()).low, 'at 55% the bar is the ordinary accent');
await feed({'capacity.stateOfCharge':0.18}); await paint();
t.ok((await face()).low, 'at 18% it is the alarm colour');

t.head('AND WITH NOTHING FEEDING IT, NOT ONE READING IS A NUMBER');
/* The whole point. Every value goes through get(), which returns null
   past staleAfter, and null draws a dash - never 0, which would be a
   flat battery rather than an absent one. */
await blank(); await paint();
f=await face();
t.ok(f.pct==='—', 'no state of charge', f.pct);
t.ok(f.v==='—' && f.a==='—' && f.w==='—', 'no volts, no amps, no watts',
     [f.v,f.a,f.w].join());
t.ok(f.cv.length===0, 'and no cells at all, rather than four empty boxes',
     String(f.cv.length));
t.ok(f.foot==='', 'nothing in the foot either - no spread of nothing, no '
     +'temperature of nothing', JSON.stringify(f.foot));
t.ok(f.fill==='0%', 'the bar is empty');
t.ok(!f.low, 'and NOT red, because an absent bank is not a flat one');
t.ok(f.none, 'the percent sign goes with the number it belonged to');
t.ok(f.link==='NO BATTERY FEED',
     'and the page says why, once, at the top - rather than leaving a row '
     +'of dashes to be read as a fault in the battery', f.link);

t.head('a stale reading is an absent one, not a frozen one');
/* The failure that matters with a radio link: a client that keeps the
   last value it was pushed shows 82% all afternoon. get() will not. */
await feed({'capacity.stateOfCharge':0.82});
await paint();
t.ok((await face()).pct==='82', 'a fresh reading shows');
await p.evaluate(bp=>{ S[bp+'capacity.stateOfCharge'].t -= 60000; }, BP);
await paint();
t.ok((await face()).pct==='—',
     'and a minute later, with nothing since, it is gone rather than held');

t.head('a 3S pack draws three cells, not four with a gap');
await blank();
await feed({'cells.0.voltage':3.31,'cells.1.voltage':3.32,'cells.2.voltage':3.30});
await paint();
t.ok((await face()).cv.length===3, 'three', String((await face()).cv.length));
await feed({'cells.3.voltage':3.33}); await paint();
t.ok((await face()).cv.length===4, 'and it grows to four if a fourth appears',
     String((await face()).cv.length));

t.head('closing and reopening does not leave stale text on the glass');
/* The frame's own trap, found here: the cached writers skip a write
   whose value has not changed, keyed by element id - right for a
   permanent node, wrong for one that was just deleted and rebuilt with
   a placeholder in it. closeApp() clears the cache now. */
await feed({'capacity.stateOfCharge':0.64, 'voltage':13.1});
await paint();
t.ok((await face()).pct==='64', 'a value on the face before closing');
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='energy')));
await p.waitForTimeout(600);
f=await face();
t.ok(f.pct==='64' && f.v==='13.10',
     'and the same value after, not the placeholder it was rebuilt with',
     f.pct+' / '+f.v);

t.head('the demo invents a bank, and yields the moment a real one answers');
await p.evaluate(()=>{ closeApp(); demoSet(true); });
await p.waitForTimeout(900);
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='energy')));
await p.waitForTimeout(900);
f=await face();
t.ok(/^\d+$/.test(f.pct) && f.cv.length===4,
     'the screen can be looked at before the board is out of its envelope',
     f.pct+'% / '+f.cv.length+' cells');
t.ok(f.link==='', 'and it does not claim to have no feed', f.link);
await p.evaluate(()=>demoSet(false));
await p.waitForTimeout(400); await paint();
t.ok((await face()).link==='NO BATTERY FEED',
     'switched off, what it wrote goes with it rather than lingering until '
     +'it happens to go stale', (await face()).link);

t.head('and a real bank is not fought over by the invented one');
/* The bug this probe was written late enough to catch. demoBank wrote
   unconditionally at first, and the demo runs at 8 Hz whether or not
   anything real is publishing - so a genuine BMS would have had its
   readings overwritten eight times a second by a fiction.
   
   DEMO_REAL is the wrong tool for it: that stands the WHOLE demo down,
   which is right for an instrument saying the boat is real and wrong
   for one saying only that the battery is. So the bank defers path by
   path through feedOwns, the way the GPS group does, and the invented
   vane keeps blowing. */
await p.evaluate(()=>{ closeApp(); demoSet(true); });
await p.waitForTimeout(700);
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='energy')));
await p.waitForTimeout(600);
/* put(), not feedPut: a reading off the socket carries no demo stamp,
   which is exactly what makes it win. */
await feed({'voltage':12.91, 'capacity.stateOfCharge':0.41});
await p.waitForTimeout(900);          /* seven demo ticks to be overwritten in */
await paint();
f=await face();
t.ok(f.v==='12.91' && f.pct==='41',
     'the real reading stands, after seven ticks of the demo running over it',
     f.v+' / '+f.pct);
t.ok(await p.evaluate(()=>CFG.windDemo),
     'and the demo is still ON - a BMS says the battery is real, not that '
     +'the boat is, so the invented wind is still blowing');
t.ok(await p.evaluate(()=>get('environment.wind.speedTrue')!==null),
     'which it is');
await p.evaluate(()=>demoSet(false));

await p.evaluate(()=>closeApp());
t.done(); await b.close();
