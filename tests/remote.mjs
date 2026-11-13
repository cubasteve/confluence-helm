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

t.head('the face is measured off the glass, not written down twice');
/* The whole contract. A table of coordinates in the panel - or worse,
   in netd.py - is a table that drifts the first time a cell moves, and
   it drifts SILENTLY: the phone goes on drawing a face that is no
   longer this one and puts your thumb on the wrong reading. */
const live=await p.evaluate(()=>{
  const at=(e,n)=>+e.getAttribute(n), o={box:{}, a:{}, cut:[]};
  document.querySelectorAll('#dial-cells .dcell').forEach(r=>{
    o.box[r.dataset.slot]=[at(r,'x'),at(r,'y'),at(r,'width'),at(r,'height')]; });
  for(const sl in DIAL_EL){ const e=DIAL_EL[sl], v=$(e[e.length===1?0:1]);
    if(v) o.a[sl]=[at(v,'x'), at(v,'y')]; }
  document.querySelectorAll('#svg .cut').forEach(l=>
    o.cut.push([at(l,'x1'),at(l,'y1'),at(l,'x2'),at(l,'y2')]));
  return o;
});
t.ok(JSON.stringify(cat.geom.dial.box)===JSON.stringify(live.box),
     'every dial box IS the rect the glass taps', JSON.stringify(cat.geom.dial.box));
t.ok(JSON.stringify(cat.geom.dial.cut)===JSON.stringify(live.cut),
     'and the four rules are the glass\'s own, because they frame the boxes',
     JSON.stringify(cat.geom.dial.cut));

t.head("the anchor is where the glass prints the value, not the middle of the box");
/* c0's rect runs 270..890 and centres at 580. #spd is authored at 540,
   in line with the strip and the middle cell. Centring the word in the
   box puts it thirteen pixels off the line the whole face hangs from -
   and it is only visible on c0, because for c1, c2 and c3 the anchor IS
   the box centre. That is the shape of the mistake. */
t.ok(JSON.stringify(cat.geom.dial.a)===JSON.stringify(live.a),
     'every anchor is the value element\'s own x and y', JSON.stringify(cat.geom.dial.a));
t.ok(cat.geom.dial.a.c0[0]===540 && cat.geom.dial.box.c0[0]+cat.geom.dial.box.c0[2]/2===580,
     'and on the big number those two are forty units apart',
     JSON.stringify([cat.geom.dial.a.c0, cat.geom.dial.box.c0]));

t.head('the music page is measured even though its cells may not exist');
/* paintStrip emits nothing for a reading with no value and its one
   caller returns unless that page is open, so on a panel that booted on
   the dial there is nothing in #ms-strip at all. The throwaways have to
   agree with the cells the page really builds. */
await p.evaluate(()=>goPage(2)); await p.waitForTimeout(600);
const musLive=await p.evaluate(()=>{
  const pg=$('music').getBoundingClientRect(), k=pg.width?1080/pg.width:1, o={};
  document.querySelectorAll('#ms-strip .mcell[data-slot]').forEach(e=>{
    const r=e.getBoundingClientRect();
    o[e.dataset.slot]=[Math.round((r.left-pg.left)*k), Math.round((r.top-pg.top)*k),
                       Math.round(r.width*k), Math.round(r.height*k)]; });
  return o;
});
t.ok(Object.keys(musLive).length===3, 'the page really has three cells to compare with',
     JSON.stringify(musLive));
t.ok(JSON.stringify(cat.geom.mus.box)===JSON.stringify(musLive),
     'and the throwaways measured every one of them exactly',
     JSON.stringify(cat.geom.mus.box)+' vs '+JSON.stringify(musLive));
t.ok(cat.geom.mus.art && cat.geom.mus.art[2]>0,
     'the album art is measured too, so no coordinate lives on the phone',
     JSON.stringify(cat.geom.mus.art));
/* The case the throwaways EXIST for, which is the one the panel is
   normally in: booted on the dial, music page never opened, #ms-strip
   an empty string. Measuring with the real cells already there proves
   nothing about them - `made` is empty and no throwaway is created. */
const cold=await p.evaluate(()=>{
  const box=$('ms-strip'); box.innerHTML='';
  const g=remoteGeom();
  return {box:g.mus.box, art:g.mus.art,
          after:box.querySelectorAll('.mcell').length};
});
t.ok(JSON.stringify(cold.box)===JSON.stringify(musLive),
     'with the strip empty the throwaways measure the same boxes',
     JSON.stringify(cold.box));
t.ok(cold.after===0,
     'and leave nothing behind - a span left on the glass is a cell with '
     +'no reading in it', String(cold.after));
await p.evaluate(()=>{ stripKey=''; paintStrip(); });
await p.evaluate(()=>goPage(1)); await p.waitForTimeout(400);

t.head('and the measurement holds at a window that is not 1080 wide');
/* It cannot, and the first two attempts at this both shipped numbers
   that were wrong by the ratio. #stage is 100vmin with no transform,
   so a smaller window scales the SVG with its viewBox and leaves this
   overlay alone - the flanks hold their authored 116px while the apex,
   at left:50%, moves. They only compose into the drawn layout at 1080.
   So the answer is to send nothing rather than something crooked. */
await p.setViewportSize({width:720, height:720});
await p.waitForTimeout(500);
const small=await p.evaluate(()=>remoteGeom().mus);
t.ok(!Object.keys(small.box).length,
     'no music boxes at all rather than ones that are quietly wrong',
     JSON.stringify(small.box));
t.ok(!small.art, 'and no album art either', JSON.stringify(small.art));
/* The dial is SVG with a viewBox, so its numbers are authored and the
   window cannot touch them. It keeps working. */
const smallD=await p.evaluate(()=>remoteGeom().dial);
t.ok(JSON.stringify(smallD.box)===JSON.stringify(live.box),
     'while the dial, being authored in a viewBox, is unaffected',
     JSON.stringify(smallD.box));
await p.setViewportSize({width:1080, height:1080});
await p.waitForTimeout(500);

t.head('the tags are the glass\'s words, and they do not move');
t.ok(cat.tags.sog==='SOG' && cat.tags.tws==='TWS',
     'a reading with a plain header gets that header', JSON.stringify(cat.tags.sog));
t.ok(cat.tags.mkb==='NEXT MARK' && cat.tags.wa==='WIND ANGLE · AUTO',
     'and one whose header is a function of live state falls back to its name',
     JSON.stringify([cat.tags.mkb, cat.tags.wa]));
/* The four live-header readings are the whole reason for the typeof
   test: markGeo's header is the NEXT MARK'S NAME, and sending it would
   put a reading on a wire that carries none. */
const before2=JSON.stringify(cat.tags);
await p.evaluate(()=>{ COURSE.marks=['cb8','rum']; COURSE.next=0;
                       try{ renderCourse(); }catch(e){} });
await p.waitForTimeout(400);
const after2=await p.evaluate(()=>JSON.stringify(remoteCat().tags));
t.ok(after2===before2, 'so setting a course changes not one of them');
t.ok(!/CB 8/.test(after2), 'and no mark name reaches the wire', after2.slice(0,80));

t.head('the instrument headings come from the panel too');
const sens=await p.evaluate(()=>JSON.stringify(SENSORS.reduce((o,p)=>(o[p[0]]=p[1],o),{})));
t.ok(JSON.stringify(cat.sens)===sens,
     'netd no longer keeps its own copy of them to drift', JSON.stringify(cat.sens));

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

t.head('the start clock crosses, as a figure rather than a picture');
/* The one reading that goes to the phone, and the exception is
   deliberate: it is a control you are holding, wanted exactly when you
   are on the rail with both hands full. It crosses as milliseconds and
   a state, never as the rendered string - a poll every second and a
   half would otherwise read a second and a half wrong most of the
   time. */
let tm=await p.evaluate(()=>remoteNow().t);
t.ok(tm && typeof tm.ms==='number' && tm.st==='idle',
     'idle, it is the figure the glass is showing', JSON.stringify(tm));
t.ok(tm.ms===await p.evaluate(()=>tLeft), 'which is the panel\'s own tLeft',
     tm.ms+' vs '+await p.evaluate(()=>tLeft));
/* Remaining, not an absolute end time. This Pi has no clock of its own:
   it starts at the epoch and jumps when NTP lands, so the two machines
   cannot be assumed to agree about what time it is - only about how
   long is left. */
await p.evaluate(()=>{ tState='countdown'; tEnd=rnow()+90000; });
tm=await p.evaluate(()=>remoteNow().t);
t.ok(tm.st==='countdown' && Math.abs(tm.ms-90000)<1500,
     'counting down, it is what is LEFT and not when it ends',
     JSON.stringify(tm));
await p.evaluate(()=>{ tState='racing'; tGun=rnow()-45000; });
tm=await p.evaluate(()=>remoteNow().t);
t.ok(tm.st==='racing' && Math.abs(tm.ms-45000)<1500,
     'and racing it is time SINCE the gun, which counts up',
     JSON.stringify(tm));
await p.evaluate(()=>{ tState='idle'; });

t.head('and the phone is told where the glass draws it');
/* Measured off the markup like every other complication, because the
   phone draws it where the glass has it and keeps its lanes clear of
   it - neither of which it can do if it is guessing. */
const tg=await p.evaluate(()=>remoteCat().geom.dial);
const tlive=await p.evaluate(()=>{
  const k=1080/document.getElementById('stage').getBoundingClientRect().width;
  const b=document.getElementById('t-plus').querySelector('circle')
            .getBoundingClientRect();
  const st=document.getElementById('stage').getBoundingClientRect();
  return {cx:((b.left+b.right)/2-st.left)*k, cy:((b.top+b.bottom)/2-st.top)*k};
});
t.ok(tg.tmr && tg.tmr.length===2, 'the numerals have an anchor',
     JSON.stringify(tg.tmr));
t.ok(Math.abs(tg.btn.up[0]-tlive.cx)<2 && Math.abs(tg.btn.up[1]-tlive.cy)<2,
     'and the + is where the browser has really put it',
     JSON.stringify(tg.btn.up)+' vs '+JSON.stringify(tlive));
t.ok(tg.btn.up[0]!==tg.btn.dn[0] || tg.btn.up[1]!==tg.btn.dn[1],
     'and the minus is somewhere else, rather than the same circle twice',
     JSON.stringify([tg.btn.up, tg.btn.dn]));

t.head('a nudge from the phone moves the clock the glass is showing');
await p.evaluate(()=>{ tState='idle'; tLeft=300000; });
await p.evaluate(()=>remoteDo({kind:'timer',by:60}));
t.ok((await p.evaluate(()=>tLeft))===360000, 'a minute on',
     String(await p.evaluate(()=>tLeft)));
await p.evaluate(()=>remoteDo({kind:'timer',by:-60}));
t.ok((await p.evaluate(()=>tLeft))===300000, 'and a minute off again',
     String(await p.evaluate(()=>tLeft)));
/* The glass dims its own two buttons the moment the gun goes, and this
   is the same rule: a nudge to a race that has started is not a nudge,
   it is a different race. */
await p.evaluate(()=>{ tState='racing'; tGun=rnow()-10000; });
await p.evaluate(()=>remoteDo({kind:'timer',by:60}));
t.ok((await p.evaluate(()=>tLeft))===300000,
     'and once the gun has gone it is refused',
     String(await p.evaluate(()=>tLeft)));
await p.evaluate(()=>{ tState='idle'; });
/* A minute is what the glass's buttons do. Anything else arriving here
   is not a phone this panel knows about. */
/* A whole minute is what the glass's buttons do - but netd adds up the
   taps it has not handed over yet, so what arrives is a TOTAL, up to
   the hour it clamps at. Anything that is not a whole number of
   minutes within that is not a phone this panel knows about. */
await p.evaluate(()=>remoteDo({kind:'timer',by:3600}));
t.ok((await p.evaluate(()=>tLeft))===3900000,
     'a whole hour of accumulated taps is still a legal total',
     String(await p.evaluate(()=>tLeft)));
await p.evaluate(()=>{ tLeft=300000; });
await p.evaluate(()=>{ remoteDo({kind:'timer',by:30});
                       remoteDo({kind:'timer',by:3660});
                       remoteDo({kind:'timer',by:'60'});
                       remoteDo({kind:'timer',by:NaN});
                       remoteDo({kind:'timer'}); });
t.ok((await p.evaluate(()=>tLeft))===300000,
     'and a part minute, an over-long one, a string or nothing is not done',
     String(await p.evaluate(()=>tLeft)));

t.head('the power sheet that crosses is the glass\'s own');
/* netd keeps no list of these and the phone keeps no list of these:
   netd decides which are AVAILABLE and the phone draws what it is
   handed. The thing a third copy would drift about is which button
   shuts the boat down, so this is asserted against POWER_ACTIONS
   itself rather than against a list written out here. */
const pwr=await p.evaluate(()=>({
  sent:remoteCat().power,
  real:POWER_ACTIONS.map(a=>({a:a.a, name:a.name, danger:a.danger?1:0,
                              need:a.need||''}))}));
t.ok(pwr.sent.length===pwr.real.length,
     'every action on it goes over, and no others',
     pwr.sent.length+' vs '+pwr.real.length);
t.ok(pwr.sent.map(x=>x.a).join()===pwr.real.map(x=>x.a).join(),
     'in the glass\'s own order - least destructive first, because the '
     +'top of a list is where a hurried finger lands',
     pwr.sent.map(x=>x.a).join());
t.ok(pwr.sent.every((x,i)=>x.name===pwr.real[i].name
                        && x.danger===pwr.real[i].danger
                        && x.need===pwr.real[i].need),
     'with its own words, its own danger flag and its own condition',
     JSON.stringify(pwr.sent.filter((x,i)=>x.name!==pwr.real[i].name)));
t.ok(pwr.sent.filter(x=>x.danger).map(x=>x.a).join()==='reboot,poweroff',
     'and the two that are dangerous are the two that take the boat down',
     pwr.sent.filter(x=>x.danger).map(x=>x.a).join());
/* No glyphs. An icon has to be injected as markup to be an icon, and
   the one field on this wire that must be markup is not going to be
   the one next to SHUT DOWN. */
t.ok(pwr.sent.every(x=>!('ico' in x)),
     'no markup crosses with them - the phone keeps its own glyphs',
     JSON.stringify(Object.keys(pwr.sent[0])));

t.head('and a reload is the only one the panel is asked to do itself');
/* Everything else netd runs. The reason you reach for the phone's
   power sheet is usually that the glass has stopped answering, and a
   command the panel has to collect is a command that never arrives
   exactly then. */
await p.evaluate(()=>{ window.__alive='yes'; });
await p.evaluate(()=>{
  for(const a of ['reboot','poweroff','desktop','cage','helper','',null])
    remoteDo({kind:'power', action:a});
});
await p.waitForTimeout(400);
t.ok((await p.evaluate(()=>window.__alive))==='yes',
     'and none of the others reloads the glass on its way past',
     String(await p.evaluate(()=>window.__alive)));
/* That a reload really does reload is asserted at the very end of this
   file, because it throws away everything the sections below set up -
   which is the point of it. */

t.head('the clock\'s three gestures mean what the glass says they mean');
/* The phone sends the GESTURE, never the transition: its idea of
   tState is up to four seconds old, and from a stale state it would
   sometimes ask for the wrong one. One function resolves them for both
   halves, so the glass and the mirror cannot disagree. */
const TABLE=[
  ['idle',     'tap',    'countdown', 'a tap starts the five minute prep'],
  ['countdown','double', 'racing',    'a double is you crossing the line'],
  ['racing',   'double', 'finished',  'and racing it is the finish'],
  ['racing',   'hold',   'idle',      'a hold puts it back to idle from a race'],
  ['countdown','hold',   'idle',      'and from a countdown'],
  ['finished', 'hold',   'idle',      'and from a finished race'],
  ['idle',     'double', 'countdown', 'a double on a stopped clock starts it'],
];
for(const [st,g,want,says] of TABLE){
  const got=await p.evaluate(([st,g])=>{
    tState=st; tLeft=300000;
    if(st==='countdown') tEnd=rnow()+200000;
    if(st==='racing')    tGun=rnow()-30000;
    timerGesture(g);
    return tState;
  },[st,g]);
  t.ok(got===want, says, st+' +'+g+' -> '+got);
}
/* A tap mid-countdown is a SYNC: it pulls the clock to the NEAREST
   whole minute, which is what the signal you have just heard means.
   The state is 'countdown' either way, so a probe that read only the
   state could not tell a sync from a restart - and a restart with
   thirty seconds to go is the worst thing on this list.
   Both directions, because nearest is the claim: a probe that only
   went up would pass on a round-up and one that only went down would
   pass on a floor. */
const syncs=[];
for(const [sec,want] of [[154,180],[140,120],[31,60],[29,0]]){
  syncs.push(await p.evaluate(sec=>{
    tState='countdown'; tEnd=rnow()+sec*1000;
    timerGesture('tap');
    return Math.round((tEnd-rnow())/1000);
  }, sec));
  const got=syncs[syncs.length-1];
  t.ok(Math.abs(got-want)<=1,
       sec+' seconds to go syncs to '+want, String(got));
}
/* The one that must do nothing. A tap while the race is running is a
   finger on the glass going past, and the glass does nothing with it
   either - the finish is a double. */
const r0=await p.evaluate(()=>{ tState='racing'; tGun=rnow()-30000;
                                timerGesture('tap'); return tState; });
t.ok(r0==='racing', 'and a single tap mid-race is not a finish', r0);

t.head('and a sequence of them from the phone runs in order');
/* Latest-wins is right for a slot and wrong here. A hold followed by a
   tap means reset and then start; keeping only the last leaves the
   boat in a state nobody asked for. */
await p.evaluate(()=>{ tState='racing'; tGun=rnow()-30000;
                       remoteDo({kind:'clock', seq:['hold','tap']}); });
t.ok((await p.evaluate(()=>tState))==='countdown',
     'reset and then started, rather than only the last of the two',
     await p.evaluate(()=>tState));
/* From RACING, because idle is where a stray gesture lands you anyway
   - a probe that checks nonsense from an idle clock cannot tell "not
   run" from "run, and happened to mean reset". */
await p.evaluate(()=>{ tState='racing'; tGun=rnow()-30000;
                       remoteDo({kind:'clock', seq:['burn','', 'TAP']});
                       remoteDo({kind:'clock', seq:'tap'});
                       remoteDo({kind:'clock', seq:{0:'tap'}});
                       remoteDo({kind:'clock'}); });
t.ok((await p.evaluate(()=>tState))==='racing',
     'a gesture it does not have, or no list at all, does nothing',
     await p.evaluate(()=>tState));
/* Four is already more than a finger makes inside one poll, and the
   cap is what stops a phone that has lost the boat handing over an
   afternoon of them at once. */
await p.evaluate(()=>{ tState='idle'; tLeft=300000;
  remoteDo({kind:'clock', seq:['tap','hold','tap','hold','tap']}); });
t.ok((await p.evaluate(()=>tState))==='idle',
     'and only the first four of a longer list are run',
     await p.evaluate(()=>tState));
await p.evaluate(()=>{ tState='idle'; tLeft=300000; });

t.head('the phone\'s tab turns the glass with it');
/* A phone showing the music page while the panel shows the dial is a
   mirror of something nobody is looking at. */
await p.evaluate(()=>remoteDo({kind:'page',page:'mus'}));
t.ok((await p.evaluate(()=>PAGE_I))===2, 'the music page comes up',
     String(await p.evaluate(()=>PAGE_I)));
t.ok((await p.evaluate(()=>remoteNow().page))===2,
     'and the wire says so, so the tab agrees after a swipe at the glass');
await p.waitForTimeout(250);
await p.evaluate(()=>remoteDo({kind:'page',page:'dial'}));
t.ok((await p.evaluate(()=>PAGE_I))===1, 'and back again',
     String(await p.evaluate(()=>PAGE_I)));
await p.evaluate(()=>{ remoteDo({kind:'page',page:'nope'});
                       remoteDo({kind:'page',page:'__proto__'});
                       remoteDo({kind:'page'}); });
t.ok((await p.evaluate(()=>PAGE_I))===1,
     'a page the panel has not got is not a page it turns to',
     String(await p.evaluate(()=>PAGE_I)));
/* A page turn hands the compositor a clean 420 ms and the frame paints
   nothing while it does. Waited out here so the sections below are
   looking at a panel that is drawing again. */
await p.waitForTimeout(500);

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

t.head('and a reload from the phone really does reload the glass');
/* Last, because it takes the page with it. A mark set on the window
   and then gone is the only honest way to see this: a flag the page
   sets for itself would survive anything short of a real navigation,
   which is exactly what is being claimed. */
await p.evaluate(()=>{ window.__alive='still here'; });
const gone=p.waitForEvent('framenavigated',{timeout:4000})
            .then(()=>true).catch(()=>false);
await p.evaluate(()=>remoteDo({kind:'power', action:'reload'}));
t.ok(await gone, 'the page navigates');
await p.waitForTimeout(600);
t.ok((await p.evaluate(()=>window.__alive))===undefined,
     'and it is a new one, not the same one carrying on',
     String(await p.evaluate(()=>window.__alive)));

await b.close();
t.done();
