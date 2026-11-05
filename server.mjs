#!/usr/bin/env node
// browser-scraper-mcp: MCP front-end for the browser-scraper Docker scraper.
// The Docker container runs visible Chromium instances (Xvfb + noVNC), one per
// named persistent profile, with an HTTP API. This server lets agents scrape
// blocked sites, keep logins/cookies isolated per named session (profile), and
// read the captured artifacts directly from the host filesystem.
//
// Transports: stdio (default, what agents launch locally) or Streamable HTTP
// (set BROWSER_MCP_HTTP_PORT; serves POST/GET/DELETE /mcp + GET /health).
// Set BROWSER_MCP_MANAGED=remote when the container is managed externally
// (e.g. Kubernetes): no docker compose calls, just health checks against the API.

import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER_DIR = process.env.BROWSER_MCP_DIR || path.join(ROOT, "container");
const STATE_DIR = process.env.BROWSER_MCP_STATE || path.join(ROOT, ".state");
const API_URL = (process.env.BROWSER_MCP_API || "http://127.0.0.1:7318").replace(/\/$/, "");
const VNC_URL = process.env.BROWSER_MCP_VNC || "http://127.0.0.1:6081/vnc.html?autoconnect=true";
const START_TIMEOUT_MS = Number(process.env.BROWSER_MCP_START_TIMEOUT || 300000);
// "docker" (default): this process starts/stops the container via compose.
// "remote": the platform (Kubernetes) owns the container; we only probe /health.
const MANAGED = (process.env.BROWSER_MCP_MANAGED || "docker").trim().toLowerCase();
// When set, serve MCP over Streamable HTTP on this port instead of stdio.
const MCP_HTTP_PORT = process.env.BROWSER_MCP_HTTP_PORT ? Number(process.env.BROWSER_MCP_HTTP_PORT) : null;

const ARTIFACT_FILES = ["page.txt", "page.html", "links.json", "metadata.json", "screenshot.png"];

// ---------- helpers ----------

function log(message) {
  process.stderr.write(`[browser-scraper-mcp] ${message}\n`);
}

function run(command, args, { cwd = CONTAINER_DIR, timeoutMs = 0, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${(stderr || stdout).slice(-2000)}`));
    });
  });
}

const compose = (args, options) =>
  run("docker", ["compose", "--project-directory", CONTAINER_DIR, ...args], {
    ...options,
    // Force the absolute state dir so in-container host_capture_dir paths resolve on the host.
    env: { ...process.env, BROWSER_SCRAPER_STATE: STATE_DIR }
  });

async function health(timeoutMs = 3000) {
  try {
    const response = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await health();
    if (ok) return ok;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Scraper did not become healthy at ${API_URL}; check 'browser_status' or container logs`);
}

let startingPromise = null;

async function ensureStarted() {
  const current = await health();
  if (current) return { started: false, health: current };
  if (MANAGED === "remote") {
    // The platform keeps the API up; wait for it instead of running compose.
    return { started: true, health: await waitHealthy(START_TIMEOUT_MS) };
  }
  if (!startingPromise) {
    startingPromise = (async () => {
      await fs.mkdir(STATE_DIR, { recursive: true });
      log("container not reachable, running docker compose up -d --build ...");
      await compose(["-f", path.join(CONTAINER_DIR, "compose.yml"), "up", "-d", "--build"], { timeoutMs: START_TIMEOUT_MS });
      return waitHealthy(START_TIMEOUT_MS);
    })().finally(() => { startingPromise = null; });
  }
  return { started: true, health: await startingPromise };
}

async function getJson(endpoint, timeoutMs = 15000) {
  const response = await fetch(`${API_URL}${endpoint}`, { signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function postForm(endpoint, params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  }
  const response = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(180000)
  });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

// Capture dirs are reported from inside the container (/data/captures/...).
// Map them back to the host state directory so the agent can read artifacts.
function toHostPath(captureDir, hostCaptureDir) {
  if (hostCaptureDir && path.isAbsolute(hostCaptureDir)) return hostCaptureDir;
  const name = path.basename(hostCaptureDir || captureDir || "");
  return name ? path.join(STATE_DIR, "captures", name) : null;
}

async function readText(filePath, maxChars, offset = 0) {
  const raw = await fs.readFile(filePath, "utf8");
  const text = raw.slice(offset, offset + maxChars);
  return {
    file: filePath,
    chars_total: raw.length,
    offset,
    returned: text.length,
    truncated: offset + text.length < raw.length,
    text
  };
}

async function latestCaptureDir() {
  const capturesRoot = path.join(STATE_DIR, "captures");
  const entries = await fs.readdir(capturesRoot, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory());
  const stats = await Promise.all(dirs.map(async (entry) => {
    const full = path.join(capturesRoot, entry.name);
    const { mtimeMs } = await fs.stat(full).catch(() => ({ mtimeMs: 0 }));
    return { name: entry.name, full, mtimeMs };
  }));
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0]?.full || null;
}

async function enrichScrapeResult(payload, maxChars) {
  const hostDir = toHostPath(payload.capture_dir, payload.host_capture_dir);
  const result = { ...payload, host_capture_dir: hostDir, vnc_url: VNC_URL };
  if (hostDir) {
    try {
      const page = await readText(path.join(hostDir, "page.txt"), maxChars);
      result.text = page.text;
      result.text_truncated = page.truncated;
      result.text_chars_total = page.chars_total;
    } catch {
      result.text = null;
    }
  }
  if (result.blocked) {
    result.user_action = `Site looks challenged/blocked. Ask the user to open ${VNC_URL}, solve it in the open tab, then call browser_capture.`;
  }
  return result;
}

function jsonContent(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// ---------- server ----------

// One McpServer per session: stdio uses a single instance; HTTP creates a new
// one on every initialize so several agents can share the same scraper API.
function buildServer() {
  const server = new McpServer({ name: "browser", version: "1.0.0" });
  
  server.registerTool("browser_status", {
    title: "Browser status",
    description: "Check whether the browser-scraper Docker container and its scraper API are running.",
    inputSchema: {}
  }, async () => {
    const alive = await health();
    const ps = MANAGED === "remote" ? [] : await compose(["-f", path.join(CONTAINER_DIR, "compose.yml"), "ps", "--format", "json"])
      .then(({ stdout }) => stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)))
      .catch(() => []);
    const tor = alive ? await getJson("/tor_status", 6000).catch(() => null) : null;
    return jsonContent({
      api_url: API_URL,
      running: Boolean(alive),
      managed: MANAGED,
      health: alive,
      tor,
      containers: ps.map((entry) => ({ name: entry.Name, service: entry.Service, state: entry.State, status: entry.Status })),
      vnc_url: VNC_URL,
      state_dir: STATE_DIR
    });
  });
  
  server.registerTool("browser_start", {
    title: "Start browser container",
    description: "Start (building on first use) the browser-scraper Docker container. Chromium instances launch on demand per named profile; profiles and captures persist in the host state directory. Waits until the scraper API is healthy.",
    inputSchema: {}
  }, async () => {
    const outcome = await ensureStarted();
    return jsonContent({ started: outcome.started, already_running: !outcome.started, health: outcome.health, vnc_url: VNC_URL, state_dir: STATE_DIR });
  });
  
  server.registerTool("browser_stop", {
    title: "Stop browser container",
    description: "Stop and remove the browser-scraper Docker container. Named browser profiles (cookies/logins) and captures persist in the host state directory.",
    inputSchema: {}
  }, async () => {
    if (MANAGED === "remote") {
      return jsonContent({ stopped: false, note: `API ${API_URL} is platform-managed (BROWSER_MCP_MANAGED=remote); scale the workload down to stop it.`, state_dir: STATE_DIR });
    }
    await compose(["-f", path.join(CONTAINER_DIR, "compose.yml"), "down"]);
    return jsonContent({ stopped: true, api_url: API_URL, state_dir: STATE_DIR });
  });
  
  server.registerTool("browser_scrape", {
    title: "Scrape URL with real browser",
    description:
      "Navigate the persistent Chromium (inside Docker, behind noVNC) to an http(s) URL, wait for JS/challenges to settle, and save artifacts " +
      "(page.html, page.txt, links.json, screenshot.png, metadata.json). Returns page text inline (truncated) plus the host capture directory. " +
      "Pass a named 'profile' to keep cookies/logins per site or account (e.g. profile='x' for logged-in X sessions); logins done once via noVNC persist across restarts. " +
      "If 'blocked' is true, ask the user to solve the challenge via the vnc_url and then call browser_capture. Starts the container automatically when needed.",
    inputSchema: {
      url: z.string().describe("Absolute http(s) URL to open"),
      profile: z.string().optional().describe("Named persistent session (cookies/logins isolated per name). Default 'default'"),
      tor: z.boolean().optional().describe("Route this profile through the bundled Tor proxy (new exit IP after browser_new_identity). Omit to keep the profile's current mode; changing it restarts the profile's Chromium preserving the session"),
      click: z.string().optional().describe("Optional CSS selector to click after load (e.g. a soft 'Continuar' challenge button); then re-waits and captures the result"),
      selector: z.string().optional().describe("Optional CSS selector to wait for (client-rendered pages)"),
      wait_seconds: z.number().int().min(1).max(120).optional().describe("Max seconds to wait for settling (default 20)"),
      max_chars: z.number().int().min(500).max(50000).optional().describe("Max characters of page.txt to return inline (default 6000)")
    }
  }, async ({ url, profile, tor, click, selector, wait_seconds, max_chars }) => {
    await ensureStarted();
    const payload = await postForm("/scrape", {
      url, profile, selector, wait_seconds, click,
      proxy: tor === undefined ? undefined : tor ? "tor" : "direct"
    });
    return jsonContent(await enrichScrapeResult(payload, max_chars ?? 6000));
  });
  
  server.registerTool("browser_capture", {
    title: "Capture current tab",
    description:
      "Save artifacts from the tab currently open in the given profile's Chromium without navigating away. Use right after the user finishes a CAPTCHA/challenge or a login in noVNC. " +
      "Also useful to re-read a page that is already loaded.",
    inputSchema: {
      profile: z.string().optional().describe("Named persistent session to capture (default 'default')"),
      tor: z.boolean().optional().describe("Route this profile through Tor (see browser_scrape)"),
      selector: z.string().optional().describe("Optional CSS selector to wait for before capturing"),
      max_chars: z.number().int().min(500).max(50000).optional().describe("Max characters of page.txt to return inline (default 6000)")
    }
  }, async ({ profile, tor, selector, max_chars }) => {
    await ensureStarted();
    const payload = await postForm("/capture", {
      profile, selector,
      proxy: tor === undefined ? undefined : tor ? "tor" : "direct"
    });
    return jsonContent(await enrichScrapeResult(payload, max_chars ?? 6000));
  });
  
  server.registerTool("browser_tor_status", {
    title: "Tor proxy status",
    description:
      "Check the bundled Tor: bootstrap progress, circuit state and SOCKS proxy URL. Scrape with tor=true once bootstrap reaches 100. " +
      "Tip: browser_scrape url=https://check.torproject.org/api/ip tor=true verifies the exit path end-to-end.",
    inputSchema: {}
  }, async () => {
    await ensureStarted();
    return jsonContent(await getJson("/tor_status"));
  });
  
  server.registerTool("browser_new_identity", {
    title: "Rotate Tor identity (NEWNYM)",
    description:
      "Ask Tor for a new circuit (SIGNAL NEWNYM): subsequent tor=true requests appear from a different exit IP. Rotates the shared Tor proxy, i.e. all " +
      "profiles routing through tor get the new identity. Old established circuits may finish their current request on the previous IP.",
    inputSchema: {}
  }, async () => {
    await ensureStarted();
    const result = await postForm("/tor_new_identity", {});
    return jsonContent({ ...result, verify_with: "browser_scrape url=https://check.torproject.org/api/ip tor=true" });
  });
  
  server.registerTool("browser_profiles", {
    title: "List persistent browser profiles",
    description:
      "List named browser sessions (profiles) on disk and running: cookie counts, last use, current tab, and host dir. Use it to discover existing logins " +
      "before deciding to reuse or create a profile, and after restarts to confirm sessions survived. Works even when the container is stopped (lists on-disk profiles).",
    inputSchema: {}
  }, async () => {
    const alive = await health();
    if (!alive) {
      const profilesRoot = path.join(STATE_DIR, "profiles");
      const names = (await fs.readdir(profilesRoot, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      return jsonContent({
        container_running: false,
        profiles: names.map((name) => ({ name, running: false, on_disk: true })),
        note: `Container is down; ${names.length} profile(s) persist under ${profilesRoot} and will be available on next start.`
      });
    }
    const payload = await getJson("/profiles");
    return jsonContent({ container_running: true, vnc_url: VNC_URL, ...payload });
  });
  
  server.registerTool("browser_stop_profile", {
    title: "Stop one browser profile",
    description:
      "Stop the Chromium instance for one named profile without touching the container or other sessions. Cookies flush to disk; the session persists and can be resumed later.",
    inputSchema: {
      profile: z.string().describe("Named persistent session to stop")
    }
  }, async ({ profile }) => {
    await ensureStarted();
    return jsonContent(await postForm("/profile_stop", { profile }));
  });
  
  server.registerTool("browser_interact", {
    title: "Interact with the page (Playwright actions)",
    description:
      "Run an ordered list of actions in the profile's Chromium against the CURRENT page (start with a goto step to navigate): " +
      "goto, click, fill, press, select, check, hover, scroll, wait_selector, wait_ms, eval. Selectors are Playwright CSS. " +
      "eval returns the value in step_results. Ends with a full capture (same shape as browser_scrape: text inline, artifacts, blocked detection). " +
      "Use it for search boxes, filters, pagination, 'ver más' buttons — anything a plain GET scrape cannot do.",
    inputSchema: {
      profile: z.string().optional().describe("Named persistent session (default 'default')"),
      tor: z.boolean().optional().describe("Route through Tor (see browser_scrape)"),
      steps: z.array(z.object({
        action: z.enum(["goto", "click", "fill", "press", "select", "check", "hover", "scroll", "wait_selector", "wait_ms", "eval"]),
        selector: z.string().optional().describe("CSS selector for click/fill/select/check/hover/wait_selector"),
        value: z.string().optional().describe("Text for fill, option for select"),
        key: z.string().optional().describe("Keyboard key for press (default Enter)"),
        url: z.string().optional().describe("URL for goto"),
        ms: z.number().int().min(0).max(30000).optional().describe("Milliseconds for wait_ms / timeout for wait_selector"),
        expression: z.string().optional().describe("JS expression for eval, e.g. \"document.title\"")
      })).max(25).describe("Ordered actions"),
      max_chars: z.number().int().min(500).max(50000).optional().describe("Max characters of page.txt to return inline (default 6000)")
    }
  }, async ({ profile, tor, steps, max_chars }) => {
    await ensureStarted();
    const payload = await postForm("/interact", {
      profile,
      steps: JSON.stringify(steps),
      proxy: tor === undefined ? undefined : tor ? "tor" : "direct"
    });
    return jsonContent(await enrichScrapeResult(payload, max_chars ?? 6000));
  });
  
  server.registerTool("browser_read", {
    title: "Read capture artifact",
    description:
      "Read a file from a saved capture (page.txt, page.html, links.json, metadata.json, screenshot.png) directly from the host state directory. " +
      "Defaults to the latest capture and page.txt. Supports offset paging for large documents.",
    inputSchema: {
      capture: z.string().optional().describe("Capture directory name, path, or 'latest' (default 'latest')"),
      file: z.enum(ARTIFACT_FILES).optional().describe("Artifact file to read (default page.txt)"),
      offset: z.number().int().min(0).optional().describe("Character offset to start reading (default 0)"),
      max_chars: z.number().int().min(500).max(200000).optional().describe("Max characters to return (default 20000)")
    }
  }, async ({ capture, file, offset, max_chars }) => {
    let dir;
    if (!capture || capture === "latest") {
      dir = await latestCaptureDir();
      if (!dir) throw new Error(`No captures found under ${path.join(STATE_DIR, "captures")}`);
    } else if (capture.startsWith("/")) {
      dir = capture;
    } else {
      dir = path.join(STATE_DIR, "captures", capture);
    }
    const fileName = file || "page.txt";
    const filePath = path.join(dir, fileName);
    if (fileName === "screenshot.png") {
      const { size } = await fs.stat(filePath);
      return jsonContent({ file: filePath, size_bytes: size, note: "Binary artifact; pass the path to an image-capable tool." });
    }
    return jsonContent(await readText(filePath, max_chars ?? 20000, offset ?? 0));
  });
  
  return server;
}

// ---------- transport ----------

if (MCP_HTTP_PORT) {
  const sessions = new Map();

  async function handleMcp(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body." }));
        return;
      }
      if (session) {
        await session.transport.handleRequest(req, res, parsed);
        return;
      }
      const isInitialize = !Array.isArray(parsed) && parsed.method === "initialize";
      if (!isInitialize) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "No such session; send initialize first (with no or unknown mcp-session-id)." }));
        return;
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, { server, transport })
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!session) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or unknown mcp-session-id header." }));
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { allow: "GET, POST, DELETE", "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed." }));
  }

  const httpServer = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (pathname === "/health" || pathname === "/healthz")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, transport: "streamable-http", api_url: API_URL, managed: MANAGED, state_dir: STATE_DIR }));
      return;
    }
    if (pathname === "/mcp" || pathname === "/mcp/") {
      handleMcp(req, res).catch((error) => {
        log(`http error: ${error?.stack || error}`);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. MCP endpoint is /mcp; health is /health." }));
  });

  httpServer.listen(MCP_HTTP_PORT, () => {
    log(`HTTP MCP listening on :${MCP_HTTP_PORT}/mcp (api=${API_URL}, managed=${MANAGED})`);
  });
} else {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  log(`ready (api=${API_URL}, state=${STATE_DIR})`);
}
