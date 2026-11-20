/*
  Eco-Worthy BW 02 / 0B (and DCHOUSE) Bluetooth BMS, for bt-sensors-plugin-sk.

  A drop-in replacement for the plugin's own sensor_classes/EcoWorthyBW02.js
  (written against bt-sensors-plugin-sk 1.3.7). Same class, same file name,
  so a battery already configured as EcoWorthyBW02 keeps its settings.

  WHAT WAS WRONG WITH THE ORIGINAL, against patman15/aiobmsble's
  ecoworthy_bms.py (the Home Assistant BMS library, which reads these packs
  in the field) and that library's recorded frames from real batteries:

  1. It never sent anything. Some of these packs stay silent until they are
     written two "unlock" commands on fff2, and then stream. The original
     connected, switched notifications on and waited - and its schema step
     waited for a cell count with NO time limit, so the plugin's settings
     page said "Fetching schema" for ever.
  2. It only knew one frame layout. Protocol 2 puts the pack's own MAC
     address in front of the frame type (and scales current by 10, not 100).
     Those frames were never recognised at all.
  3. It checked no CRC. Every frame ends in a CRC-16/MODBUS, little-endian.
  4. Cell 1 and temperature 1 were never published (tags registered 0..n-1,
     emitted 1..n), and temperatures went out in Celsius labelled Kelvin.

  WHAT THIS DOES INSTEAD
  - The schema is static and connects to nothing, so the settings page opens
    at once. Up to MAX_CELLS cells and MAX_TEMPS probes are declared; only
    the ones the pack reports are ever published.
  - On activation: notifications on, then the two unlock commands, each
    waiting briefly for any valid frame (retried, both write modes tried),
    exactly as aiobmsble does.
  - A watchdog, running from the first connect attempt: no valid frame
    for STALE_SECS and it asks again, or sets the link up again if it
    dropped or never finished. A pack that goes quiet is asked, not
    waited on.
  - A refused connect is an error, and service discovery has a time limit.
    (The base class gives up on a refused connect without saying so, and
    node-ble then waits for services with no limit - activation would
    never end, and nothing would retry.)
  - Frames are accepted only if the CRC checks, and only in the two layouts
    aiobmsble accepts. A reading that cannot be decoded is not published:
    absent stays absent, never zero.

  PATHS (all under electrical.batteries.{batteryID}):
    voltage, current, capacity.stateOfCharge (ratio), capacity.stateOfHealth
    (ratio), capacity.nominalAh (Ah, the design capacity), problem (the raw
    16-bit fault code, 0 = none; the bits have no published meanings),
    cells.<n>.voltage, temperatures.<n> (K), rssi.
*/
const BTSensor = require("../BTSensor.js");

function crcModbus(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class EcoWorthyBW02 extends BTSensor {
  static Domain = BTSensor.SensorDomains.electrical;

  static TX_RX_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
  static NOTIFY_CHAR_UUID = "0000fff1-0000-1000-8000-00805f9b34fb";
  static WRITE_CHAR_UUID = "0000fff2-0000-1000-8000-00805f9b34fb";

  // aiobmsble ecoworthy_bms.py _INIT_CMDS, byte for byte.
  static UNLOCK = [
    Buffer.from("ff0802000b01006401ffffffffffffff002d", "hex"),
    Buffer.from("ff0802000b01001401ffffffffffffff65ef", "hex"),
  ];

  static MAX_CELLS = 16;
  static MAX_TEMPS = 4;
  static STALE_SECS = 15; // no valid frame for this long: ask again
  static WATCH_SECS = 5;
  static REPLY_MS = [500, 1000, 2000]; // per-attempt wait for any valid frame
  static CONNECT_TRIES = 5; // per connect, as the base class does
  static CONNECT_RETRY_SECS = 3;
  static GATT_SECS = 20; // service discovery that takes longer has failed

  static ImageFile = "EcoWorthyBW02.webp";

  static identify(device) {
    return null;
  }

  /*
    One notification to { type, body, v2 }, or null if it is not a valid
    frame. `body` is indexed the way aiobmsble indexes its stored message:
    protocol 1 as received, protocol 2 (MAC in front) with two zero bytes
    prepended - so every field offset below means the same in both.
  */
  static parseFrame(raw, mac) {
    const buf = Buffer.from(raw);
    if (buf.length < 4) return null;
    let type, body, v2;
    if (buf[0] === 0xa1 || buf[0] === 0xa2) {
      type = buf[0];
      body = buf;
      v2 = false;
    } else if (
      mac &&
      mac.length === 6 &&
      buf.length > 8 &&
      buf.subarray(0, 6).equals(mac) &&
      (buf[6] === 0xa1 || buf[6] === 0xa2)
    ) {
      type = buf[6];
      body = Buffer.concat([Buffer.alloc(2), buf]);
      v2 = true;
    } else return null;
    if (crcModbus(buf.subarray(0, buf.length - 2)) !== buf.readUInt16LE(buf.length - 2))
      return null;
    return { type, body, v2 };
  }

  // Read an unsigned/signed 16-bit big-endian field, or undefined if the
  // frame is too short to hold it (aiobmsble skips such fields too).
  static u16(b, pos) {
    return pos + 2 <= b.length ? b.readUInt16BE(pos) : undefined;
  }
  static s16(b, pos) {
    return pos + 2 <= b.length ? b.readInt16BE(pos) : undefined;
  }

  macBytes() {
    const hex = String(this.getMacAddress() || "").replace(/[^0-9a-fA-F]/g, "");
    return hex.length === 12 ? Buffer.from(hex, "hex") : null;
  }

  async initSchema() {
    super.initSchema();
    this.addDefaultParam("batteryID");
    const C = this.constructor;
    const div = (v, d) => (v === undefined ? undefined : v / d);

    this.addDefaultPath("voltage", "electrical.batteries.voltage").read = (b) =>
      div(C.u16(b, 20), 100);
    this.addDefaultPath("current", "electrical.batteries.current").read = (b, f) =>
      div(C.s16(b, 22), f && f.v2 ? 10 : 100);
    this.addDefaultPath("SOC", "electrical.batteries.capacity.stateOfCharge").read = (b) =>
      div(C.u16(b, 16), 100);
    this.addDefaultPath("SOH", "electrical.batteries.capacity.stateOfHealth").read = (b) =>
      div(C.u16(b, 18), 100);

    this.addMetadatum("nominalAh", "Ah", "Design capacity", (b) => {
      const v = C.u16(b, 26);
      return v === undefined ? undefined : Math.trunc(v / 100);
    }).default = "electrical.batteries.{batteryID}.capacity.nominalAh";

    this.addMetadatum("problem", "", "BMS fault code (raw, 0 = none)", (b) =>
      C.u16(b, 51)
    ).default = "electrical.batteries.{batteryID}.problem";

    for (let i = 0; i < C.MAX_CELLS; i++)
      this.addMetadatum(`cell${i}Voltage`, "V", `Cell ${i + 1} voltage`, (b) => {
        const v = C.u16(b, 16 + 2 * i);
        return v ? v / 1000 : undefined; // 0 means no cell there
      }).default = `electrical.batteries.{batteryID}.cells.${i}.voltage`;

    for (let i = 0; i < C.MAX_TEMPS; i++)
      this.addMetadatum(`temp${i}`, "K", `Temperature ${i + 1}`, (b) => {
        const v = C.s16(b, 82 + 2 * i);
        return v === undefined ? undefined : Math.round((v / 10 + 273.15) * 100) / 100;
      }).default = `electrical.batteries.{batteryID}.temperatures.${i}`;

    // The pack's link strength belongs with the pack.
    this.getPath("RSSI").default = "electrical.batteries.{batteryID}.rssi";
  }

  hasGATT() {
    return true;
  }
  usingGATT() {
    return true;
  }

  // Reject after `secs`, so a BlueZ call that never answers is a failure
  // the watchdog can retry, not a wait that holds everything for ever.
  withTimeout(promise, secs, what) {
    let t;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`${what} timed out after ${secs} s`)), secs * 1000);
      }),
    ]).finally(() => clearTimeout(t));
  }

  /*
    The base class gives up on a refused connect without saying so, and
    node-ble then waits with no time limit for services that will never
    resolve. Here a refused connect is an error, and service discovery has
    a time limit - so activation always ends, and the watchdog retries.
  */
  async initGATTConnection(isReconnecting = false) {
    const C = this.constructor;
    this._ready = false; // set once notifications are on and the pack is asked
    await super.initGATTConnection(isReconnecting, C.CONNECT_TRIES, C.CONNECT_RETRY_SECS);
    if (!this.isConnected()) throw new Error("the battery refused the connection");
    let svc;
    try {
      svc = await this.withTimeout(
        (async () => (await this.getGATTServer()).getPrimaryService(C.TX_RX_SERVICE))(),
        C.GATT_SECS,
        "service discovery"
      );
    } catch (e) {
      this._gattServer = null; // never reuse a half-made server
      throw e;
    }
    this.rxChar = await svc.getCharacteristic(this.constructor.NOTIFY_CHAR_UUID);
    try {
      this.txChar = await svc.getCharacteristic(this.constructor.WRITE_CHAR_UUID);
    } catch (e) {
      this.txChar = null; // a pack that streams unasked still works
    }
    return this;
  }

  // The watchdog runs from the first connect attempt, so a battery that
  // refuses the first connection is asked again rather than given up on.
  async activateGATT(isReconnecting = false) {
    this._stopped = false;
    this.startWatchdog();
    this._connecting = true;
    try {
      await super.activateGATT(isReconnecting);
    } finally {
      this._connecting = false;
    }
  }

  // A polling frequency set in the GATT settings means nothing to a pack
  // that streams; never fall into the base class's poll-and-disconnect loop.
  async initGATTInterval() {
    return this.initGATTNotifications();
  }

  async initGATTNotifications() {
    if (this._stopped) return; // stopped while a reconnect was under way
    this.rxChar.removeAllListeners("valuechanged");
    this.rxChar.on("valuechanged", (buf) => this.onFrame(buf));
    await this.rxChar.startNotifications();
    this._lastFrame = 0;
    await this.unlock();
    this._ready = true; // the watchdog, started in activateGATT, takes it from here
  }

  onFrame(raw) {
    const f = this.constructor.parseFrame(raw, this.macBytes());
    if (!f) return;
    this._lastFrame = Date.now();
    if (this._frameWaiter) this._frameWaiter();
    const C = this.constructor;
    if (f.type === 0xa1) {
      for (const tag of ["voltage", "current", "SOC", "SOH", "nominalAh", "problem"])
        this.say(tag, f);
    } else {
      const cells = Math.min(C.u16(f.body, 14) ?? 0, C.MAX_CELLS);
      for (let i = 0; i < cells; i++) this.say(`cell${i}Voltage`, f);
      const temps = Math.min(C.u16(f.body, 80) ?? 0, C.MAX_TEMPS);
      for (let i = 0; i < temps; i++) this.say(`temp${i}`, f);
    }
  }

  // Publish only a real number: undefined, NaN and Infinity are left out.
  say(tag, f) {
    const md = this.getPath(tag);
    if (!md || !md.read) return;
    let v;
    try {
      v = md.read(f.body, f);
    } catch (e) {
      return;
    }
    if (typeof v === "number" && Number.isFinite(v)) this.emit(tag, v);
  }

  waitForFrame(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this._frameWaiter = null;
        resolve(false);
      }, ms);
      this._frameWaiter = () => {
        clearTimeout(t);
        this._frameWaiter = null;
        resolve(true);
      };
    });
  }

  async write(cmd) {
    const tx = this.txChar;
    if (!tx || this._stopped) return false;
    if (this._withResponse === undefined) {
      let flags = [];
      try {
        flags = (await tx.getFlags()) || [];
      } catch (e) {}
      this._withResponse = flags.includes("write");
    }
    for (const withResponse of [this._withResponse, !this._withResponse]) {
      try {
        if (withResponse) await tx.writeValueWithResponse(cmd);
        else await tx.writeValueWithoutResponse(cmd);
        this._withResponse = withResponse; // remember what worked
        return true;
      } catch (e) {
        this.debug(`write (${withResponse ? "with" : "without"} response) failed: ${e.message}`);
      }
    }
    return false;
  }

  // The two unlock commands, each retried until any valid frame answers.
  async unlock() {
    for (const cmd of this.constructor.UNLOCK) {
      for (const ms of this.constructor.REPLY_MS) {
        const waiting = this.waitForFrame(ms);
        if (!(await this.write(cmd))) {
          await waiting;
          break; // cannot write at all; the watchdog will try again
        }
        if (await waiting) break;
      }
    }
  }

  startWatchdog() {
    if (this._stopped) return;
    if (this.intervalID) clearInterval(this.intervalID);
    this.intervalID = setInterval(() => this.watch(), this.constructor.WATCH_SECS * 1000);
  }

  async watch() {
    if (this._watching || this._connecting || this._stopped) return;
    this._watching = true;
    try {
      if (Date.now() - (this._lastFrame || 0) < this.constructor.STALE_SECS * 1000) return;
      // Connected but never set up (discovery timed out) needs the full
      // setup again, not just another unlock.
      if (!this.isConnected() || !this._ready) {
        this.debug("link dropped; reconnecting");
        this._gattServer = null;
        this._connecting = true;
        try {
          await this.initGATTConnection(true);
          await this.initGATTNotifications();
        } finally {
          this._connecting = false;
        }
        if (this.isError && this.isError()) this.unsetError();
      } else {
        this.debug("no data; asking again");
        await this.unlock();
      }
    } catch (e) {
      this.debug(`watchdog: ${e.message}`);
    } finally {
      this._watching = false;
    }
  }

  async deactivateGATT() {
    this._stopped = true;
    if (this.intervalID) {
      clearInterval(this.intervalID);
      this.intervalID = null;
    }
    await this.stopGATTNotifications(this.rxChar);
    // The settings page builds a throwaway instance that never connects;
    // asking BlueZ to disconnect that would only raise an error.
    if (this.isConnected()) await super.deactivateGATT();
  }
}

module.exports = EcoWorthyBW02;
