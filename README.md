# browser-scraper-mcp

MCP server that lets AI agents browse sites that block plain HTTP clients
(Twitter/X, Cloudflare-protected wikis, reddit, etc.), built on the
`browser-scraper` Docker image: **real Chromium instances with a visible
display** (Xvfb + noVNC) and **named persistent profiles** — think of each
profile as a separate browser session with its own cookies, localStorage and
logins, switchable by name.

```
agent ⇄ stdio MCP (server.mjs) ⇄ HTTP API :7318 ⇄ Docker container browser-scraper-mcp
                                                    ├─ Chromium per profile (lazy, LRU-capped)
                                                    │    .state/profiles/<name>/ (cookies, localStorage…)
                                                    ├─ noVNC :6081 (user solves CAPTCHAs / logs in)
                                                    ├─ browser-scraper-tor (SOCKS5 :9050 + control :9051)
                                                    └─ captures → .state/captures/...
```

## Quick start

```bash
npm install
./bin/browser-scraper.sh start    # optional: the MCP server autostarts the container
npm test                        # end-to-end smoke test over stdio
./bin/browser-scraper.sh stop
```

First `build` reuses the browser-scraper image layers, so it is fast if the
skill's image already exists.

## MCP tools

| Tool | What it does |
| --- | --- |
| `browser_status` | Container/API health, ports, state dir |
| `browser_start` | `docker compose up -d --build` + wait for healthy |
| `browser_stop` | `docker compose down` (profiles and captures persist) |
| `browser_scrape` | Navigate the profile's Chromium to a URL, wait for JS/challenges, save artifacts; returns page text inline + `host_capture_dir`; auto-starts the container |
| `browser_capture` | Re-capture the profile's current tab without navigating (after solving a CAPTCHA or logging in via noVNC) |
| `browser_interact` | Ordered Playwright actions on the current page — `goto, click, fill, press, select, check, hover, scroll, wait_selector, wait_ms, eval` — ending in a full capture (search boxes, filters, pagination, JS checks) |
| `browser_profiles` | List named sessions: running?, cookie counts, last use — works even when the container is down |
| `browser_stop_profile` | Stop one profile's Chromium (cookies flush to disk; other sessions keep running) |
| `browser_read` | Read `page.txt` / `page.html` / `links.json` / `metadata.json` / `screenshot.png` from any capture (default: latest), with offset paging |
| `browser_tor_status` | Tor bootstrap %, circuit state, SOCKS URL |
| `browser_new_identity` | `SIGNAL NEWNYM`: rotate the Tor circuit → new exit IP |

## Interacting like a user

```
browser_interact { profile: "merca", steps: [
  { action: "goto",          url: "https://www.mercadolibre.com.ar/" },
  { action: "wait_selector", selector: "input.nav-search-input" },
  { action: "fill",          selector: "input.nav-search-input", value: "disco rigido 1tb barato" },
  { action: "press",         key: "Enter" },
  { action: "wait_selector", selector: ".ui-search-layout__item" }
]}
# → lands on the results listing; capture + page text come back in the same call
```

`eval` runs a JS expression in the page and returns its value in `step_results`
(useful to read state or extract data). All actions run in the profile's own
Chromium, so they use its session (and Tor mode when enabled).

### X/Twitter without a login

`x.com/search` and `/explore` force a login wall, but profile timelines are
readable via the public syndication endpoint — no browser, no wall:

```
curl https://syndication.twitter.com/srv/timeline-profile/screen-name/notnotzecoxao
```

The replies are Next.js: tweets live in the `__NEXT_DATA__` JSON blob
(`props.pageProps.timeline.entries[].content.tweet`, ~100 posts per account,
not strictly newest-first). Live search still wants a logged-in session —
log in once via noVNC (`test/x-login-retry.py` shows a CDP-driven retry loop
for when X rate-limits the login itself).

## Sessions (profiles)

Every scraping tool takes `profile` (default `"default"`). A profile is a real
Chromium user-data-dir under `.state/profiles/<name>/` — cookies, localStorage
and IndexedDB persist across container restarts, so **a login done once (by the
user, via noVNC) keeps working for the agent forever after**:

```
browser_scrape  { url: "https://x.com/home", profile: "x" }
# → 200 but logged-out? → user logs in at http://127.0.0.1:6081, then:
browser_capture { profile: "x" }            # now logged in, persisted
# ... days or container-restarts later:
browser_scrape  { url: "https://x.com/search?q=ps5", profile: "x" }  # still logged in
browser_scrape  { url: "https://www.psdevwiki.com/ps5/Vulnerabilities", profile: "wiki" }
browser_profiles {}                          # see what sessions exist
```

One Chromium process runs per active profile (lazy start, max 4 by default,
LRU-evicted; each window is visible in noVNC). Stop idle sessions with
`browser_stop_profile`; they resume from disk later. Chromium instances only
exit cleanly via CDP `Browser.close` (they ignore SIGTERM), which is what the
server does on stop so cookies always flush.

## Tor (proxy + rotating identity)

A second service in the compose file runs a minimal Tor (SOCKS5 on `tor:9050`,
control port `9051`, password over `TOR_CONTROL_PASSWORD`). Scraping
through it is a per-request flag:

```
browser_scrape  { url: "https://x.com/search?q=ps5", profile: "x", tor: true }
browser_tor_status {}                     # bootstrap 100 / circuit established?
browser_scrape  { url: "https://check.torproject.org/api/ip", tor: true }
#   → {"IsTor":true,"IP":"192.42.116.42"}
browser_new_identity {}                   # SIGNAL NEWNYM
browser_scrape  { url: "https://api.ipify.org?format=json", tor: true }
#   → {"ip":"80.67.167.81"}   ← new exit IP
```

Details that matter:

- `tor` is per **profile** and sticky: once set it persists (even across
  container restarts, via a mode marker in the profile dir). Omitting `tor`
  keeps the profile's current mode; toggling it restarts that profile's
  Chromium transparently — cookies/localStorage survive, only the process
  rebinds with/without `--proxy-server=socks5://tor:9050`.
- Chromium resolves hostnames through SOCKS (no local DNS leak) and `.onion`
  sites work in the same browsers.
- `browser_new_identity` rotates the shared Tor proxy, so all profiles
  currently in tor mode get the new circuit; in-flight requests may finish on
  the old exit.
- Tor state/descriptors persist under `.state/tor/` (faster bootstrap).

Each capture writes `page.html`, `page.txt`, `links.json`, `screenshot.png`
and `metadata.json` under `.state/captures/<timestamp>-<host>-<path>/`, so
research stays auditable. `blocked: true` in the result means a challenge was
detected: send the user to the `vnc_url`, then call `browser_capture`.

## Wire it into your agents

Any MCP-capable agent works, since the server is a plain stdio Node process.

**OpenCode** (`opencode.json`):

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", "/path/to/browser-scraper-mcp/server.mjs"],
      "enabled": true
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add browser -- node /path/to/browser-scraper-mcp/server.mjs
```

**Claude Desktop / other JSON-MCP clients** — same idea: run
`node .../browser-scraper-mcp/server.mjs` as a stdio server.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_MCP_API` | `http://127.0.0.1:7318` | Scraper API base URL |
| `BROWSER_MCP_VNC` | `http://127.0.0.1:6081/vnc.html?autoconnect=true` | noVNC URL shown to the user |
| `BROWSER_MCP_DIR` | `./container` | Compose project directory |
| `BROWSER_MCP_STATE` | `./.state` | Host dir for profile + captures |
| `BROWSER_MCP_API_PORT` / `BROWSER_MCP_VNC_PORT` | `7318` / `6081` | Host port bindings (set both here and in `*_API`/`*_VNC` when changing) |
| `BROWSER_MCP_START_TIMEOUT` | `300000` | ms to wait for build + healthy |
| `VNC_PASSWORD` | *(unset)* | (in-container) when set, x11vnc requires this RFB login; unset = `-nopw` (fine when the port is bound to 127.0.0.1) |
| `BROWSER_MCP_HTTP_PORT` | *(unset)* | When set, serve MCP over Streamable HTTP on this port (`POST/GET/DELETE /mcp`, `GET /health`) instead of stdio |
| `BROWSER_MCP_MANAGED` | `docker` | `remote` = container is platform-managed (K8s): no docker compose calls, `ensureStarted` only waits for `/health` |
| `TOR_PROXY` | `socks5://tor:9050` | SOCKS proxy Chromium uses for tor=true (must be `socks5://` — Chromium has no `socks5h` scheme; it resolves via the proxy anyway) |
| `TOR_CONTROL_PASSWORD` | `browserrotator` | Tor control port password (NEWNYM auth) |
| `MAX_ACTIVE_PROFILES` | `4` | (in-container) concurrent Chromium sessions before LRU eviction |

Ports deliberately differ from the upstream scraper container (7317/6080), so
both can run side by side.

## Layout

```
browser-scraper-mcp/
├── server.mjs            # MCP server (stdio by default; HTTP with BROWSER_MCP_HTTP_PORT)
├── bin/browser-scraper.sh  # human CLI: start|status|scrape|capture|stop|logs
├── container/            # the Docker images + in-container HTTP API
│   └── compose.yml  Dockerfile  entrypoint.sh  server.mjs  package.json
│       tor.Dockerfile  tor-entrypoint.sh   # minimal Tor (SOCKS + control port)
├── test/{smoke,http,full}.mjs # MCP client tests (npm test)
└── .state/               # runtime: profiles, tor state, captures (gitignored)
```

## Serving MCP over HTTP (shared / remote instance)

Instead of one stdio process per agent, one instance can serve many agents over
Streamable HTTP: set `BROWSER_MCP_HTTP_PORT` (serves `POST/GET/DELETE
/mcp` + `GET /health`, one session per client) and run it next to the container
— same machine, or a pod sharing the state volume — with
`BROWSER_MCP_MANAGED=remote` so the MCP process never touches docker compose
and just trusts the platform to keep the API healthy. Put a reverse proxy with
authentication in front: the browser keeps logged-in profiles, and whoever can
drive the MCP (or noVNC) can drive those sessions.

Any Streamable-HTTP MCP client attaches with:

```json
{
  "mcp": {
    "browser": {
      "type": "remote",
      "url": "https://<mcp-host>/mcp",
      "enabled": true,
      "headers": { "Authorization": "Basic <base64 user:pass>" }
    }
  }
}
```

Images: `ghcr.io/<user>/tools/browser-scraper-mcp:{browser,tor}-<version>`,
built from this repo with `docker buildx --platform linux/amd64` (the browser
image also ships `/app/mcp-server.mjs`, this file, for the MCP process).
Our cluster instance — real hostnames, URLs and auth users — is documented in
the private infra repo (`apps/browser-scraper/`).

## Etiquette

Not a CAPTCHA-solver: if a site demands user interaction, a human finishes it
through noVNC. Keep request rates low — this is targeted research, not a
crawler. Respect authentication, rate limits, and site terms.
