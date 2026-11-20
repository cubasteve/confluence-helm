# Eco-Worthy reader for BT Sensors

`EcoWorthyBW02.js` replaces the file of the same name in the Signal K
plugin `bt-sensors-plugin-sk` (written against 1.3.7). It is the reader
behind the Energy app: see `docs/display.md`, *The reader*.

## Install on the Pi

The Pi's checkout (`~/helm`, kept current by autopull) already has this
file. The copy goes into the plugin's own folder; the checkout is left alone.

```sh
P=~/.signalk/node_modules/bt-sensors-plugin-sk
grep '"version"' $P/package.json                 # expect 1.3.7
cp -n $P/sensor_classes/EcoWorthyBW02.js ~/EcoWorthyBW02.js.orig   # backup, once
R=$(ls -d ~/helm ~/confluence-helm 2>/dev/null | head -1)      # the checkout
cp $R/boat/bt-sensors/EcoWorthyBW02.js $P/sensor_classes/
```

Then restart Signal K: the **Restart** button at the top right of the
admin page, or `sudo systemctl restart signalk`.

In **Server → Plugin Config → BT Sensors**:

1. Make sure nothing else holds the pack: on the Pi,
   `bluetoothctl disconnect E2:E7:79:99:53:58` (fine if it says not connected).
2. Find `ECO-WORTHY 0B_F6D7` (E2:E7:79:99:53:58), class **EcoWorthyBW02**.
   The settings should now open at once, with no *Fetching schema* wait.
3. **Battery ID**: `house`. Leave *Use GATT connection* on, polling
   frequency empty.
4. The paths should read `electrical.batteries.{batteryID}.…` with `cells.0.voltage`,
   `temperatures.0`, `rssi`. If an older saved entry shows `cell1.voltage`
   or `sensors.…RSSI`, delete the device entry and add it again.
5. Save and enable. Within a few seconds, **Data Browser** should show
   `electrical.batteries.house.voltage`, and the Energy app lights up.

## Three things that looked wrong

- **The status line under BT Sensors says `Initializing <MAC>`** for a
  stream of addresses. That is the plugin announcing every Bluetooth
  device it hears, every few seconds. It says nothing about the battery:
  the battery's own row in the device list does.
- **The settings page says "Enable plugin to see configuration" while the
  plugin is enabled.** BT Sensors only creates its web routes when it
  starts, and Signal K only mounts a plugin's routes once, when the server
  starts. Switch the plugin on after a server start and its page has
  nothing to talk to. Restart Signal K with the plugin on
  (`sudo systemctl restart signalk`). Whenever BT Sensors goes from off to
  on, restart the server after.
- **The Pi's own screen says NO BATTERY FEED while a laptop shows the
  bank.** The kiosk's browser was holding an expired Signal K login from
  using the admin page on the Pi (logins last an hour). Signal K refuses
  any stream that carries an invalid login, rather than treating it as
  an anonymous reader. The panel now clears that cookie by itself when it
  is refused, and reconnects. `panel-probe.js` here shows what the panel
  receives, with a clean profile and with the kiosk's own.

If nothing arrives, the plugin's debug log (enable debug for BT Sensors)
prints `no data; asking again` or `link dropped; reconnecting` every 15 s.

**To undo:** `cp ~/EcoWorthyBW02.js.orig $P/sensor_classes/EcoWorthyBW02.js`
and restart Signal K. **A plugin update overwrites the patch**, so re-copy
after one.

## Test

Runs the patched class inside the real plugin code against the frames
aiobmsble recorded from real packs (both layouts), with a fake pack that
stays silent until both unlock commands arrive:

```sh
mkdir /tmp/bts && (cd /tmp/bts && npm pack bt-sensors-plugin-sk@1.3.7 && tar xzf *.tgz \
  && cd package && npm install --omit=dev --ignore-scripts)
cd boat/bt-sensors           # from the repo root
cp EcoWorthyBW02.js /tmp/bts/package/sensor_classes/
node test/test-eco.js /tmp/bts/package          # 81 passed, 0 failed
```

Checked: the values match aiobmsble's expected results for protocols 1
and 2; wrong CRC, wrong type and a foreign MAC are rejected; problem codes
decode; empty cell slots stay unpublished; the schema loads without
connecting; a silent pack does not hang activation; the watchdog asks
again and reconnects; both write modes fall back; a refused connect or a
service discovery that never answers ends activation with an error and
is retried until data flows; a sensor stopped mid-reconnect stays
stopped. Seventeen deliberate breaks of the class (no CRC check, the
release's cell offset, Celsius, no discovery time limit, no stop flag,
…) are each caught.
