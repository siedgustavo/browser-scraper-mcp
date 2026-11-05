#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/home /data/profiles /data/captures
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# noVNC auth: VNC_PASSWORD set -> RFB login (x11vnc -rfbauth); unset -> -nopw
# (localhost dev via compose keeps the zero-friction behavior).
if [ -n "${VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.x11vnc.pass >/dev/null 2>&1 || exit 1
  chmod 600 /tmp/.x11vnc.pass
  X11VNC_AUTH=(-rfbauth /tmp/.x11vnc.pass)
else
  X11VNC_AUTH=(-nopw)
fi

Xvfb "${DISPLAY}" -screen 0 1440x1000x24 -ac +extension GLX +render -noreset &
sleep 1
openbox-session &
x11vnc -display "${DISPLAY}" -forever -shared "${X11VNC_AUTH[@]}" -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

# Chromium instances are launched on demand by server.mjs, one per named profile.
exec node /app/server.mjs
