# browser-scraper-mcp

MCP server that lets AI agents browse sites that block plain HTTP clients
(Twitter/X, Cloudflare-protected wikis, reddit, etc.), built on the recon
`browser-scraper` Docker image: a **real Chromium with a visible display**
(Xvfb + noVNC) and a **persistent profile** (cookies/logins survive restarts).

```
agent ⇄ stdio MCP (server.mjs) ⇄ HTTP API :7318 ⇄ Docker container recon-browser-mcp
                                                    ├─ Chromium (persistent /data/profile)
                                                    ├─ noVNC :6081 (user solves CAPTCHAs)
                                                    └─ captures → .state/captures/...
```

## Quick start

```bash
npm install
./bin/recon-browser.sh start    # optional: the MCP server autostarts the container
npm test                        # end-to-end smoke test over stdio
./bin/recon-browser.sh stop
```

First `build` reuses the browser-scraper image layers, so it is fast if the
skill's image already exists.

## MCP tools

| Tool | What it does |
| --- | --- |
| `browser_status` | Container/API health, ports, state dir |
| `browser_start` | `docker compose up -d --build` + wait for healthy |
| `browser_stop` | `docker compose down` (profile and captures persist) |
| `browser_scrape` | Navigate to URL, wait for JS/challenges, save artifacts; returns page text inline + `host_capture_dir`; auto-starts the container |
| `browser_capture` | Re-capture the current tab without navigating (use after the user solves a CAPTCHA in noVNC) |
| `browser_read` | Read `page.txt` / `page.html` / `links.json` / `metadata.json` / `screenshot.png` from any capture (default: latest), with offset paging |

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
    "recon-browser": {
      "type": "local",
      "command": ["node", "/home/gustavo/repos/reconlab/browser-scraper-mcp/server.mjs"],
      "enabled": true
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add recon-browser -- node /home/gustavo/repos/reconlab/browser-scraper-mcp/server.mjs
```

**Claude Desktop / other JSON-MCP clients** — same idea: run
`node .../browser-scraper-mcp/server.mjs` as a stdio server.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECON_BROWSER_API` | `http://127.0.0.1:7318` | Scraper API base URL |
| `RECON_BROWSER_VNC` | `http://127.0.0.1:6081/vnc.html?autoconnect=true` | noVNC URL shown to the user |
| `RECON_BROWSER_DIR` | `./container` | Compose project directory |
| `RECON_BROWSER_STATE` | `./.state` | Host dir for profile + captures |
| `RECON_BROWSER_API_PORT` / `RECON_BROWSER_VNC_PORT` | `7318` / `6081` | Host port bindings (set both here and in `*_API`/`*_VNC` when changing) |
| `RECON_BROWSER_START_TIMEOUT` | `300000` | ms to wait for build + healthy |

Ports deliberately differ from the recon-ps5 skill's container (7317/6080), so
both can run side by side.

## Layout

```
browser-scraper-mcp/
├── server.mjs            # MCP stdio server (the only thing agents launch)
├── bin/recon-browser.sh  # human CLI: start|status|scrape|capture|stop|logs
├── container/            # the Docker image + in-container HTTP API (from the skill)
│   ├── compose.yml  Dockerfile  entrypoint.sh  server.mjs  package.json
├── test/smoke.mjs        # MCP client smoke test (npm test)
└── .state/               # runtime: profile + captures (gitignored)
```

## Etiquette

Not a CAPTCHA-solver: if a site demands user interaction, a human finishes it
through noVNC. Keep request rates low — this is targeted research, not a
crawler. Respect authentication, rate limits, and site terms.
