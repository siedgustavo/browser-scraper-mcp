#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/home /data/profile /data/captures
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /data/profile/SingletonCookie /data/profile/SingletonLock /data/profile/SingletonSocket

Xvfb "${DISPLAY}" -screen 0 1440x1000x24 -ac +extension GLX +render -noreset &
sleep 1
openbox-session &
x11vnc -display "${DISPLAY}" -forever -shared -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

/ms-playwright/chromium-1187/chrome-linux/chrome \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/data/profile \
  --window-size=1400,920 \
  --window-position=20,40 \
  about:blank >/tmp/chromium.log 2>&1 &

exec node /app/server.mjs
