# The route chart

A faint chart with the route you are sailing, in the left of the dial.

[← back to the README](../README.md)

![The route chart, day, on a leg](img/chart-day.png)

## What it is

When a route is active in Signal K, the empty sector of the dial between
the bezel's 60–120 and the SOG digits shows the corner of a chart, the
way a car shows a corner of the map beside its speed. It is heading-up
and the boat sits low and right in it, just clear of the digits, so the
leg ahead runs up and away into the fade.

It draws, and that is all it does:

- the chart itself, one silhouette in the theme's ink (red at night,
  like everything else)
- the leg behind you, dotted, and the rest of the route ahead, fainter
- the active leg, from the boat to the next waypoint, and a ring on it
- near a turn, a short stub of the next leg, so you can see which way it
  goes
- the boat

There is **no text on it at all** — no waypoint name, no distance, no
turn. The dial already has readings, and a name or a number in this
corner is one more thing to tell apart from them at a glance. The chart
is a picture of where you are going, not a reading. Even the NOAA chart
under it is fetched with its words turned off: no place names, no light
descriptions, no soundings.

It is deliberately quiet. The chart image is at .40 by day, .38 at dusk
and .44 at night, and every mark on it is a thin stroke well short of
full strength, so it loses to every reading on the glass. With no route
the dial is exactly the dial it was — the probe checks that pixel for
pixel.

The scale follows the next waypoint: it sits about 150 px from the boat
on a leg, and is brought in to 120 near a turn so the next leg, which
after a right turn heads up and right, stays clear of the clock's +. A
waypoint more than a few miles off is past the edge, and the leg simply
runs out into the fade.

Where a wind mark comes round onto the left of the bezel the chart gives
way under it — a soft hole that follows the mark — so the wind is never
read through a chart.

![Near a turn, at night](img/chart-night.png)

### What it is not

It has nothing to do with the race course. The marks, the start line
and the course page are the panel's own, and they never appear here; a
route here is never a course there. Two features that happen to both
have waypoints.

It is not a chart plotter either. Freeboard-SK is the chart plotter;
this is the glance at it you can take from the helm.

## Where the route comes from

**Freeboard-SK.** Plan a route, then *Activate* it (or *Go to* a
waypoint). Freeboard does that through Signal K's **course API**, and the
server publishes the result as deltas, which the panel subscribes to on
the socket it already has open:

| path | what it carries |
|---|---|
| `navigation.course.activeRoute` | the route's `href`, `pointIndex`, `reverse` |
| `navigation.course.nextPoint` | the point being steered for |
| `navigation.course.previousPoint` | where the leg started |
| `navigation.courseGreatCircle.activeRoute.href`, `.nextPoint.position`, `.previousPoint.position` | the same, on the old v1 paths, for a server older than the v2 API |

(These are read off `emitCourseInfo` in signalk-server's
`src/api/course`, not remembered.) On every connect the panel also asks
`GET /signalk/v2/api/vessels/self/navigation/course` once, so a route
activated before the panel came up is there straight away.

The route's **shape** is not in the deltas — only which point is next.
The panel fetches it once from
`/signalk/v2/api/resources/routes/<id>` (a GeoJSON LineString), which
means the server needs a **resources provider** for routes: the built-in
*Resources Provider* plugin, enabled in *Server → Plugin Config*.
Freeboard-SK can't save a route without it either, so if you can plan
one you already have it.

The server's own rule for a reversed route is followed: the index counts
along the order the boat sails, so on a reversed route point 0 is the
route's last point. On the first leg the leg starts where the boat was
when the route was activated, not at a point of the route.

A **go-to waypoint** has no route behind it, so it draws one leg.

If anything is missing it is not an error:

- no active route, no fix → no chart, and the dial is untouched
- the route resource 404s (no resources plugin, the route deleted) → the
  leg the course API says you are steering still draws; the rest of the
  route doesn't. It is asked again after a minute, not every second.
- a server without the v2 API → the v1 paths are used, with the next
  point found on the route by position

## The one Signal K setting

The panel is served by `netd` on `:8090` and Signal K is on `:3000`, so
the two GETs above are cross-origin. Signal K's default answers that:
with **Allowed CORS origins** (*Security → Settings*) left empty, the
server replies to every origin. The panel sends no cookie with these
requests, which is both what lets that reply count and what keeps a
stale admin login out of it — with `allow_readonly` on, an anonymous
GET reads; a request carrying an expired login is refused (see
`skHeal` in the page).

**If you have filled in Allowed CORS origins**, add the panel's own
origins to it, or set it to `*`:

```
http://localhost:8090, http://<boat's address>:8090
```

— the first for the kiosk, the second for phones and laptops on the
boat's WiFi. Without that the deltas still arrive over the socket, so
the active leg still draws; only the rest of the route is missing.

Nothing is proxied through `netd` for this, on purpose: its page server
is read-only, and a CORS setting is the server's own business.

## The chart under the route

The chart is NOAA's ENC service (the electronic navigational charts,
rendered by their Maritime Chart Service):

```
https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer/export
```

It answers cross-origin requests from any page, so the panel asks it
directly. US waters only — elsewhere the route draws on clean glass.

One 1024 px image is fetched around the boat at a power-of-two scale and
moved under the route as the boat sails. A new one is fetched only when
the boat nears the edge of what it covers, or the scale has changed by a
whole level; until it arrives the old one stays up.

**Offline.** Every image is kept in IndexedDB, in the same `tilecache`
store the Tracks map uses, under keys of its own (`cht/<level>/<x>/<y>`)
and under the same oldest-first trim. So a lake you have looked at once
with a signal has its chart every time after without one. Offline and
never been here, it looks for a coarser picture of the same water it
has kept; failing that the route draws on clean glass, and the dead
network is not asked again for a minute.

### What it costs the Pi

- **Nothing while the dial is covered.** The chart is driven from the
  dial's own draw step, which does not run while a drawer, an app or
  the screensaver is up.
- **One check a second** with no route.
- **At most one repaint a second** with one, and only when the picture
  would move — a boat at rest at the dock repaints nothing.
- **No filter.** NOAA's colours are reduced to the ink silhouette once
  per image (and once per theme change) on a canvas, with the strength
  painted into its alpha. Each repaint after that is a transform.
- **A small box.** Everything the chart paints is clipped to the sector,
  so the SOG digits redrawing twenty times a second just to the right
  of it never make it repaint.

## The demo

With no Signal K at all — a laptop, say — the demo sail has a route of
its own, a waypoint every fifteen minutes of the sail, so the feature
can be seen. It only appears while the demo is playing the boat's
position **and** no Signal K socket has ever opened in that session; on
the boat Signal K answers within seconds of boot, and from then on a
route here is only ever one somebody planned.

## Tests

`tests/chart.mjs` — no route is pixel-identical (day, dusk, night, and
after a route has come and gone); no text in it; the course API's index
and direction, v2 and v1, go-to, a 404 and a server without the API;
the deltas arriving over a real socket; the wind holes; wide speeds
measured off the glass; the night ink and strength; the offline cache;
and nothing done while the dial is covered.
