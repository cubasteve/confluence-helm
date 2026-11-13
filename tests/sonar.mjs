/* The echogram.

   There is no transducer anywhere near the machine that runs this, so
   netd is a stub and the pings are made up - which is the right shape
   for the probe anyway, because every interesting thing this app does
   is arithmetic over bytes it was handed. tests/sonar_test.py holds
   the other half: the frames, the checksum and the ring.

   The three that would be quietly wrong on the water and silent here
   without a probe:

     * the GAIN skips the transmit pulse. The first slice of every
       column saturates the receiver and reads 255 whatever the water
       is doing, so a peak taken over the whole column is pinned at 255
       for ever and a real bottom at 60 renders almost black
     * the picture is anchored at the RIGHT, because now is at the
       right and a minute of history grows back from it
     * NIGHT is a red ramp. The night theme exists to keep your eyes
       adapted and a yellow bottom return at 2 a.m. undoes that       */
import {open, tally} from './helpers.mjs';
const t=tally();

/* What the stub will answer with next. */
let NEXT={ok:true, on:true, seq:0, bins:256, mps:0.0099, age:0,
          good:0, bad:0, error:'', pings:[]};
const asked=[];

/* A ping: 256 bins, `fill` everywhere, then whatever `at` overrides. */
function ping(n, fill, at={}, idx=0){
  const b=Buffer.alloc(256, fill);
  for(const k in at) b[k]=at[k];
  return {n, t:Date.now(), idx, ns:256, temp:18.5,
          b:b.toString('base64')};
}
/* A run of pings ending at `n`, all the same. */
const many=(n,fill,at,idx)=>[...Array(n).keys()].map(i=>ping(i+1,fill,at,idx));

const {b,p}=await open(t,{reply:{'/sonar': async body=>{
  asked.push(body);
  return Object.assign({}, NEXT,
    {pings:(NEXT.pings||[]).filter(x=>x.n>(body.after||0))});
}}});

/* The rectangle the picture lives in, read off the app rather than
   written down twice. */
const R=await p.evaluate(()=>SNR.RECT);
/* One pixel of the glass. `bin` is a row of the 256, `from` how far in
   from the right edge in columns of 600. */
const px=(bin, from=2)=>p.evaluate(([R,bin,from])=>{
  const c=document.getElementById('snr-cv').getContext('2d');
  const x=Math.round(R.x+R.w-1-from*R.w/600);
  const y=Math.round(R.y+(bin+0.5)*R.h/256);
  const d=c.getImageData(x,y,1,1).data;
  return [d[0],d[1],d[2]];
}, [R,bin,from]);
const lum=c=>0.3*c[0]+0.6*c[1]+0.1*c[2];
const open_=()=>p.evaluate(()=>openApp(APPS.find(a=>a.id==='sonar')));
const msg=()=>p.evaluate(()=>{ const m=document.getElementById('snr-msg');
  return m && m.classList.contains('on') ? m.textContent : ''; });
const feed=async o=>{ Object.assign(NEXT,o); await p.waitForTimeout(700); };

t.head('the app is on the dock and comes up');
t.ok(await p.evaluate(()=>APPS.some(a=>a.id==='sonar')), 'there is a sonar app');
t.ok(await p.evaluate(()=>{
       const a=APPS.find(x=>x.id==='sonar');
       return (a.ico.match(/<path /g)||[]).length===4; }),
     'a hull, two sides of a cone and a seabed');
await open_(); await p.waitForTimeout(400);
t.ok(await p.evaluate(()=>!!document.getElementById('snr-cv')), 'it builds a canvas');
t.ok(await p.evaluate(()=>APP.on&&APP.on.id==='sonar'), 'and the drawer knows it is open');

t.head('it asks only for what it has not seen');
/* Six hundred pings a minute, and the app holds all of them. Asking
   from zero every time would be two hundred kilobytes of JSON twice a
   second for one new column. */
await feed({seq:0, pings:[]});
t.ok(asked.length>0 && asked[0].after===0,
     'the first ask starts at the beginning, so the history arrives with it',
     JSON.stringify(asked[0]));
await feed({seq:12, pings:many(12, 8)});
const a2=asked[asked.length-1];
t.ok(a2.after===12, 'and the next one carries the sequence it already holds',
     JSON.stringify(a2));

t.head('the water is drawn, and the right way up');
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
NEXT.seq=0; NEXT.pings=[];
await open_(); await p.waitForTimeout(300);
/* Quiet water with one band in it, two thirds of the way down. */
await feed({seq:30, pings:many(30, 8, {170:200, 171:210, 172:200})});
const band=await px(171), above=await px(60), below=await px(240);
t.ok(lum(band)>lum(above)+40 && lum(band)>lum(below)+40,
     'the echo is the brightest thing in the column',
     JSON.stringify([above,band,below]));

t.head('the gain leaves the transmit pulse out of it');
/* The one that fails silently on the water. Every column opens with
   the receiver still ringing from the ping it just sent, reading near
   full scale whatever is underneath. Take the peak over the whole
   column and it is pinned at 255 for ever, so a real bottom return at
   60 comes back at a quarter of the ramp: a picture of empty water
   over a bottom that is plainly there.

   HOW LONG it rings belongs to the board and the transducer, which is
   why the app measures it instead of assuming a fraction. Both
   failures of a fixed fraction are below: one too short, one too
   long. */
const pulse=async (len, name, at=171)=>{
  await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
  NEXT.seq=0; NEXT.pings=[];
  await open_(); await p.waitForTimeout(300);
  const blast={}; for(let i=0;i<len;i++) blast[i]=255;
  blast[at]=60; blast[at+1]=60;
  await feed({seq:20, pings:many(20, 6, blast)});
  return [await px(at), await px(5)];
};
/* A long ring-down, which is what pins a fixed 5%. */
let [bot,top2]=await pulse(40,'long');
t.ok(lum(bot)>150,
     'a bottom at a quarter of full scale still reads as a bottom under a '
     +'ring-down eight times longer than a fixed guess would allow',
     JSON.stringify(bot)+' lum '+Math.round(lum(bot)));
t.ok(lum(top2)>150, 'and the pulse itself is still drawn, because a board '
     +'that has stopped pinging should not look like deep water');
/* And a short one, which is what a generous fixed fraction would eat:
   the echo here is well inside the band a 12% guess would discard. */
[bot]=await pulse(3,'short',22);
t.ok(lum(bot)>150, 'a shallow return survives a board that barely rings at '
     +'all - which a fraction set wide enough for the long case would have '
     +'swallowed', JSON.stringify(bot)+' lum '+Math.round(lum(bot)));

t.head('now is at the right edge');
/* A picture that filled from the left would put the newest ping where
   your eye goes last, and would shunt the whole minute sideways as it
   filled. */
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
NEXT.seq=0; NEXT.pings=[];
await open_(); await p.waitForTimeout(300);
/* Five bright columns and a band of rows, not one of each. Twenty
   pings fill 26 px of a 780 px rectangle, so a single column is 1.3 px
   and the picture is drawn with smoothing on - reading one blurred
   pixel put this 32 above its neighbour against a threshold of 40, so
   it passed alone and failed in the suite. A probe that depends on
   where the rounding lands is worse than no probe: it teaches you to
   re-run rather than to look. */
const run=many(20, 8);
for(let i=15;i<20;i++)
  run[i]=ping(i+1, 8, {118:240,119:240,120:240,121:240,122:240,123:240});
await feed({seq:20, pings:run});
const edge=await px(120, 2), back=await px(120, 15);
t.ok(lum(edge) > lum(back)+40,
     'the newest pings are at the right-hand edge, not the left',
     JSON.stringify([edge, back])
     +'  lum '+Math.round(lum(edge))+' vs '+Math.round(lum(back)));

t.head("and the firmware's own bottom pick rides on top of it");
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
NEXT.seq=0; NEXT.pings=[];
await open_(); await p.waitForTimeout(300);
/* A QUARTER of the way down, and not half. Half is the one row an
   upside-down picture draws in exactly the same place, so a probe
   that sits there cannot tell the two apart - which is how this one
   first passed against a deliberately inverted pick. */
await feed({seq:20, pings:many(20, 8, {}, 64)});
const pick=await px(64), water=await px(120);
t.ok(pick[0]>200 && pick[1]>200 && pick[2]>200,
     'the pick is drawn where the board said the bottom was',
     JSON.stringify(pick));
t.ok(lum(pick)>lum(water)+60, 'and stands off the water around it',
     JSON.stringify([water,pick]));
/* A board that has not found a bottom reports zero, and a line drawn
   there is a confident bottom along the surface. */
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
NEXT.seq=0; NEXT.pings=[];
await open_(); await p.waitForTimeout(300);
await feed({seq:20, pings:many(20, 8, {}, 0)});
const top=await px(0);
t.ok(!(top[0]>200 && top[1]>200 && top[2]>200),
     'no lock means no line, rather than a line along the surface',
     JSON.stringify(top));

t.head('night is a red ramp, and it repaints what is already drawn');
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
NEXT.seq=0; NEXT.pings=[];
await open_(); await p.waitForTimeout(300);
await feed({seq:20, pings:many(20, 8, {170:200, 171:210})});
const dayb=await px(171,10);
t.ok(!(dayb[0]>dayb[1]+40),
     'by day the echo is at the warm end of a full-colour ramp',
     JSON.stringify(dayb));
/* Without closing it. The theme changes under an open app by itself
   on `auto`, at sunset, which is the one moment the red ramp exists
   for - and a minute of daylight colours scrolling off afterwards is
   exactly the harm it is meant to prevent. */
await p.evaluate(()=>{ CFG.theme='night'; applyTheme(); });
await p.waitForTimeout(800);
const nb=await px(171,10);
t.ok(nb[0]>nb[1]+40 && nb[0]>nb[2]+40,
     'and water already on the glass turns red with the theme, rather than '
     +'scrolling daylight off for the next minute', JSON.stringify(nb));
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); });
await p.waitForTimeout(600);
t.ok((await px(171,10))[1]>nb[1]+40, 'and back again', JSON.stringify(await px(171,10)));

t.head('the range follows the unit the rest of the panel is in');
/* 256 samples at 0.0099 m is 2.53 m, which is 8 ft. The arithmetic is
   netd's scale and the panel's own conversion, and this is the only
   place either of them is visible as a number. */
await p.evaluate(()=>{ CFG.depthUnit='ft'; }); await p.waitForTimeout(400);
const sub=()=>p.evaluate(()=>document.getElementById('snr-sub').textContent);
t.ok(/RANGE 8 FT/.test(await sub()), 'feet', await sub());
await p.evaluate(()=>{ CFG.depthUnit='m'; }); await p.waitForTimeout(500);
t.ok(/RANGE 3 M/.test(await sub()), 'and metres', await sub());
await p.evaluate(()=>{ CFG.depthUnit='ft'; }); await p.waitForTimeout(400);

t.head('the big number is the dial\'s number, not one worked out here');
/* The whole reason netd serves a picture and not a depth. netd HAS
   everything it needs to compute one - the bottom pick, the sample
   rate, the speed of sound - and deliberately does not, because two
   depths off one transducer by two routes would disagree by a few
   centimetres with nothing to say which of them the shallow alarm
   meant. So this has to be the same number the dial shows, to the
   digit it is printed at. A conversion done twice is how it stops
   being. */
const both=await p.evaluate(()=>({app:$('snr-dv').textContent,
                                  unit:$('snr-u').textContent,
                                  dial:$('dpt').textContent}));
t.ok(Math.abs(parseFloat(both.app)-parseFloat(both.dial))<0.2,
     'the echogram and the dial read the same water', JSON.stringify(both));
t.ok(both.unit==='FT', 'in the unit the panel is set to', JSON.stringify(both));
/* And keel before transducer, the way the dial reads it: a boat that
   publishes both wants the one that says how much water is under the
   KEEL, which is the number you run aground on. */
await p.evaluate(()=>{ S['environment.depth.belowKeel']={v:1.5,t:Date.now()}; });
await p.waitForTimeout(400);
t.ok(Math.abs(parseFloat(await p.$eval('#snr-dv',e=>e.textContent))-4.9)<0.15,
     'with the keel winning when a boat publishes both, as the dial has it',
     await p.$eval('#snr-dv',e=>e.textContent));
await p.evaluate(()=>{ delete S['environment.depth.belowKeel']; });

t.head('and the four ways it can have nothing to show');
/* Four, and not one, because "a dark screen" has four different cures
   and only one of them can be applied from the cockpit. */
await feed({ok:true, on:false, seq:0, pings:[]});
t.ok(/NO SOUNDER/.test(await msg()), 'HELM_SONAR is not set', await msg());
await feed({ok:true, on:true, seq:0, pings:[], error:'stty: no such device'});
t.ok(/SOUNDER ERROR/.test(await msg()) && /stty/.test(await msg()),
     'the board is configured and netd cannot open it', await msg());
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
NEXT.seq=0; NEXT.pings=[]; NEXT.error='';
await open_(); await p.waitForTimeout(800);
t.ok(/WAITING FOR THE BOARD/.test(await msg()),
     'configured, open, and nothing has arrived yet', await msg());
await feed({seq:20, pings:many(20, 8), age:14});
t.ok(/SILENT FOR 14 S/.test(await msg()),
     'it was pinging and has stopped - which a frozen picture would not say',
     await msg());
await feed({age:0});
t.ok((await msg())==='', 'and water showing says nothing at all', await msg());

t.head('and rubbish on the wire costs one ping, not the round');
/* Decoding happens inside the poll, so a payload that throws takes
   every ping BEHIND it in the same answer down with it - which turns
   one bad frame into a picture that stops. */
await p.evaluate(()=>closeApp()); await p.waitForTimeout(250);
NEXT.seq=0; NEXT.pings=[]; NEXT.age=0;
await open_(); await p.waitForTimeout(300);
const mixed=many(10, 8, {170:200, 171:210});
mixed[4]={n:5, t:Date.now(), idx:0, ns:256, temp:18, b:'not base64 at all!!'};
await feed({seq:10, pings:mixed});
const kept=await p.evaluate(()=>SNRS.raw.length);
t.ok(kept===9, 'the bad one is dropped and the other nine are drawn',
     kept+' of 9');

t.head('closing it gives the pixels back');
/* Six hundred columns of two hundred and fifty-six, which a canvas
   holds on to until its dimensions are set to zero however detached
   it is. The offscreen is the one nothing else has a handle on. */
const held=await p.evaluate(()=>{
  window.__keep={cv:SNRS.cv, off:SNRS.off};
  window.__raw=SNRS.raw;
  return {cv:SNRS.cv.width, off:SNRS.off.width, rows:SNRS.rows,
          raw:SNRS.raw.length}; });
t.ok(held.cv===1080 && held.off===600 && held.rows===256,
     'both canvases are real while it is open', JSON.stringify(held));
t.ok(held.raw>0, 'and the columns behind them are kept', JSON.stringify(held));
await p.evaluate(()=>closeApp()); await p.waitForTimeout(300);
const gone=await p.evaluate(()=>({cv:__keep.cv.width, off:__keep.off.width,
                                  raw:__raw.length,
                                  state:typeof SNRS, live:SNRS===null}));
t.ok(gone.cv===0 && gone.off===0 && gone.raw===0,
     'and all three are zero after it closes', JSON.stringify(gone));
t.ok(gone.live, 'with nothing left holding them');
t.ok(!(await p.evaluate(()=>!!document.getElementById('snr-cv'))),
     'and the canvas is out of the document');

t.head('and it stops asking - and stops its clocks');
const n0=asked.length;
await p.waitForTimeout(1200);
t.ok(asked.length===n0, 'a closed app polls nobody',
     n0+' -> '+asked.length);
/* That one passes on the guard at the top of sPoll alone, which is
   why it is not the whole story: with the interval left running, the
   app asks nobody and ALSO leaves a timer behind on every open. So
   count them. Everything setInterval hands out while the app is
   opening has to come back when it closes. */
const iv=await p.evaluate(async ()=>{
  const si=window.setInterval, ci=window.clearInterval;
  const live=new Set(); let made=0;
  window.setInterval=function(){ const id=si.apply(window,arguments);
    made++; live.add(id); return id; };
  window.clearInterval=function(id){ live.delete(id); return ci.call(window,id); };
  try{
    openApp(APPS.find(a=>a.id==='sonar'));
    await new Promise(r=>setTimeout(r,500));
    closeApp();
    await new Promise(r=>setTimeout(r,200));
    return {made:made, left:live.size};
  } finally { window.setInterval=si; window.clearInterval=ci; }
});
t.ok(iv.made>=2, 'the app runs on two clocks - the poll and the depth',
     JSON.stringify(iv));
t.ok(iv.left===0, 'and closing it gives both of them back',
     JSON.stringify(iv));

await t.done(b);
