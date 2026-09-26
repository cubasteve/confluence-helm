# The probes

These lived in a scratch directory and were lost the first time the
machine they were on went away. That is the whole argument for them
sitting in the repo beside the thing they test.

    bash tests/run.sh            all of them
    bash tests/run.sh race       one of them
    bash tests/run.sh sound      the netd one of that name

`run.sh` serves the working tree on :8080 unless something already
answers there, so a probe never quietly tests a stale deployed copy.
Screenshots land in a temp directory it prints at the end.

## The page

Playwright against Chromium, driving `confluence_helm.html` itself.
`helpers.mjs` is the shared rig: a booted page, the three things the app
talks to stubbed (Signal K aborted, netd on loopback, the club's
scoreboard), a gesture the judge believes, and the scoreboard the
probes count on.

| probe | what it holds to account |
|---|---|
| `smoke` | it boots, the dial draws, the pages and drawers are there |
| `gestures` | three fingers pages, one drags a drawer, the judge gets the capture phase |
| `race` | the countdown, the signals, the gun, the finish, and the one exit from a race |
| `racebox` | what the box reads before the start and on the leg |
| `marks` | a mark of your own: what the form takes, what it refuses, HERE |
| `markmove` | a club mark corrected from the boat, and the way back to the book |
| `course` | the sheet: taps, numbers, sides, CLEAR, EDIT, the line row |
| `demotrack` | the demo sails last season's race, at the wind that was blowing |
| `gpx` | the file parsed back, where the button sends it, and RACES |
| `score` | the card, what it posts, and the fallback when nothing answers |
| `held` | the race set aside between races, and the armed DISCARD |
| `persist` | everything stored, across a reload - and storage full of nonsense |
| `phone` | the page in a pocket: its GPS as an instrument, MOUNT, and what it never invents |
| `icons` | the home-screen set, and the page still working without any of it |
| `pick` | the menu the dial's readings and the course sheet's settings share: where it opens, what a tap on a row does, and the veil |

## The helper

`unittest`, no browser. Each case imports `netd.py` again with a
different environment and a `PATH` full of pretend tools, because that
is the only way to test a machine you are not sitting at.

| test | what it holds to account |
|---|---|
| `sound_test` | which sounder this Pi has, the tone itself, the pattern, and the pin never left high |
| `score_test` | the times the club's form takes, what goes over the wire, and the limits pointed at somebody else's server |
