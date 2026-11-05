#!/usr/bin/env bash
# Minimal Tor with a SOCKS proxy (for Chromium) and a password-authenticated
# control port (for NEWNYM identity rotation from the scraper server).
set -euo pipefail

PASSWORD="${TOR_CONTROL_PASSWORD:-reconrotator}"
HASHED="$(tor --hash-password "$PASSWORD" | tail -n 1)"

# Keep bash as init and run tor as a child so the stop signal is forwarded and
# bash waits for tor to flush its state before exiting (a SIGKILLed tor can
# leave half-written cached-microdescs that hang the next boot at 0%).
tor \
  --DataDirectory /var/lib/tor \
  --SocksPort 0.0.0.0:"${TOR_SOCKS_PORT:-9050}" \
  --ControlPort 0.0.0.0:"${TOR_CONTROL_PORT:-9051}" \
  --HashedControlPassword "$HASHED" \
  --SafeSocks 0 &
tor_pid=$!

trap 'kill -TERM "$tor_pid" 2>/dev/null || true' TERM INT

status=0
wait "$tor_pid" || status=$?
# After a forwarded TERM, give tor a moment to finish flushing before exit.
for _ in 1 2 3 4 5; do
  kill -0 "$tor_pid" 2>/dev/null || break
  sleep 1
done
exit "$status"
