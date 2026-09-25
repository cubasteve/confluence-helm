/* The page in a pocket: the phone's own GPS as an instrument, the
   compass and heel it will publish once it is in a bracket, and the
   several things it deliberately never invents. */
import {open, tally, DEG} from './helpers.mjs';
const t=tally();
/* netd:false because there is no helper on a phone - nothing is
   listening on loopback, and the app has to be fine with that. */
const {b,p,ctx}=await open(t,{phone:true, netd:false,
  geo:{latitude:28.8190, longitude:-81.2650, accuracy:5}});

t.head('the overlays fit the glass they are drawn on');
const vp=await p.evaluate(()=>({
  layout:document.documentElement.clientWidth,
  meta:document.querySelector('meta[name=viewport]').content,
  face:$('stage').getBoundingClientRect().width,
  win:innerWidth}));
t.ok(/width=1080/.test(vp.meta), 'the page is authored at 1080 and says so', vp.meta);
t.ok(vp.layout===1080, 'so a 430 px phone lays out at 1080 and scales the lot',
     String(vp.layout));
await p.evaluate(()=>{ panel.classList.add('open'); });
await p.waitForTimeout(400);
const fits=await p.evaluate(()=>{ const r=$('panel').getBoundingClientRect();
  return {l:r.left, r:innerWidth-r.right, w:r.width}; });
t.ok(fits.l>=-1 && fits.r>=-1, 'and the panel sheet is inside the screen, not hanging off it',
     fits.l.toFixed(0)+' / '+fits.r.toFixed(0));
t.ok(await p.evaluate(()=>document.documentElement.scrollWidth
                        <=document.documentElement.clientWidth+1),
     'nothing pushes the page sideways');
await p.evaluate(()=>{ panel.classList.remove('open'); });

/* These buttons live on the panel, which slides. Playwright will not
   touch a moving target and the animation is not what is being tested,
   so the taps are dispatched rather than aimed. */
const tapBtn=id=>p.evaluate(i=>$(i).click(), id);

t.head('PHONE is off until it is asked for');
t.ok(await p.evaluate(()=>CFG.phoneGps===false), 'the setting starts off');
t.ok(await p.evaluate(()=>phoneWatch===null), 'and nothing is watching the GPS');
t.ok(!await p.evaluate(()=>$('phone-row').classList.contains('on')),
     'MOUNT is not even offered yet');

t.head('turning it on watches the phone and feeds the dial from it');
await tapBtn('phone-btn'); await p.waitForTimeout(1500);
t.ok(await p.evaluate(()=>CFG.phoneGps===true), 'the setting is on');
t.ok(await p.evaluate(()=>phoneWatch!==null), 'a watch is running');
t.ok(await p.evaluate(()=>$('phone-btn').getAttribute('aria-pressed'))==='true',
     'the button says so, out loud');
t.ok(await p.evaluate(()=>$('phone-row').classList.contains('on')), 'and MOUNT is offered');
const fix=await p.evaluate(()=>({la:get('pos.lat'), lo:get('pos.lon')}));
t.ok(Math.abs(fix.la-28.8190)<1e-6 && Math.abs(fix.lo+81.2650)<1e-6,
     'the real fix is on the dial', JSON.stringify(fix));
t.ok(await p.evaluate(()=>S['pos.lat'].src==='gps'), 'stamped as the phone\'s own');
t.ok(await p.evaluate(()=>JSON.parse(localStorage.getItem('helmPrefs')).phoneGps===true),
     'and it is remembered for next time');

t.head('and nothing else. a phone that invented a depth would be worse than none');
const invented=await p.evaluate(()=>['environment.wind.speedApparent',
  'environment.wind.angleApparent','environment.wind.speedTrue',
  'environment.wind.directionTrue','environment.depth.belowTransducer',
  'navigation.headingMagnetic','att.roll','att.pitch']
  .filter(k=>get(k)!==null));
t.ok(invented.length===0, 'no wind, no depth, no heading, no heel', invented.join(' '));
t.ok(await p.evaluate(()=>$('dpt').textContent)==='––',
     'the sounder reads nothing', await p.evaluate(()=>$('dpt').textContent));
t.ok(!await p.evaluate(()=>$('s-dpt').classList.contains('live')),
     'and says the sensor is not there');
t.ok(await p.evaluate(()=>!ALERTS.depth),
     'so the shallow alarm cannot fire on a number nobody measured');

t.head('speed and course: the device\'s own when it has them');
const own=await p.evaluate(()=>{ phoneLast=null;
  phoneFix({coords:{latitude:28.8190,longitude:-81.2650,speed:3.1,heading:41},
            timestamp:Date.now()});
  return {s:get('navigation.speedOverGround'), c:get('navigation.courseOverGroundTrue')}; });
t.ok(Math.abs(own.s-3.1)<1e-9, 'its Doppler speed, in metres a second', String(own.s));
t.ok(Math.abs(own.c*180/Math.PI-41)<1e-6, 'and its heading, stored in radians',
     String(own.c));

t.head('and worked out from two fixes when it has not, which is often');
const der=await p.evaluate(()=>{ const t0=Date.now();
  phoneLast=null; delete S['navigation.speedOverGround'];
  delete S['navigation.courseOverGroundTrue'];
  phoneFix({coords:{latitude:28.8190,longitude:-81.2650,speed:null,heading:null},
            timestamp:t0});
  /* 10 s north-east: 30.9 m north, 30.9 m east */
  phoneFix({coords:{latitude:28.8190+30.9/111320,
                    longitude:-81.2650+30.9/(111320*Math.cos(28.819/180*Math.PI)),
                    speed:null, heading:null}, timestamp:t0+10000});
  return {s:get('navigation.speedOverGround'),
          c:get('navigation.courseOverGroundTrue')*180/Math.PI}; });
t.ok(Math.abs(der.s-4.37)<0.1, 'the speed is the distance over the clock',
     der.s.toFixed(2));
t.ok(Math.abs(der.c-45)<1, 'and the course is the bearing between them', der.c.toFixed(1));

t.head('a fix that jumped is not a boat doing 190 knots');
const jump=await p.evaluate(()=>{ const t0=Date.now();
  phoneLast=null; delete S['navigation.speedOverGround'];
  phoneFix({coords:{latitude:28.8190,longitude:-81.2650,speed:null,heading:null},
            timestamp:t0});
  phoneFix({coords:{latitude:28.8600,longitude:-81.2650,speed:null,heading:null},
            timestamp:t0+2000});                  /* 4.5 km in 2 s */
  return {s:get('navigation.speedOverGround'), la:get('pos.lat')}; });
t.ok(jump.s===null, 'the pair is refused', String(jump.s));
t.ok(Math.abs(jump.la-28.8600)<1e-9, 'but the position is still good, and still used',
     String(jump.la));

t.head('and a boat drifting has no course worth printing');
const drift=await p.evaluate(()=>{ const t0=Date.now();
  phoneLast=null; delete S['navigation.courseOverGroundTrue'];
  phoneFix({coords:{latitude:28.8190,longitude:-81.2650,speed:null,heading:null},
            timestamp:t0});
  phoneFix({coords:{latitude:28.8190+0.2/111320,longitude:-81.2650,
                    speed:null,heading:null}, timestamp:t0+1000});  /* 0.2 m/s */
  return {s:get('navigation.speedOverGround'),
          c:get('navigation.courseOverGroundTrue')}; });
t.ok(drift.s!==null && drift.s<0.5, 'the speed is still reported', String(drift.s));
t.ok(drift.c===null, 'the course is not - that would be the GPS wandering',
     String(drift.c));

t.head('the boat wins. walk aboard and the phone stands itself down');
await p.evaluate(()=>{ feedPut('pos.lat', 28.90, 'sk'); feedPut('pos.lon', -81.30, 'sk');
  phoneLast=null;
  phoneFix({coords:{latitude:28.8190,longitude:-81.2650,speed:2,heading:90},
            timestamp:Date.now()}); });
let who=await p.evaluate(()=>({la:get('pos.lat'), src:S['pos.lat'].src}));
t.ok(Math.abs(who.la-28.90)<1e-9 && who.src==='sk',
     'Signal K publishes a fix and the phone leaves it alone', JSON.stringify(who));
await p.evaluate(()=>{ S['pos.lat'].t=Date.now()-CFG.staleAfter-1000;
  S['pos.lon'].t=Date.now()-CFG.staleAfter-1000; phoneLast=null;
  phoneFix({coords:{latitude:28.8190,longitude:-81.2650,speed:2,heading:90},
            timestamp:Date.now()}); });
who=await p.evaluate(()=>({la:get('pos.lat'), src:S['pos.lat'].src}));
t.ok(Math.abs(who.la-28.8190)<1e-6 && who.src==='gps',
     'and takes it back up if the boat goes quiet', JSON.stringify(who));

t.head('what it says when it cannot have a fix');
await p.evaluate(()=>{ phoneFail({code:1}); });
t.ok(/REFUSED/.test(await p.evaluate(()=>$('phone-why').textContent)),
     'refused is the end of it, and it says which button to press',
     await p.evaluate(()=>$('phone-why').textContent));
t.ok(await p.evaluate(()=>$('phone-btn').classList.contains('bad')),
     'and the button shows it');
await p.evaluate(()=>{ phoneFail({code:3}); });
t.ok(/LOOKING FOR A FIX/.test(await p.evaluate(()=>$('phone-why').textContent)),
     'a timeout is not - it keeps trying, and says that instead');
await p.evaluate(()=>{ phoneFix({coords:{latitude:28.819,longitude:-81.265},
                                 timestamp:Date.now()}); });
t.ok(await p.evaluate(()=>$('phone-why').textContent)==='',
     'and the next fix clears it');

t.head('MOUNT is an assertion, and until it is made nothing is published');
await p.evaluate(()=>{ dispatchEvent(new Event('deviceorientationabsolute')); });
t.ok(await p.evaluate(()=>get('navigation.headingMagnetic')===null),
     'an orientation event with MOUNT off writes nothing');
/* A real DeviceOrientationEvent cannot be constructed with these
   fields in Chromium, and `type` is read only on an Event - so the
   handler is handed a plain object with the same shape, which is all
   it ever reads. */
const ev=(o)=>p.evaluate(o=>mountEvent(Object.assign(
  {type:'deviceorientationabsolute', absolute:true}, o)), o);
await tapBtn('mount-btn'); await p.waitForTimeout(300);
t.ok(await p.evaluate(()=>mountOn===true), 'tapping it says the phone is in its bracket');
t.ok(/LEVELLING/.test(await p.evaluate(()=>$('phone-why').textContent)),
     'and that the tap is what captures level',
     await p.evaluate(()=>$('phone-why').textContent));

t.head('the first reading after the tap is what level means');
await ev({alpha:90, beta:6, gamma:-4});
let att=await p.evaluate(()=>({r:get('att.roll')*180/Math.PI,
                               p:get('att.pitch')*180/Math.PI,
                               h:get('navigation.headingMagnetic')*180/Math.PI}));
t.ok(Math.abs(att.r)<1e-9 && Math.abs(att.p)<1e-9,
     'however it happens to sit, that is upright', att.r+' / '+att.p);
t.ok(Math.abs(att.h-270)<1e-6, "Android's alpha counts the other way round",
     att.h.toFixed(1));
await ev({alpha:90, beta:6, gamma:6});
att=await p.evaluate(()=>({r:get('att.roll')*180/Math.PI,
                           p:get('att.pitch')*180/Math.PI}));
t.ok(Math.abs(att.r-10)<1e-6, 'and everything after is measured from it',
     att.r.toFixed(1));
t.ok(await p.evaluate(()=>$('phone-why').textContent)==='',
     'the levelling line clears once it is level');
await ev({alpha:90, beta:16, gamma:6});
t.ok(Math.abs(await p.evaluate(()=>get('att.pitch')*180/Math.PI)-10)<1e-6,
     'bow up is positive pitch, as Signal K has it');

t.head('an iPhone says it a different way, and is believed over the other event');
await p.evaluate(()=>{ mountStop(); mountStart(); }); await p.waitForTimeout(200);
await ev({type:'deviceorientation', webkitCompassHeading:117, beta:0, gamma:0});
t.ok(Math.abs(await p.evaluate(()=>get('navigation.headingMagnetic')*180/Math.PI)-117)<1e-6,
     'webkitCompassHeading is degrees from north already');
await ev({type:'deviceorientation', absolute:false, alpha:10, beta:0, gamma:0});
t.ok(Math.abs(await p.evaluate(()=>get('navigation.headingMagnetic')*180/Math.PI)-117)<1e-6,
     'and a relative event does not get to overwrite it');

t.head('a phone turned in its bracket is still measuring the boat');
await p.evaluate(()=>{ mountStop(); mountStart();
  Object.defineProperty(screen,'orientation',{configurable:true,
    get:()=>({angle:90})}); }); await p.waitForTimeout(200);
await ev({alpha:0, beta:0, gamma:0});
await ev({alpha:0, beta:-10, gamma:4});
const land=await p.evaluate(()=>({r:get('att.roll')*180/Math.PI,
                                  p:get('att.pitch')*180/Math.PI}));
t.ok(Math.abs(land.r-10)<1e-6, 'landscape swaps beta and gamma, and the screen says so',
     land.r.toFixed(1));
t.ok(Math.abs(land.p-4)<1e-6, 'both of them', land.p.toFixed(1));
await p.evaluate(()=>Object.defineProperty(screen,'orientation',{configurable:true,
  get:()=>({angle:0})}));

t.head('and both of them go quiet when they should');
await p.evaluate(()=>mountStop()); await p.waitForTimeout(200);
t.ok(await p.evaluate(()=>['navigation.headingMagnetic','att.roll','att.pitch']
       .every(k=>get(k)===null)), 'MOUNT off drops the heading and the heel');
t.ok(await p.evaluate(()=>get('pos.lat')!==null), 'and leaves the GPS alone');
t.ok(!await p.evaluate(()=>JSON.parse(localStorage.getItem('helmPrefs')).mount),
     'whether it is in a bracket is not a setting, and is not remembered');
await tapBtn('phone-btn'); await p.waitForTimeout(400);
t.ok(await p.evaluate(()=>['pos.lat','pos.lon','navigation.speedOverGround',
       'navigation.courseOverGroundTrue'].every(k=>get(k)===null)),
     'PHONE off drops everything it was feeding');
t.ok(await p.evaluate(()=>phoneWatch===null && phoneLast===null),
     'and stops watching');

t.head('PHONE and the demo are not both the boat');
await p.evaluate(()=>demoSet(true)); await p.waitForTimeout(400);
await tapBtn('phone-btn'); await p.waitForTimeout(400);
t.ok(await p.evaluate(()=>CFG.demo===false && CFG.phoneGps===true),
     'turning one on turns the other off');

await t.done(b);
