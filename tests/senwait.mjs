/* The depth glyph's three states.

   Lit when there is a depth. Dim when there is no sounder. And between
   them the one that was missing: a sounder plugged in and pinging that
   has found no bottom - the transducer out of the water, fouled, not
   driven. That one is NOT lit, on purpose: a lit depth glyph over a dash
   is reassurance at exactly the wrong moment. It is the warn colour,
   half there, so "connected" and "measuring" stop looking the same.

   netd's half rides on /status, which the panel asks every five seconds
   while the control panel - where the glyph lives - is open. */
import {open, tally} from './helpers.mjs';
const t=tally();
const ST={sonar:{on:true, age:1.2}};
const {b,p}=await open(t,{status:ST});
await p.evaluate(()=>{ demoSet(false); openPanel(); });
await p.waitForTimeout(500);
const D='environment.depth.belowTransducer';
const state=async()=>{
  await p.evaluate(()=>netStatus()); await p.waitForTimeout(500);
  return p.evaluate(()=>{ const e=$('s-dpt');
    return {live:e.classList.contains('live'), wait:e.classList.contains('wait'),
            op:getComputedStyle(e).opacity}; }); };
const blank=()=>p.evaluate(D=>{ delete S[D]; delete S['environment.depth.belowKeel']; }, D);
const depth=()=>p.evaluate(D=>{ S[D]={v:2.0,t:Date.now()}; }, D);

t.head('pinging, no bottom: waiting, not lit');
await blank();
let s=await state();
t.ok(s.wait && !s.live, 'connected and not measuring', JSON.stringify(s));
t.ok(+s.op>0.4 && +s.op<0.9, 'and drawn half there, between dim and lit', s.op);

t.head('a depth: lit, and the waiting state steps aside');
await depth(); s=await state();
t.ok(s.live && !s.wait, 'measuring', JSON.stringify(s));
t.ok(+s.op>0.95, 'fully lit', s.op);

t.head('and the ways it is dim');
await blank();
ST.sonar={on:true, age:40}; s=await state();
t.ok(!s.wait && !s.live, 'a sounder gone quiet is not connected', JSON.stringify(s));
ST.sonar={on:true, age:null}; s=await state();
t.ok(!s.wait && !s.live, 'one configured and never heard from either', JSON.stringify(s));
ST.sonar={on:false, age:null}; s=await state();
t.ok(!s.wait && !s.live, 'and no sounder at all', JSON.stringify(s));
ST.sonar={on:true, age:1}; s=await state();
t.ok(s.wait, '(and back to waiting when it is heard again)', JSON.stringify(s));
await p.route('http://127.0.0.1:8091/**', r=>r.abort('connectionrefused'));
s=await state();
t.ok(!s.wait && !s.live, 'a helper that stops answering takes the state with it',
     JSON.stringify(s));

t.done(); await b.close();
