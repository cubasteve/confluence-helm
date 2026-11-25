#!/bin/bash
# =====================================================================
# Put the Confluence splash back if a package update took it away.
#
# Installed by install-splash-guard.sh as a root-owned copy at
# /usr/local/sbin/confluence-splash-guard, and run by apt after every
# dpkg run through /etc/apt/apt.conf.d/99confluence-splash.
#
# Why: a Raspberry Pi OS full-upgrade reset Plymouth's default theme to
# 'pix'. The Confluence theme files were still installed - only the
# choice was lost - so the fix is the one the installer already makes,
# plymouth-set-default-theme -R confluence, and the only question is
# when. After dpkg is done is the right moment: if a kernel update has
# just rebuilt the initramfs with pix in it, -R rebuilds it again with
# ours.
#
# The rules this lives by, because apt runs it as root on every
# install, upgrade and removal:
#   - never fail apt: every path exits 0
#   - silent when there is nothing to do, which is almost always
#   - never calls apt or dpkg, so it cannot recurse
#   - does nothing at all if plymouth is gone or the theme is gone -
#     uninstalling the theme is how you tell it to stop
#
# Only bash builtins plus plymouth-set-default-theme and logger, so a
# test can drive it with nothing but pretend tools on the PATH.
#
# CONFLUENCE_PLYMOUTH_THEMES overrides /usr/share/plymouth/themes for
# the tests. It only decides whether the theme looks installed.
# =====================================================================
THEME=confluence
THEMES="${CONFLUENCE_PLYMOUTH_THEMES:-/usr/share/plymouth/themes}"

main(){
  command -v plymouth-set-default-theme >/dev/null 2>&1 || return 0
  [ -f "$THEMES/$THEME/$THEME.plymouth" ] || return 0

  local now
  now="$(plymouth-set-default-theme 2>/dev/null)" || now=""
  [ "$now" = "$THEME" ] && return 0

  # Not called from a maintainer script, so update-initramfs would run
  # now anyway - but make sure it never defers itself to a dpkg trigger
  # that nothing is left to process.
  unset DPKG_MAINTSCRIPT_PACKAGE DPKG_MAINTSCRIPT_NAME

  # Rebuild EVERY kernel's initramfs, not just one. -R runs
  # update-initramfs -u, which updates only the highest kernel version -
  # and Raspberry Pi OS installs two, -rpi-v8 (Pi 4) and -rpi-2712 (Pi 5),
  # where v8 sorts higher. -R alone would leave the Pi 5's
  # initramfs_2712 showing raspberries while the theme reads confluence.
  local msg ok=1
  if command -v update-initramfs >/dev/null 2>&1; then
    plymouth-set-default-theme "$THEME" >/dev/null 2>&1 &&
      update-initramfs -u -k all >/dev/null 2>&1 && ok=0
  else
    plymouth-set-default-theme -R "$THEME" >/dev/null 2>&1 && ok=0
  fi
  if [ "$ok" = 0 ]; then
    msg="plymouth theme was '${now:-?}' after a package update; set back to $THEME (initramfs rebuilt)"
  else
    msg="plymouth theme is '${now:-?}' after a package update; FAILED to set it back to $THEME - run: sudo plymouth-set-default-theme $THEME \&\& sudo update-initramfs -u -k all"
  fi
  # One line in apt's output, because the initramfs rebuild is a long
  # pause and should not be a mystery, and one in the journal.
  echo "confluence-splash: $msg" >&2
  logger -t confluence-splash -- "$msg" >/dev/null 2>&1 || true
  return 0
}

main "$@" || true
exit 0
