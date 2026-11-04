#!/usr/bin/env bash
# CLI helper for the recon-browser-mcp Docker container (mirrors the MCP tools).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_DIR="$ROOT/container"
export BROWSER_SCRAPER_STATE="${BROWSER_SCRAPER_STATE:-$ROOT/.state}"
API="${RECON_BROWSER_API:-http://127.0.0.1:7318}"
VNC="${RECON_BROWSER_VNC:-http://127.0.0.1:6081/vnc.html?autoconnect=true}"
COMPOSE=(docker compose --project-directory "$CONTAINER_DIR" -f "$CONTAINER_DIR/compose.yml")

usage() {
  cat <<'EOF'
Usage:
  recon-browser.sh start              # docker compose up -d --build (+ wait healthy)
  recon-browser.sh status
  recon-browser.sh scrape URL [--selector CSS] [--wait-seconds N]
  recon-browser.sh capture [--selector CSS]
  recon-browser.sh stop               # docker compose down
  recon-browser.sh logs
EOF
}

wait_until_ready() {
  for _ in $(seq 1 180); do
    if curl --silent --fail "$API/health" >/dev/null; then return 0; fi
    sleep 1
  done
  echo "Scraper did not become ready; inspect logs with: $0 logs" >&2
  return 1
}

start() {
  mkdir -p "$BROWSER_SCRAPER_STATE"
  "${COMPOSE[@]}" up -d --build
  wait_until_ready
  echo "Scraper API:  $API"
  echo "Interactive:  $VNC"
  echo "State:        $BROWSER_SCRAPER_STATE"
}

request() {
  local endpoint="$1"; shift
  curl --silent --show-error --fail-with-body --request POST "$API/$endpoint" "$@"
  echo "Host captures: $BROWSER_SCRAPER_STATE/captures" >&2
}

command="${1:-}"
case "$command" in
  start) start ;;
  stop) "${COMPOSE[@]}" down ;;
  logs) "${COMPOSE[@]}" logs --no-color --tail 200 browser ;;
  status)
    "${COMPOSE[@]}" ps
    curl --silent --show-error --fail "$API/health" || true
    ;;
  scrape)
    url="${2:-}"; [[ -n "$url" ]] || { usage >&2; exit 2; }
    shift 2
    args=(--data-urlencode "url=$url")
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --selector) args+=(--data-urlencode "selector=$2"); shift 2 ;;
        --wait-seconds) args+=(--data-urlencode "wait_seconds=$2"); shift 2 ;;
        *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
      esac
    done
    request scrape "${args[@]}"
    ;;
  capture)
    shift
    args=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --selector) args+=(--data-urlencode "selector=$2"); shift 2 ;;
        *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
      esac
    done
    request capture "${args[@]}"
    ;;
  *) usage >&2; exit 2 ;;
esac
