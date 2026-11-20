// Test harness: the real plugin BTSensor + the patched class, fake BlueZ.
const path = require("path");
const EventEmitter = require("events");
const PKG = process.argv[2];
const CLS = process.argv[3] || path.join(PKG, "sensor_classes/EcoWorthyBW02.js");
const F = require(path.join(__dirname, "frames.json"));
const C = require(CLS);
const hx = (k) => Buffer.from(F[k], "hex");
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.log("FAIL:", msg); } };
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

C.getDeviceProps = async () => C._props;
C.REPLY_MS = [30, 60, 120];
C.CONNECT_TRIES = 2; C.CONNECT_RETRY_SECS = 0.02; C.GATT_SECS = 0.2;

class Char extends EventEmitter {
  constructor(flags) { super(); this.flags = flags; this.notifying = false; this.writes = []; }
  async getFlags() { return this.flags; }
  async isNotifying() { return this.notifying; }
  async startNotifications() { this.notifying = true; }
  async stopNotifications() { this.notifying = false; }
}
function makeDevice({ mac, frames, needUnlock = true, flags = ["write-without-response"], failWithResp = false, failWithout = false }) {
  const rx = new Char(["notify"]);
  const tx = new Char(flags);
  const dev = new EventEmitter();
  dev.helper = Object.assign(new EventEmitter(), { iface: "org.bluez.Device1",
    callMethod: async () => { dev.connects = (dev.connects || 0) + 1; if (dev.refuse > 0) { dev.refuse--; throw new Error("le-connection-abort-by-local"); } }, _prepare() {}, removeListeners() {} });
  dev.disconnects = 0;
  dev.disconnect = async () => { dev.disconnects++; };
  const svc = { getCharacteristic: async (u) => (u.startsWith("0000fff1") ? rx : u.startsWith("0000fff2") ? tx : Promise.reject(new Error("no char"))) };
  dev.gatt = async () => { if (dev.gattDelay) await sleep(dev.gattDelay); return dev.hangGatt ? new Promise(() => {}) : ({ getPrimaryService: async (u) => { if (!u.startsWith("0000fff0")) throw new Error("no svc"); return svc; },
    services: async () => [], helper: { removeListeners() {} } }); };
  const got = new Set();
  let streaming = !needUnlock;
  const stream = () => { if (!dev.silent) for (const f of frames) rx.emit("valuechanged", f); };
  const doWrite = (buf, mode) => {
    tx.writes.push({ hex: buf.toString("hex"), mode });
    got.add(buf.toString("hex").slice(-4));
    if (got.has("002d") && got.has("65ef")) streaming = true;
    if (streaming) setTimeout(stream, 5);
  };
  tx.writeValueWithResponse = async (b) => { if (failWithResp) throw new Error("not permitted"); doWrite(b, "resp"); };
  tx.writeValueWithoutResponse = async (b) => { if (failWithout) throw new Error("not permitted"); doWrite(b, "noresp"); };
  dev._rx = rx; dev._tx = tx; dev._stream = () => streaming && stream();
  C._props = { Address: mac, Name: "ECO-WORTHY 0B_F6D7", RSSI: -62 };
  return dev;
}
async function makeSensor(dev) {
  const s = new C(dev, { batteryID: "house" }, {});
  s.debug = () => {};
  s._adapter = { helper: { callMethod: async () => {} } };
  const t0 = Date.now();
  await s.init();
  s._initMs = Date.now() - t0;
  s.values = {};
  s.on = s.on.bind(s);
  const origEmit = s.emit.bind(s);
  s.emit = (tag, v) => { s.values[tag] = v; return origEmit(tag, v); };
  return s;
}
const expand = (tmpl) => String(tmpl).replace("{batteryID}", "house");

(async () => {
  // ---- 1. Schema: instant, no connection, panel's paths ----
  {
    const dev = makeDevice({ mac: "E2:E7:79:99:53:58", frames: [] });
    const s = await makeSensor(dev);
    ok(s._initMs < 200, `init took ${s._initMs} ms`);
    ok(!dev.connects, "init must not connect");
    const p = s.getPaths();
    const want = {
      voltage: "electrical.batteries.house.voltage", current: "electrical.batteries.house.current",
      SOC: "electrical.batteries.house.capacity.stateOfCharge", SOH: "electrical.batteries.house.capacity.stateOfHealth",
      nominalAh: "electrical.batteries.house.capacity.nominalAh", problem: "electrical.batteries.house.problem",
      cell0Voltage: "electrical.batteries.house.cells.0.voltage", cell3Voltage: "electrical.batteries.house.cells.3.voltage",
      temp0: "electrical.batteries.house.temperatures.0", temp1: "electrical.batteries.house.temperatures.1",
      RSSI: "electrical.batteries.house.rssi",
    };
    for (const [tag, pth] of Object.entries(want)) ok(p[tag] && expand(p[tag].default) === pth, `path ${tag} = ${p[tag] && p[tag].default}`);
    ok(p.temp0.unit === "K" && p.SOC.unit === "ratio", "units");
    ok(s.getJSONSchema().properties.params.properties.batteryID, "batteryID param present");
    // the settings page then calls stopListening on this never-connected instance
    await s.stopListening();
    ok(dev.disconnects === 0, "throwaway instance must not ask BlueZ to disconnect");
  }

  // ---- 2. Protocol 1, pack silent until both unlocks ----
  const v1exp = { voltage: 13.29, current: -1.14, SOC: 0.72, SOH: 1, nominalAh: 100, problem: 0,
    cell0Voltage: 3.323, cell1Voltage: 3.325, cell2Voltage: 3.323, cell3Voltage: 3.322,
    temp0: 20.5 + 273.15, temp1: 19.2 + 273.15, temp2: 19.0 + 273.15 };
  const v2exp = { voltage: 13.28, current: -6.0, SOC: 0.98, SOH: 1, nominalAh: 100, problem: 0,
    cell0Voltage: 3.323, cell1Voltage: 3.324, cell2Voltage: 3.323, cell3Voltage: 3.317,
    temp0: 22.0 + 273.15, temp1: 21.4 + 273.15 };
  for (const [name, mac, frames, exp, absent] of [
    ["v1", "E2:E7:79:99:53:58", [hx("v1a1"), hx("v1a2")], v1exp, ["cell4Voltage", "temp3"]],
    ["v2", "E2:E7:79:00:00:00", [hx("v2a1"), hx("v2a2")], v2exp, ["cell4Voltage", "temp2", "temp3"]],
  ]) {
    const dev = makeDevice({ mac, frames });
    const s = await makeSensor(dev);
    await s.activate({}, { id: "bt-sensors" }).catch((e) => ok(false, `${name} activate: ${e.message}`));
    await sleep(50);
    const hexes = dev._tx.writes.map((w) => w.hex);
    ok(hexes.includes(C.UNLOCK[0].toString("hex")) && hexes.includes(C.UNLOCK[1].toString("hex")), `${name}: both unlock commands sent`);
    ok(hexes.indexOf(C.UNLOCK[0].toString("hex")) < hexes.indexOf(C.UNLOCK[1].toString("hex")), `${name}: unlock order`);
    for (const [tag, v] of Object.entries(exp)) ok(near(s.values[tag], v), `${name} ${tag}: got ${s.values[tag]} want ${v}`);
    for (const tag of absent) ok(!(tag in s.values), `${name}: ${tag} must be absent, got ${s.values[tag]}`);
    const bad = Object.entries(s.values).filter(([t]) => t in s.getPaths()).filter(([t, v]) => typeof v !== "number" || !Number.isFinite(v));
    ok(!bad.length, `${name}: only finite numbers, bad: ${JSON.stringify(bad)}`);
    await s.stopListening();
    ok(!s.intervalID, `${name}: watchdog cleared on stop`);
  }

  // ---- 3. Bad frames rejected, problem codes ----
  const mac1 = Buffer.from("e2e779995358", "hex");
  ok(C.parseFrame(hx("wrongtype"), mac1) === null, "wrong type rejected");
  ok(C.parseFrame(hx("wrongcrc"), mac1) === null, "wrong CRC rejected");
  ok(C.parseFrame(Buffer.alloc(0), mac1) === null && C.parseFrame(Buffer.from([0xa1]), mac1) === null, "short rejected");
  ok(C.parseFrame(hx("v2a1"), mac1) === null, "v2 frame with a different MAC rejected");
  ok(C.parseFrame(hx("v1a1"), mac1).v2 === false && C.parseFrame(hx("v2a1"), Buffer.from("e2e779000000", "hex")).v2 === true, "layout detection");
  {
    const dev = makeDevice({ mac: "E2:E7:79:99:53:58", frames: [hx("prob_first")], needUnlock: false });
    const s = await makeSensor(dev); await s.activate({}, { id: "x" }); await sleep(30);
    ok(s.values.problem === 1, `problem first bit: ${s.values.problem}`);
    dev._rx.emit("valuechanged", hx("prob_last"));
    ok(s.values.problem === 0x8000, `problem last bit: ${s.values.problem}`);
    // garbage between good frames does not disturb values
    dev._rx.emit("valuechanged", hx("wrongcrc"));
    ok(s.values.problem === 0x8000 && near(s.values.voltage, 13.29), "garbage ignored");
    // a cell slot reading 0 means "no cell": never published as 0 V
    {
      const f = Buffer.from(hx("v1a2")); f.writeUInt16BE(0, 16 + 2 * 2);
      let crc = 0xffff; for (const b of f.subarray(0, f.length - 2)) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1; }
      f.writeUInt16LE(crc, f.length - 2);
      s.values = {}; dev._rx.emit("valuechanged", f);
      ok(near(s.values.cell1Voltage, 3.325) && !("cell2Voltage" in s.values), `zero cell left out: ${s.values.cell2Voltage}`);
    }
    await s.stopListening();
  }

  // ---- 4. Write-mode fallback ----
  {
    const dev = makeDevice({ mac: "E2:E7:79:99:53:58", frames: [hx("v1a1")], flags: ["write"], failWithResp: true });
    const s = await makeSensor(dev); await s.activate({}, { id: "x" }); await sleep(30);
    ok(near(s.values.voltage, 13.29), "falls back to write-without-response");
    ok(s._withResponse === false, "remembers the mode that works");
    await s.stopListening();
  }
  {
    const dev = makeDevice({ mac: "E2:E7:79:99:53:58", frames: [hx("v1a1")], flags: ["write-without-response"], failWithout: true });
    const s = await makeSensor(dev); await s.activate({}, { id: "x" }); await sleep(30);
    ok(near(s.values.voltage, 13.29), "falls back to write-with-response");
    await s.stopListening();
  }

  // ---- 5. Silent pack: activation finishes (no hang), watchdog re-asks ----
  {
    C.STALE_SECS = 0.15; C.WATCH_SECS = 0.05;
    const dev = makeDevice({ mac: "E2:E7:79:99:53:58", frames: [hx("v1a1")] });
    dev.silent = true;
    const s = await makeSensor(dev);
    const t0 = Date.now();
    await s.activate({}, { id: "x" });
    const took = Date.now() - t0;
    ok(took < 1500, `silent pack: activate returns (${took} ms)`);
    const n0 = dev._tx.writes.length;
    ok(n0 === 6, `silent pack: 3 tries per command, got ${n0}`);
    await sleep(600);
    ok(dev._tx.writes.length > n0, "watchdog asks again");
    dev.silent = false;
    await sleep(600);
    ok(near(s.values.voltage, 13.29), "data once the pack answers");
    // link drop -> reconnect
    const c0 = dev.connects;
    s.setConnected(false); dev.silent = true;
    await sleep(600);
    ok(dev.connects > c0, "reconnects after link drop");
    dev.silent = false; s.values = {};
    await sleep(800);
    ok(near(s.values.voltage, 13.29), "data after reconnect");
    await s.stopListening();
    const w = dev._tx.writes.length; await sleep(300);
    ok(dev._tx.writes.length === w, "no writes after stop");
    C.STALE_SECS = 15; C.WATCH_SECS = 5;
  }

  // ---- 6. Refused connections and service discovery that never answers ----
  {
    C.STALE_SECS = 0.15; C.WATCH_SECS = 0.05;
    const dev = makeDevice({ mac: "E2:E7:79:99:53:58", frames: [hx("v1a1")] });
    dev.refuse = 4; // two whole connect rounds of two tries each
    const s = await makeSensor(dev);
    let err = null;
    const t0 = Date.now();
    await s.activate({}, { id: "x" }).catch((e) => (err = e));
    ok(err && Date.now() - t0 < 1000, `refused connect: activate rejects promptly (${err && err.message})`);
    await sleep(1500);
    ok(near(s.values.voltage, 13.29), "refused connect: watchdog retries until data");
    ok(!s.isError(), "error cleared once connected");
    await s.stopListening();

    const d2 = makeDevice({ mac: "E2:E7:79:99:53:58", frames: [hx("v1a1")] });
    d2.hangGatt = true;
    const s2 = await makeSensor(d2);
    err = null;
    const t1 = Date.now();
    await s2.activate({}, { id: "x" }).catch((e) => (err = e));
    ok(err && /timed out/.test(err.message) && Date.now() - t1 < 1000, `hung discovery: activate rejects (${err && err.message})`);
    d2.hangGatt = false;
    await sleep(1500);
    ok(near(s2.values.voltage, 13.29), "hung discovery: watchdog retries until data");
    // a drop whose reconnect hangs must not lock the watchdog out
    s2.setConnected(false); d2.hangGatt = true; d2.silent = true;
    await sleep(800);
    d2.hangGatt = false; d2.silent = false; s2.values = {};
    await sleep(1500);
    ok(near(s2.values.voltage, 13.29), "reconnect that hung once still recovers");
    await s2.stopListening();
    const w = d2._tx.writes.length, c = d2.connects; await sleep(300);
    ok(d2._tx.writes.length === w && d2.connects === c, "nothing after stop");

    // stopped while a slow reconnect is still finishing: it must stay stopped
    {
      const d3 = makeDevice({ mac: "E2:E7:79:99:53:58", frames: [hx("v1a1")] });
      const s3 = await makeSensor(d3);
      await s3.activate({}, { id: "x" }); await sleep(50);
      s3.setConnected(false); d3.silent = true; d3.gattDelay = 120; // inside GATT_SECS, so the reconnect would succeed
      const c0 = d3.connects;
      while (d3.connects === c0) await sleep(10); // reconnect under way
      await s3.stopListening();
      const w = d3._tx.writes.length;
      d3.silent = false;
      await sleep(900);
      ok(d3._tx.writes.length === w && !s3.intervalID, `stop during reconnect stays stopped (writes ${d3._tx.writes.length - w}, timer ${!!s3.intervalID})`);
    }
    C.STALE_SECS = 15; C.WATCH_SECS = 5;
  }

  console.log(`${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(2); });
