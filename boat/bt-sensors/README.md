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
node test/test-eco.js /tmp/bts/package          # 73 passed, 0 failed
```

Checked: the values match aiobmsble's expected results for protocols 1
and 2; wrong CRC, wrong type and a foreign MAC are rejected; problem codes
decode; empty cell slots stay unpublished; the schema loads without
connecting; a silent pack does not hang activation; the watchdog asks
again and reconnects; both write modes fall back. Twelve deliberate
breaks of the class (no CRC check, the release's cell offset, Celsius,
no watchdog, …) are each caught.
