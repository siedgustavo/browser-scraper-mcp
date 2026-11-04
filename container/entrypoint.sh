#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/home /data/profiles /data/captures
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb "${DISPLAY}" -screen 0 1440x1000x24 -ac +extension GLX +render -noreset &
sleep 1
openbox-session &
x11vnc -display "${DISPLAY}" -forever -shared -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

# Chromium instances are launched on demand by server.mjs, one per named profile.
exec node /app/server.mjs
