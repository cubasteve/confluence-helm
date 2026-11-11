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
  w:$('en-w').textContent,     ain:$('en-a').classList.contains('in'),
  sub:$('en-sub').textContent, subBad:$('en-sub').classList.contains('bad'),
  subWarn:$('en-sub').classList.contains('warn'),
  st:$('en-stxt').textContent, stOff:$('en-state').classList.contains('off'),
  stChg:$('en-state').classList.contains('chg'),
  stBad:$('en-state').classList.contains('bad'),
  dash:$('en-arc').getAttribute('stroke-dasharray'),
  off:$('en-arc').classList.contains('off'),
  low:$('en-arc').classList.contains('low'),
  chg:$('en-arc').classList.contains('chg'),
  none:$('en-core').classList.contains('none'),
  cv:[...document.querySelectorAll('.en-c s')].map(e=>e.textContent),
  bars:[...document.querySelectorAll('.en-c u')].map(e=>e.style.height),
  far:[...document.querySelectorAll('.en-c')].map(e=>e.classList.contains('far')),
  f1:$('en-f1').textContent, f2:$('en-f2').textContent}));
const paint=async()=>{ await p.evaluate(()=>enPaint()); await p.waitForTimeout(80); };
const openEn=async(ms=600)=>{
  await p.evaluate(()=>openApp(APPS.find(a=>a.id==='energy')));
  await p.waitForTimeout(ms); };

t.head('it is an app on the dock, like the other four');
await p.evaluate(()=>drawApps());
const dock=await p.evaluate(()=>({
  ids:APPS.map(a=>a.id),
  tiles:[...document.querySelectorAll('#app-row [data-app]')]
          .map(e=>e.querySelector('span').textContent)}));
t.ok(dock.ids.includes('energy'), 'Energy is in APPS', dock.ids.join());
t.ok(dock.tiles.includes('ENERGY'), 'and has a tile with a name on it',
     dock.tiles.join('|'));

t.head('ENERGY is said ONCE, by the frame');
/* The app used to put a heading of its own under the frame's name pill,
   so the top of the glass read ENERGY and then HOUSE BANK - the page
   saying twice what it is and not once what it was doing. There is one
   battery on this boat. */
await openEn();
const head=await p.evaluate(()=>({
  pill:$('app-name').textContent.trim(),
  heads:[...$('app-body').querySelectorAll('.a-head,.a-h1,.a-h2')]
          .map(e=>e.textContent.trim())}));
t.ok(head.pill==='Energy'||/ENERGY/i.test(head.pill),
     'the frame names the app', head.pill);
t.ok(head.heads.length===0,
     'and the app body adds no heading of its own under it',
     JSON.stringify(head.heads));

t.head('the gauge is an arc, and pathLength is what drives it');
/* Drawn as a CIRCLE with pathLength="100", so a repaint changes one
   number in a dash array and nothing else. The attribute is the whole
   mechanism: written in markup it goes through the HTML parser's
   foreign-content fixup, and if that ever stopped camel-casing it the
   dash array would be in user units against a circumference of 1583 -
   the arc would collapse to a 75-unit stub and still LOOK like a
   gauge at low charge. */
const geo=await p.evaluate(()=>({
  arc:$('en-arc').pathLength.baseVal, trk:$('en-trk').pathLength.baseVal,
  r:+$('en-arc').getAttribute('r'),
  len:Math.round($('en-arc').getTotalLength()),
  trkDash:$('en-trk').getAttribute('stroke-dasharray'),
  offset:$('en-arc').getAttribute('stroke-dashoffset')}));
t.ok(geo.arc===100 && geo.trk===100,
     'pathLength survived the parser on both circles',
     geo.arc+' / '+geo.trk);
t.ok(geo.len>1500,
     'which it had to, because the circle itself is 1583 units round',
     String(geo.len));
t.ok(geo.trkDash==='75 25' && geo.offset==='-37.5',
     'the track is 75 of 100 - 270 degrees - starting at half past seven, '
     +'which leaves the gap at the foot where the close button is',
     geo.trkDash+' @ '+geo.offset);

t.head('with a bank feeding, it reads the bank');
await feed({'voltage':13.28, 'current':-18.4, 'power':-244.4,
            'capacity.stateOfCharge':0.76, 'capacity.timeRemaining':15120,
            'capacity.stateOfHealth':0.98, 'capacity.nominalAh':100,
            'cycles':37, 'rssi':-58, 'problem':0,
            'temperature':273.15+21,
            'cells.0.voltage':3.320, 'cells.1.voltage':3.322,
            'cells.2.voltage':3.318, 'cells.3.voltage':3.320});
await paint();
let f=await face();
t.ok(f.pct==='76', 'the state of charge, as a percentage of the ratio Signal '
     +'K publishes', f.pct);
t.ok(f.dash==='57.00 100' && !f.off,
     'and the arc agrees with the number inside it - 76% of the 75 units '
     +'the arc spans is 57', f.dash);
t.ok(f.v==='13.28', 'the volts', f.v);
t.ok(f.a==='18.4' && f.alab==='AMPS OUT',
     'the amps as a magnitude and a word - Signal K signs current INTO the '
     +'battery, which is correct and is the opposite of how anyone says it',
     f.a+' '+f.alab);
t.ok(f.w==='244', 'the watts', f.w);
t.ok(f.st==='DISCHARGING' && !f.stOff && !f.stChg,
     'what the bank is DOING, in a word, which the old face never said at '
     +'all - it put a signed number under a label and left you to read it',
     f.st);
t.ok(f.sub==='4 H 12 M LEFT',
     'what is left, in hours and minutes, under the number - 15120 seconds '
     +'is a figure nobody converts in their head', f.sub);
t.ok(f.cv.join()==='3.320,3.322,3.318,3.320', 'every cell', f.cv.join());
t.ok(/76 OF 100 AH/.test(f.f1),
     'the amp-hours, which is how anybody actually holds a battery in their '
     +'head - and which is arithmetic on two things the pack DID report', f.f1);
t.ok(/21°C/.test(f.f1), 'the temperature, in C off Signal K\'s kelvin', f.f1);
t.ok(/SPREAD 4 MV/.test(f.f1), 'and the spread between the cells, in '
     +'millivolts, which is the number that says whether the pack is healthy',
     f.f1);
t.ok(/SOH 98%/.test(f.f2), 'the state of health the Eco-Worthy reports', f.f2);
t.ok(/37 CYCLES/.test(f.f2), 'the cycle count, when the plugin has one', f.f2);
t.ok(/BLE −58 DBM/.test(f.f2),
     'and the strength of the radio link, with a real minus sign - a bank on '
     +'Bluetooth four minutes stale looks exactly like one that is wrong',
     f.f2);
t.ok(f.f1.length>0 && f.f2.length>0 && f.f1.indexOf('SOH')<0,
     'this moment on the first line, the pack\'s life on the second',
     f.f1+' // '+f.f2);

t.head('charging says so, in three places and no more');
await feed({'current':24.2, 'power':321, 'capacity.timeRemaining':null});
await paint(); f=await face();
t.ok(f.a==='24.2' && f.alab==='AMPS IN', 'in, not minus', f.a+' '+f.alab);
t.ok(f.ain, 'the one reading whose sign is news takes a colour');
t.ok(f.st==='CHARGING' && f.stChg, 'the chip says so', f.st);
t.ok(f.chg && !f.low, 'and the arc goes to the starboard gradient');
t.ok(!/LEFT/.test(f.sub),
     'with no time remaining - time-to-empty while the charger is on is a '
     +'number with nothing behind it', f.sub);

t.head('and a bank doing nothing says that too');
await feed({'current':-0.04, 'power':-0.5});
await paint(); f=await face();
t.ok(f.st==='IDLE' && !f.stChg && !f.ain,
     'a BMS idling reports a few tens of milliamps of its own draw forever, '
     +'and that is not a discharge', f.st);
t.ok(f.alab==='AMPS', 'so the label drops the direction too', f.alab);

t.head('the cells are a balance view, not a charge view');
/* Four bars of absolute voltage on lithium are four identical bars: the
   plateau is the whole character of the chemistry. The bar is each
   cell's distance from the pack mean over a fixed +/-30 mV window. */
await feed({'cells.0.voltage':3.320, 'cells.1.voltage':3.320,
            'cells.2.voltage':3.320, 'cells.3.voltage':3.320});
await paint(); f=await face();
t.ok(f.bars.every(h=>Math.abs(parseFloat(h)-50)<0.2),
     'a pack in balance is a level row on the datum', f.bars.join());
t.ok(f.far.every(x=>!x),
     'and nothing is badged, because nothing is wrong');
await feed({'cells.2.voltage':3.350});
await paint(); f=await face();
let h=f.bars.map(x=>parseFloat(x));
t.ok(h[2]>h[0] && h[2]>h[1] && h[2]>h[3],
     'one cell walking away is the only thing that moves', h.join());
t.ok(h[2]<=100 && Math.min(...h)>0,
     'clamped, so a cell outside the window cannot draw past its own box - '
     +'but to a sliver and not to nothing, because a bar clamped to zero has '
     +'no ink left to carry the colour that says go and look at this one',
     h.join());
t.ok(f.far.join()==='false,false,true,false',
     'and at 30 mV the one furthest from the mean is badged, so you know '
     +'which to go and look at', f.far.join());
/* Either way: a cell dropping behind and one running away are the same
   thing to find. */
await feed({'cells.2.voltage':3.320, 'cells.0.voltage':3.290});
await paint();
t.ok((await face()).far.join()==='true,false,false,false',
     'below the mean as readily as above it');
await feed({'cells.0.voltage':3.320});
await paint();
t.ok((await face()).far.every(x=>!x),
     'and at three millivolts nothing is badged - a badge that hopped from '
     +'cell to cell once a second on a happy pack would be noise');

t.head('a flat bank is coloured like one');
await feed({'capacity.stateOfCharge':0.55}); await paint();
f=await face();
t.ok(!f.low && f.dash==='41.25 100', 'at 55% the arc is the ordinary accent',
     f.dash);
await feed({'capacity.stateOfCharge':0.18}); await paint();
t.ok((await face()).low, 'at 18% it is the port gradient');

t.head('a BMS that is unhappy outranks everything on the face');
/* The Eco-Worthy reports a raw 16-bit code with no published bit
   meanings, so the app reports the NUMBER and claims nothing else. */
await feed({'capacity.stateOfCharge':0.74, 'problem':4});
await paint(); f=await face();
t.ok(f.st==='BMS FAULT' && f.stBad, 'the chip says so', f.st);
t.ok(f.sub==='FAULT CODE 0x0004' && f.subBad,
     'and the code is shown raw - not decoded into a fault this app has no '
     +'bit meanings for', f.sub);
t.ok(f.low && !f.chg,
     'with the arc on the alarm gradient at 74%, which it would not be '
     +'otherwise');
await feed({'problem':0}); await paint();
t.ok((await face()).st==='DISCHARGING'||((await face()).st==='IDLE'),
     'cleared, it goes back to reporting the current');
t.ok(!(await face()).subBad && !/FAULT/.test((await face()).sub),
     'and the code goes with it');

t.head('a flag with no code says FAULT and no more');
await feed({'problem':true}); await paint(); f=await face();
t.ok(f.st==='BMS FAULT' && f.stBad, 'the flag is the flag', f.st);
t.ok(!/0x/.test(f.sub),
     'but a plugin publishing a bare boolean gets no invented hex', f.sub);
await feed({'problem':0});

t.head('two probes draw a range only when they disagree');
await feed({'temperatures.0':273.15+19, 'temperatures.1':273.15+24});
await paint();
t.ok(/19–24°C/.test((await face()).f1),
     'five degrees apart is two numbers', (await face()).f1);
await feed({'temperatures.1':273.15+20});
await paint();
t.ok(/\b20°C/.test((await face()).f1) && !/–/.test((await face()).f1),
     'one degree apart is one - the warmer, because that is the one every '
     +'limit is written against', (await face()).f1);
await p.evaluate(bp=>{ delete S[bp+'temperatures.0'];
                       delete S[bp+'temperatures.1']; }, BP);
await paint();
t.ok(/21°C/.test((await face()).f1),
     'and with no probes at all it falls back to the pack\'s own figure',
     (await face()).f1);

t.head('a capacity with no charge still says how big the bank is');
await p.evaluate(bp=>{ delete S[bp+'capacity.stateOfCharge']; }, BP);
await paint();
t.ok(/100 AH BANK/.test((await face()).f1),
     'rather than silently dropping the one number printed on the case',
     (await face()).f1);

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
t.ok(f.f1==='' && f.f2==='', 'nothing in the foot either - no spread of '
     +'nothing, no state of health of nothing',
     JSON.stringify(f.f1+'|'+f.f2));
t.ok(f.stOff, 'no chip, because there is nothing it is doing');
t.ok(f.off && f.dash==='0.00 100',
     'the arc is empty AND hidden: a zero-length dash with a round cap is a '
     +'dot, and a 28 px bead at the seven-o\'clock tip reads as 1% on the '
     +'one screen where nothing and almost nothing must not look alike',
     f.dash+(f.off?' (off)':' (SHOWING)'));
t.ok(!f.low, 'and NOT red, because an absent bank is not a flat one');
t.ok(f.none, 'the percent sign goes with the number it belonged to');
t.ok(f.sub==='NO BATTERY FEED' && f.subWarn && !f.subBad,
     'and the page says why, once, under the number - rather than leaving '
     +'eleven dashes to be read as a fault in the battery', f.sub);

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

t.head('and the bars come back when the row is rebuilt');
/* The cached writers are keyed by element id, and the row is rebuilt
   from innerHTML whenever the cell COUNT changes - so the ids come back
   pointing at brand new elements with no height on them while the cache
   still remembers the old one's 50%. Four identical cells is the case
   that proves it: the value the cache holds is the value the new bar
   needs, so without clearing it the write is skipped and the row draws
   four empty boxes. Same bug closeApp was carrying, one deck up. */
await blank();
await feed({'cells.0.voltage':3.32,'cells.1.voltage':3.32,
            'cells.2.voltage':3.32,'cells.3.voltage':3.32});
await paint();
t.ok((await face()).bars.every(x=>Math.abs(parseFloat(x)-50)<0.2),
     'four cells, four bars');
await p.evaluate(bp=>{ delete S[bp+'cells.3.voltage']; }, BP);
await paint();
await feed({'cells.3.voltage':3.32});
await paint();
f=await face();
t.ok(f.bars.length===4 && f.bars.every(x=>Math.abs(parseFloat(x)-50)<0.2),
     'and after the row has been torn down to three and built back to four, '
     +'four bars again - not four empty boxes at the same voltages',
     f.bars.join('|'));

t.head('closing and reopening does not leave stale text on the glass');
/* The frame's own trap, found here: the cached writers skip a write
   whose value has not changed, keyed by element id - right for a
   permanent node, wrong for one that was just deleted and rebuilt with
   a placeholder in it. closeApp() clears the cache now. */
await feed({'capacity.stateOfCharge':0.64, 'voltage':13.1});
await paint();
t.ok((await face()).pct==='64', 'a value on the face before closing');
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
await openEn();
f=await face();
t.ok(f.pct==='64' && f.v==='13.10',
     'and the same value after, not the placeholder it was rebuilt with',
     f.pct+' / '+f.v);

t.head('the demo invents a bank, and every line of the face is in it');
/* blank() FIRST, and not for tidiness. demoBank gates on owning the
   voltage - `if(!own(bp('voltage'))) return` - so with the real 13.1 V
   this probe put two sections ago still in the store the demo never
   writes a thing, and a section that reads the leftovers instead passes
   without the demo having run at all. Which is what the first draft of
   this probe did. */
await blank();
await p.evaluate(()=>{ closeApp(); demoSet(true); });
await p.waitForTimeout(900);
await openEn(900);
f=await face();
t.ok(/^\d+$/.test(f.pct) && f.cv.length===4,
     'the screen can be looked at before the board is out of its envelope',
     f.pct+'% / '+f.cv.length+' cells');
t.ok(f.sub!=='NO BATTERY FEED', 'and it does not claim to have no feed', f.sub);
t.ok(/OF 100 AH/.test(f.f1) && /°C/.test(f.f1) && /SPREAD \d+ MV/.test(f.f1),
     'the first foot line is all there', f.f1);
t.ok(/SOH \d+%/.test(f.f2) && /\d+ CYCLES/.test(f.f2)
     && /BLE \u2212\d+ DBM/.test(f.f2),
     'and so is the second - a demo that leaves half the face on dashes is '
     +'not exercising the half it leaves', f.f2);
t.ok(f.st==='CHARGING'||f.st==='DISCHARGING'||f.st==='IDLE',
     'with a state, and not a fault', f.st);
await p.evaluate(()=>demoSet(false));
await p.waitForTimeout(400); await paint();
t.ok((await face()).sub==='NO BATTERY FEED',
     'switched off, what it wrote goes with it rather than lingering until '
     +'it happens to go stale', (await face()).sub);

t.head('and a real bank is not fought over by the invented one');
/* The bug this probe was written late enough to catch. demoBank wrote
   unconditionally at first, and the demo runs at 8 Hz whether or not
   anything real is publishing - so a genuine BMS would have had its
   readings overwritten eight times a second by a fiction.

   DEMO_REAL is the wrong tool for it: that stands the WHOLE demo down,
   which is right for an instrument saying the boat is real and wrong
   for one saying only that the battery is. */
await blank();
await p.evaluate(()=>{ closeApp(); demoSet(true); });
await p.waitForTimeout(700);
await openEn();
/* put(), not feedPut: a reading off the socket carries no demo stamp,
   which is exactly what makes it win. One path, to prove the deference
   is PER PATH - the invented voltage has to go on moving beside it. */
await feed({'capacity.stateOfCharge':0.41});
await p.waitForTimeout(900);          /* seven demo ticks to be overwritten in */
await paint();
f=await face();
t.ok(f.pct==='41',
     'the real reading stands, after seven ticks of the demo running over it',
     f.pct);
t.ok(f.v!=='—' && parseFloat(f.v)>10,
     'while the rest of the invented bank carries on beside it, path by '
     +'path, the way the GPS group defers', f.v);
/* And the gate: the voltage is the one path demoBank reads as "there is
   a real bank here", because every BMS publishes it. */
await feed({'voltage':12.91});
await p.waitForTimeout(900); await paint();
f=await face();
t.ok(f.v==='12.91', 'a real voltage stands too', f.v);
t.ok(await p.evaluate(()=>CFG.windDemo),
     'and the demo is still ON - a BMS says the battery is real, not that '
     +'the boat is, so the invented wind is still blowing');
t.ok(await p.evaluate(()=>get('environment.wind.speedTrue')!==null),
     'which it is');
await p.evaluate(()=>demoSet(false));

await p.evaluate(()=>closeApp());
t.done(); await b.close();
