#!/usr/bin/env python3
"""
What is actually driving the panel, and what can be done about its shape.

    python3 ~/helm/boot/check-display.py

Read-only. It starts nothing, stops nothing and changes nothing - the
point is to answer "X11 or Wayland, which output, which modes" BEFORE
anything reaches for xrandr or a boot config, because the two stacks have
nothing in common here and a wrong guess at the helm is a black screen.

Run it while the DESKTOP is up. It works over SSH as well as from the
session itself, and that is deliberate: over SSH there is no
WAYLAND_DISPLAY or DISPLAY to read, so the stack is identified by which
compositor is RUNNING rather than by this shell's environment. An env
check alone would report "neither" over SSH on a Pi that is plainly
running one.
"""
import glob
import os
import re
import shutil
import subprocess
import sys

W = 20


def run(argv, env=None, timeout=8):
    """(rc, stdout+stderr). Never raises."""
    e = dict(os.environ)
    if env:
        e.update(env)
    try:
        p = subprocess.run(argv, capture_output=True, text=True,
                           timeout=timeout, env=e)
        return p.returncode, (p.stdout + p.stderr).strip()
    except FileNotFoundError:
        return 127, argv[0] + ' is not installed'
    except subprocess.TimeoutExpired:
        return 124, argv[0] + ' timed out'
    except Exception as ex:
        return 1, str(ex)


def say(label, value):
    print('%-*s %s' % (W, label, value))


def block(title):
    print('\n== %s ==' % title)


def procs():
    """Which compositor or X server is up. By process, not by env."""
    rc, out = run(['ps', '-eo', 'comm='])
    names = set(out.split())
    return {n: (n in names) for n in
            ('Xorg', 'X', 'Xwayland', 'labwc', 'wayfire', 'sway', 'cage',
             'weston', 'mutter', 'kwin_wayland')}


def kms():
    """The panel as the kernel sees it. True whatever is on top of it."""
    found = []
    for d in sorted(glob.glob('/sys/class/drm/card*-*')):
        try:
            with open(os.path.join(d, 'status')) as f:
                status = f.read().strip()
        except Exception:
            continue
        modes = []
        try:
            with open(os.path.join(d, 'modes')) as f:
                modes = [m.strip() for m in f if m.strip()]
        except Exception:
            pass
        found.append((os.path.basename(d), status, modes))
    return found


def x_env():
    """Plausible ways to reach an X server from outside its session.

    Nothing here is a guess about WHICH display is right - each is tried
    and the one that answers is reported, so a failure says so instead of
    being silently mistaken for "X11 is not running"."""
    homes = ['/home/' + u for u in os.listdir('/home')] if os.path.isdir('/home') else []
    homes.append(os.path.expanduser('~'))
    out = []
    for disp in (':0', ':1'):
        out.append({'DISPLAY': disp})
        for h in homes:
            xa = os.path.join(h, '.Xauthority')
            if os.path.isfile(xa):
                out.append({'DISPLAY': disp, 'XAUTHORITY': xa})
    return out


def main():
    print('Confluence: what is driving the panel')

    block('this shell')
    say('WAYLAND_DISPLAY', os.environ.get('WAYLAND_DISPLAY') or '(unset)')
    say('DISPLAY', os.environ.get('DISPLAY') or '(unset)')
    say('XDG_SESSION_TYPE', os.environ.get('XDG_SESSION_TYPE') or '(unset)')
    if not os.environ.get('WAYLAND_DISPLAY') and not os.environ.get('DISPLAY'):
        print('   (empty is normal over SSH - the answer below comes from'
              ' what is RUNNING)')

    block('what is running')
    p = procs()
    up = [k for k, v in p.items() if v]
    say('compositor/server', ' '.join(up) if up else 'NOTHING GRAPHICAL')
    rc, out = run(['loginctl', 'show-seat', 'seat0', '-p', 'ActiveSession'])
    say('active session', out.split('=')[-1] if rc == 0 and '=' in out else '?')
    rc, out = run(['loginctl', 'list-sessions', '--no-legend'])
    if rc == 0 and out:
        for line in out.splitlines():
            say('  session', line.strip())

    block('tools present')
    for t in ('xrandr', 'wlr-randr', 'wayfire', 'labwc', 'swaymsg', 'kanshi',
              'cage', 'wlopm'):
        say(t, shutil.which(t) or '-')

    block('the panel, as the kernel sees it')
    ks = kms()
    if not ks:
        print('   nothing under /sys/class/drm - no KMS driver?')
    for name, status, modes in ks:
        say(name, status + ('   modes: ' + ', '.join(modes[:6]) if modes else ''))
        if len(modes) > 6:
            say('', '   ... and %d more' % (len(modes) - 6))

    block('X11: can anything drive it')
    if not shutil.which('xrandr'):
        print('   xrandr is not installed')
    else:
        done = False
        for env in x_env():
            rc, out = run(['xrandr', '--query'], env=env)
            if rc == 0 and 'connected' in out:
                say('reached', env.get('DISPLAY') + (
                    '  (via %s)' % env['XAUTHORITY'] if 'XAUTHORITY' in env else ''))
                for line in out.splitlines():
                    if ' connected' in line or line.startswith('Screen'):
                        print('   ' + line.strip())
                    elif re.match(r'^\s+\d+x\d+', line) and '*' in line:
                        print('   current mode:' + line.rstrip())
                done = True
                break
        if not done:
            print('   no X server answered on :0 or :1')
            print('   (expected if this is Wayland - see the verdict)')

    block('touch input')
    # The panel is a touchscreen, so this is half the answer to "why did
    # my tap land there". xrandr moves the OUTPUT; an absolute input
    # device still maps onto the whole framebuffer unless its Coordinate
    # Transformation Matrix is moved to match.
    if not shutil.which('xinput'):
        print('   xinput is not installed - the fit CANNOT move the touch')
        print('   mapping without it:  sudo apt install xinput')
    else:
        seen = False
        for env in x_env():
            rc, out = run(['xinput', 'list'], env=env)
            if rc != 0 or 'id=' not in out:
                continue
            seen = True
            for line in out.splitlines():
                mm = re.search(r'(.+?)\s+id=(\d+)\s+\[slave\s+pointer', line)
                if not mm:
                    continue
                did = mm.group(2)
                rc2, det = run(['xinput', 'list', did], env=env)
                mode = 'absolute' if re.search(r'Mode:\s*absolute', det or '',
                                               re.I) else 'relative'
                rc3, props = run(['xinput', 'list-props', did], env=env)
                ctm = '?'
                mp = re.search(r'Coordinate Transformation Matrix[^:]*:\s*(.+)',
                               props or '')
                if mp:
                    ctm = mp.group(1).strip()
                say(mm.group(1).strip().lstrip('\u23a3\u21b3 '),
                    '%s  id=%s' % (mode.upper(), did))
                say('', 'matrix: ' + ctm)
                if mode == 'absolute':
                    ident = all(abs(float(v) - w) < 1e-6 for v, w in
                                zip(ctm.split(','), (1, 0, 0, 0, 1, 0, 0, 0, 1))
                                ) if ctm.count(',') == 8 else None
                    if ident is False:
                        say('', '(not identity - something has remapped it)')
            break
        if not seen:
            print('   could not reach an X server to ask')

    block('Wayland: can anything drive it')
    if not shutil.which('wlr-randr'):
        print('   wlr-randr is not installed'
              '  (sudo apt install wlr-randr, on wlroots compositors)')
    else:
        rc, out = run(['wlr-randr'])
        print('   ' + (out.replace('\n', '\n   ') if out else '(no output)'))

    block('boot config')
    for f in ('/boot/firmware/cmdline.txt', '/boot/cmdline.txt'):
        if os.path.isfile(f):
            try:
                txt = open(f).read().strip()
            except Exception as e:
                txt = '(unreadable: %s)' % e
            say(f, txt)
            vid = re.findall(r'video=\S+', txt)
            say('  video=', ' '.join(vid) if vid else '(none set)')
    for f in ('/boot/firmware/config.txt', '/boot/config.txt'):
        if os.path.isfile(f):
            try:
                keep = [l.strip() for l in open(f)
                        if re.match(r'\s*(hdmi_|dtoverlay=vc4|framebuffer_|'
                                    r'display_|max_framebuffer)', l)]
            except Exception:
                keep = []
            say(f, '%d relevant lines' % len(keep))
            for l in keep:
                print('   ' + l)

    block('verdict')
    x11 = p['Xorg'] or p['X']
    wl = p['labwc'] or p['wayfire'] or p['sway'] or p['weston'] or p['kwin_wayland']
    if p['cage']:
        print('   cage is running - this is KIOSK mode, not desktop mode.')
        print('   Tap Desktop first, then run this again.')
    elif x11 and not wl:
        print('   X11. xrandr --transform can shrink the whole desktop and')
        print('   centre it, so all four corners land inside the circle,')
        print('   live and with no reboot.')
    elif wl:
        print('   Wayland (%s).' % ' '.join(k for k in ('labwc', 'wayfire', 'sway',
                                                        'weston', 'kwin_wayland') if p[k]))
        print('   wlr-randr has no transform, so a live centred letterbox is')
        print('   NOT available the way it is on X11. The honest route is a')
        print('   KMS margin in cmdline.txt, set once and applied at boot.')
        if p['Xwayland']:
            print('   (Xwayland is up, but it draws INTO the compositor -')
            print('    xrandr against it will not reshape the real output.)')
    else:
        print('   Nothing graphical is running, so there is nothing to')
        print('   measure. Start the desktop and run this again.')
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
