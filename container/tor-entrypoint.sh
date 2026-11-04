#!/usr/bin/env bash
# Minimal Tor with a SOCKS proxy (for Chromium) and a password-authenticated
# control port (for NEWNYM identity rotation from the scraper server).
set -euo pipefail

PASSWORD="${TOR_CONTROL_PASSWORD:-reconrotator}"
HASHED="$(tor --hash-password "$PASSWORD" | tail -n 1)"

exec tor \
  --DataDirectory /var/lib/tor \
  --SocksPort 0.0.0.0:"${TOR_SOCKS_PORT:-9050}" \
  --ControlPort 0.0.0.0:"${TOR_CONTROL_PORT:-9051}" \
  --HashedControlPassword "$HASHED" \
  --SafeSocks 0
