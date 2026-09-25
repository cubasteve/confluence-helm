/* The finish card: which entry, whether to send it, and what happens
   when the answer is yes, no, or the club's server says no. */
import {open, tally} from './helpers.mjs';
const t=tally();
/* The demo is ON - it is on by default, and on a real boat too, where
   it only fills what nothing else publishes. What stops a submission is
   an invented FIX, which is a different question; see the foot of this
   file. So finish() puts a real position in first. */
const {b,p,scores,posts}=await open(t,{demo:true,
  status:{score:{available:true, url:'https://vuduwave.com/api/add_scratch_time'}}});

const card=()=>p.evaluate(()=>({on:$('score').classList.contains('on'),
  face:['told','qr','sent','busy'].filter(c=>$('score').classList.contains(c)).join('+'),
  step:scoreStep, t:$('sc-t').textContent, s:$('sc-s').textContent,
  big:$('sc-big').textContent, time:$('sc-time').textContent,
  qr:$('sc-qr').querySelectorAll('path,rect').length}));
/* rnow(), not Date.now(): the race clock is what finishRace() reads,
   and the two part company the moment anything runs at 3x.
   `src` is what the card asks about - a fix from the boat's own GPS,
   or one the demo made up. */
const finish=(ms,src='sk')=>p.evaluate(([m,src])=>{ scoreSent='';
  feedPut('pos.lat', 28.8190, src); feedPut('pos.lon', -81.2650, src);
  tGun=rnow()-m; tState='racing'; finishRace(); }, [ms,src]);

t.head('the time is written the way the form takes it');
const RE=[/^[0-9]+[,:.][0-5][0-9][,:.][0-5][0-9]$/, /^[0-5][0-9][,:.][0-5][0-9]$/,
          /^[0-9][,:.][0-5][0-9]$/];
const F=await p.evaluate(()=>[0,15000,2895000,3855000,45296000].map(ms=>[ms,scoreTime(ms)]));
F.forEach(([ms,s])=>t.ok(RE.some(r=>r.test(s)), ms+' ms is '+s+', a shape it accepts'));
t.ok(F.find(x=>x[0]===2895000)[1]==='0.48.15', '48:15 comes out 0.48.15');
t.ok(F.find(x=>x[0]===3855000)[1]==='1.04.15', 'and over the hour, 1.04.15');

t.head('the finish asks the one thing the helm cannot know');
await finish(2895000); await p.waitForTimeout(400);
let v=await card();
t.ok(v.on && v.face==='', 'the card is up', JSON.stringify(v));
t.ok(v.t==='SPINNAKER?', 'asking about the kite', v.t);

t.head('and then whether to send it');
await p.click('#sc-no'); await p.waitForTimeout(300);
v=await card();
t.ok(v.face==='told'&&v.step==='send', 'the second question', JSON.stringify(v));
t.ok(v.t==='SUBMIT TO VUDU WAVE?', 'is whether to submit', v.t);
t.ok(/STEVEN ARTAU/.test(v.s)&&/CAP22NS/.test(v.s), 'white sails is the NS entry, by name',
     v.s);
t.ok(v.big==='0.48.15', 'with the time it would send', v.big);

t.head('NO sends nothing and says what to type');
scores.length=0;
await p.click('#sc-no'); await p.waitForTimeout(300);
v=await card();
t.ok(v.face==='qr'&&v.qr>0, 'the code instead', JSON.stringify(v));
t.ok(v.time==='0.48.15', 'and the number', v.time);
t.ok(scores.length===0, 'NOTHING was submitted', JSON.stringify(scores));
await p.click('#sc-done'); await p.waitForTimeout(200);

t.head('YES posts it, straight from the page');
await finish(3855000); await p.waitForTimeout(300);
await p.click('#sc-yes'); await p.waitForTimeout(300);
v=await card();
t.ok(/CAP22$/.test(v.s.trim()), 'the kite is the CAP22 entry', v.s);
scores.length=0; posts.length=0;
await p.click('#sc-yes'); await p.waitForTimeout(900);
t.ok(scores.length===1, 'one submission', JSON.stringify(scores));
t.ok(scores[0].racer_id===201 && scores[0].elapsed_time==='1.04.15',
     'the racer and the time the card showed', JSON.stringify(scores[0]));
t.ok(!scores[0].token, 'and no captcha token, faked or otherwise',
     JSON.stringify(scores[0]));
t.ok(!posts.some(x=>x.path==='/score'), 'the helper was not involved',
     JSON.stringify(posts.map(x=>x.path)));
v=await card();
t.ok(v.face==='sent'&&/^SENT · 1\.04\.15/.test(v.t), 'and it says so', JSON.stringify(v));
t.ok(/TIME ADDED/.test(v.s), "in the server's own words", v.s);
await p.click('#sc-close'); await p.waitForTimeout(200);

t.head('the same result cannot go twice');
scores.length=0;
await p.evaluate(()=>{ tGun=Date.now()-2895000; tState='racing'; finishRace(); });
await p.waitForTimeout(300);
await p.click('#sc-no'); await p.waitForTimeout(250);
await p.click('#sc-yes'); await p.waitForTimeout(800);
t.ok(scores.length===1, 'the first goes', JSON.stringify(scores));
await p.click('#sc-close'); await p.waitForTimeout(200);
await p.evaluate(()=>{ tGun=Date.now()-2895000; tState='racing'; finishRace(); });
await p.waitForTimeout(300);
await p.click('#sc-no'); await p.waitForTimeout(250);
await p.click('#sc-yes'); await p.waitForTimeout(800);
v=await card();
t.ok(scores.length===1, 'the identical one behind it does not', JSON.stringify(scores));
t.ok(/ALREADY SENT/.test(v.s), 'and says why', v.s);
await p.click('#sc-done'); await p.waitForTimeout(200);

t.head('a refusal falls back rather than claiming success');
await p.evaluate(()=>{ scoreSent=''; });
await p.route('https://vuduwave.com/**', r=>r.fulfill({status:403,
  contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'},
  body:'{"message":"captcha verification failed"}'}));
await finish(2895000); await p.waitForTimeout(300);
await p.click('#sc-no'); await p.waitForTimeout(250);
await p.click('#sc-yes'); await p.waitForTimeout(900);
v=await card();
t.ok(v.face==='qr', 'onto the code', JSON.stringify(v));
t.ok(v.t==='NOT SENT · TYPE IT IN', 'saying plainly it did not go', v.t);
t.ok(/REFUSED 403/.test(v.s), 'with the status it got', v.s);
t.ok(v.time==='0.48.15', 'and the number still there to type', v.time);

t.head('a race the demo sailed never reaches the club');
/* The card is worth walking through while testing - the question, the
   time, the code. The thing on the far end is somebody else's small
   server, and a time nobody sailed landing on the board is not
   something a tap takes back. */
scores.length=0;
await finish(1800000,'demo'); await p.waitForTimeout(400);
v=await card();
t.ok(v.on && v.t==='SPINNAKER?', 'the card still comes up', JSON.stringify(v));
await p.click('#sc-no'); await p.waitForTimeout(400);
v=await card();
t.ok(/DEMO RACE . NOT SENT/.test(v.time)||/DEMO/.test(v.time+v.t+v.s),
     'and says why it is going no further', JSON.stringify(v));
t.ok(scores.length===0, 'NOTHING was submitted', JSON.stringify(scores));
t.ok(v.qr>0, 'the code is still there, so the flow can be walked end to end',
     String(v.qr));
await p.click('#sc-done'); await p.waitForTimeout(200);
await finish(1900000,'sk'); await p.waitForTimeout(300);
await p.click('#sc-no'); await p.waitForTimeout(300);
t.ok((await card()).t==='SUBMIT TO VUDU WAVE?',
     'and a real fix asks to submit again, as before - the DEMO flag is '
     +'on the whole time, because it is on by default');
await p.click('#sc-no'); await p.waitForTimeout(200);
await p.click('#sc-done'); await p.waitForTimeout(200);

t.head('and the QR is an address a camera can read');
t.ok((await p.evaluate(()=>SCORE_URL))==='https://vuduwave.com/lmsa', 'the address');
t.ok(await p.evaluate(()=>!!qrMatrix(SCORE_URL)), 'and it fits in a code');

await t.done(b);
