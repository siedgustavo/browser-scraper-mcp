import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const apiPort = Number(process.env.SCRAPER_PORT || 7317);
const capturesRoot = "/data/captures";
const profilesRoot = "/data/profiles";
const chromeBin = process.env.CHROME_BIN || "/ms-playwright/chromium-1187/chrome-linux/chrome";
const hostStateRoot = process.env.BROWSER_SCRAPER_HOST_STATE || null;
const maxActiveProfiles = Math.max(1, Number(process.env.MAX_ACTIVE_PROFILES || 4));
const challengePattern = /just a moment|enable javascript and cookies|checking your browser|verify you are human|attention required|captcha/i;
const torProxyUrl = process.env.TOR_PROXY || "socks5://tor:9050";
const torControlHost = process.env.TOR_CONTROL_HOST || "tor";
const torControlPort = Number(process.env.TOR_CONTROL_PORT || 9051);
const torControlPassword = process.env.TOR_CONTROL_PASSWORD || "reconrotator";
const proxyModeFile = ".browser-proxy-mode";

await fs.mkdir(capturesRoot, { recursive: true });
await fs.mkdir(profilesRoot, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profiles = new Map(); // name -> { name, dir, proc, debugPort, browser, lastUsed, requestedUrl, queue }
const usedPorts = new Set();

function allocatePort() {
  for (let candidate = 9222; candidate < 9272; candidate += 1) {
    if (!usedPorts.has(candidate)) {
      usedPorts.add(candidate);
      return candidate;
    }
  }
  throw new Error("No free CDP ports");
}

function profileName(value) {
  const name = String(value || "default").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return name || "default";
}

// ---------- tor control port (pipelined commands, resolved on QUIT/close) ----------

function torControl(commands, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: torControlHost, port: torControlPort });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`tor control timed out (got: ${buffer.slice(-160) || "nothing"})`));
    }, timeoutMs);
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (/(?:^|\r\n)[45]\d\d[ -]/.test(buffer)) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(buffer.trim().split("\r\n").pop() || "tor control error"));
      }
    });
    socket.on("close", () => { clearTimeout(timer); resolve(buffer); });
    socket.on("connect", () => {
      socket.write(`AUTHENTICATE "${torControlPassword}"\r\n${commands.map((command) => `${command}\r\n`).join("")}QUIT\r\n`);
    });
  });
}

async function torStatus() {
  try {
    const buffer = await torControl(["GETINFO status/bootstrap-phase", "GETINFO status/circuit-established"]);
    return {
      proxy: torProxyUrl,
      reachable: true,
      bootstrap: buffer.match(/status\/bootstrap-phase=([^\r\n]*)/)?.[1] ?? null,
      circuit_established: buffer.match(/status\/circuit-established=([^\r\n]*)/)?.[1] === "1"
    };
  } catch (error) {
    return { proxy: torProxyUrl, reachable: false, error: error.message };
  }
}

async function torNewIdentity() {
  await torControl(["SIGNAL NEWNYM"]);
  return { signal: "NEWNYM", ok: true, proxy: torProxyUrl };
}

// ---------- profiles ----------

async function readProfileMode(name) {
  const mode = await fs.readFile(path.join(profilesRoot, name, proxyModeFile), "utf8").catch(() => null);
  return mode?.trim() === "tor" ? true : mode?.trim() === "direct" ? false : null;
}

async function writeProfileMode(name, useTor) {
  await fs.writeFile(path.join(profilesRoot, name, proxyModeFile), useTor ? "tor" : "direct").catch(() => {});
}

function isRunning(entry) {
  return entry.proc.exitCode === null && entry.browser !== null;
}

async function pruneExited() {
  for (const [name, entry] of profiles) {
    if (entry.proc.exitCode !== null) {
      usedPorts.delete(entry.debugPort);
      entry.browser?.close().catch(() => {});
      profiles.delete(name);
    }
  }
}

async function stopProfile(name) {
  const entry = profiles.get(name);
  if (!entry) return false;
  // This Chromium ignores SIGTERM/SIGINT: graceful shutdown (which flushes the
  // cookie DB) must be requested over CDP with Browser.close.
  if (entry.browser && entry.proc.exitCode === null) {
    try {
      const session = await entry.browser.newBrowserCDPSession();
      await session.send("Browser.close");
      console.log(`stopProfile(${name}): Browser.close sent`);
    } catch (error) {
      console.log(`stopProfile(${name}): CDP close failed (${error.message}), disconnecting instead`);
      entry.browser.close().catch(() => {});
    }
  } else {
    entry.browser?.close().catch(() => {});
  }
  entry.browser = null;
  if (entry.proc.exitCode === null) {
    await Promise.race([new Promise((resolve) => entry.proc.once("exit", resolve)), sleep(15000)]);
  }
  if (entry.proc.exitCode === null) entry.proc.kill("SIGKILL");
  usedPorts.delete(entry.debugPort);
  profiles.delete(name);
  return true;
}

async function evictIfNeeded() {
  const running = [...profiles.values()].filter(isRunning);
  if (running.length < maxActiveProfiles) return;
  running.sort((a, b) => a.lastUsed - b.lastUsed);
  await stopProfile(running[0].name);
}

async function launchProfile(name, useTor = false) {
  const dir = path.join(profilesRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(["SingletonCookie", "SingletonLock", "SingletonSocket"]
    .map((file) => fs.rm(path.join(dir, file), { force: true })));

  const debugPort = allocatePort();
  const index = [...profiles.values()].filter(isRunning).length;
  const proc = spawn(chromeBin, [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${dir}`,
    "--window-size=1400,920",
    `--window-position=${20 + index * 40},${40 + index * 30}`,
    ...(useTor ? [`--proxy-server=${torProxyUrl}`] : []),
    "about:blank"
  ], { stdio: "ignore" });

  const entry = { name, dir, proc, debugPort, browser: null, lastUsed: Date.now(), requestedUrl: null, useTor, queue: Promise.resolve() };
  profiles.set(name, entry);
  await writeProfileMode(name, useTor);

  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (proc.exitCode !== null) {
      lastError = new Error(`Chromium exited with code ${proc.exitCode}`);
      break;
    }
    try {
      entry.browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      entry.browser.on?.("disconnected", () => {
        if (profiles.get(name) === entry) entry.browser = null;
      });
      return entry;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  proc.kill("SIGKILL");
  profiles.delete(name);
  usedPorts.delete(debugPort);
  throw new Error(`Chromium for profile '${name}' failed to start: ${lastError?.message}`);
}

// useTor: true/false forces the proxy mode (restarting the profile's Chromium
// if needed, sessions persist on disk); null keeps the running mode or the
// mode last persisted on disk.
async function ensureProfile(name, useTor = null) {
  await pruneExited();
  const existing = profiles.get(name);
  const desired = useTor ?? (existing && isRunning(existing) ? existing.useTor : await readProfileMode(name)) ?? false;
  if (existing && isRunning(existing)) {
    if (existing.useTor === desired) {
      existing.lastUsed = Date.now();
      return existing;
    }
    await stopProfile(name); // switch proxy mode: cookie/localStorage state is preserved
  }
  if (existing) await stopProfile(name);
  await evictIfNeeded();
  return await launchProfile(name, desired);
}

async function resolvePage(entry) {
  const context = entry.browser.contexts()[0];
  const live = context.pages().filter((candidate) => !candidate.isClosed());
  return live.find((candidate) => /^https?:/.test(candidate.url())) || live[0] || await context.newPage();
}

let queue = Promise.resolve();

function enqueue(operation) {
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}

function jsonResponse(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function safeSegment(value) {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "page";
}

function validateUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }
  return url;
}

function parseProxyParam(value) {
  if (value === "tor") return true;
  if (value === "direct") return false;
  return null;
}

async function challengeState(page) {
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    body: document.body?.innerText || "",
    challengeElement: Boolean(document.querySelector(
      "#challenge-running, #challenge-stage, .cf-challenge, iframe[src*='challenges.cloudflare.com']"
    ))
  })).catch(() => ({ title: "", body: "", challengeElement: false }));
  const { title, body, challengeElement } = snapshot;
  const sample = `${title}\n${body.slice(0, 4000)}`;
  const blocked = challengeElement || challengePattern.test(sample);
  return {
    blocked,
    reason: blocked ? "Browser challenge or CAPTCHA detected" : null
  };
}

async function waitForPage(page, selector, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const state = await challengeState(page);
    const selectorReady = !selector || await page.evaluate((value) => Boolean(document.querySelector(value)), selector).catch(() => false);
    if (!state.blocked && selectorReady) return state;
    await page.waitForTimeout(1000);
  }
  return challengeState(page);
}

async function saveCapture(page, { requestedUrl = null, status = null, selector = null, startedAt, profile, proxy = "direct" }) {
  const finalUrl = page.url();
  const parsed = new URL(finalUrl === "about:blank" ? "https://blank.invalid/" : finalUrl);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const captureName = `${stamp}-${safeSegment(parsed.hostname)}-${safeSegment(parsed.pathname)}-${profile}${proxy === "tor" ? "-tor" : ""}`;
  const captureDir = path.join(capturesRoot, captureName);
  await fs.mkdir(captureDir, { recursive: true });

  const challenge = await challengeState(page);
  const title = await page.title().catch(() => "");
  const webdriver = await page.evaluate(() => navigator.webdriver).catch(() => null);
  const html = await page.content();
  const text = await page.locator("body").innerText().catch(() => "");
  const links = await page.locator("a[href]").evaluateAll((elements) => elements.map((element) => ({
    href: element.href,
    text: (element.innerText || element.getAttribute("aria-label") || "").trim()
  })));

  await Promise.all([
    fs.writeFile(path.join(captureDir, "page.html"), html),
    fs.writeFile(path.join(captureDir, "page.txt"), `${text}\n`),
    fs.writeFile(path.join(captureDir, "links.json"), `${JSON.stringify(links, null, 2)}\n`),
    page.screenshot({ path: path.join(captureDir, "screenshot.png"), fullPage: true })
  ]);

  const metadata = {
    profile,
    proxy,
    requested_url: requestedUrl,
    final_url: finalUrl,
    title,
    http_status: status,
    navigator_webdriver: webdriver,
    selector,
    blocked: challenge.blocked,
    block_reason: challenge.reason,
    captured_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    files: ["page.html", "page.txt", "links.json", "metadata.json", "screenshot.png"]
  };
  await fs.writeFile(path.join(captureDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    ...metadata,
    capture_dir: captureDir,
    host_capture_dir: hostStateRoot ? path.join(hostStateRoot, "captures", captureName) : null
  };
}

async function parseBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("Request body is too large");
  }
  return new URLSearchParams(body);
}

async function scrape(params) {
  const profile = profileName(params.get("profile"));
  const useTor = parseProxyParam(params.get("proxy"));
  const startedAt = Date.now();
  const target = validateUrl(params.get("url"));
  const selector = params.get("selector") || null;
  const waitSeconds = Math.min(Math.max(Number(params.get("wait_seconds") || 20), 1), 120);
  const entry = await ensureProfile(profile, useTor);
  const page = await resolvePage(entry);
  const navigation = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.bringToFront();
  await waitForPage(page, selector, waitSeconds);
  entry.lastUsed = Date.now();
  entry.requestedUrl = target.href;
  return saveCapture(page, { requestedUrl: target.href, status: navigation?.status() ?? null, selector, startedAt, profile, proxy: entry.useTor ? "tor" : "direct" });
}

async function capture(params) {
  const profile = profileName(params.get("profile"));
  const useTor = parseProxyParam(params.get("proxy"));
  const startedAt = Date.now();
  const selector = params.get("selector") || null;
  const entry = await ensureProfile(profile, useTor);
  const page = await resolvePage(entry);
  if (selector) {
    await page.waitForFunction((value) => Boolean(document.querySelector(value)), selector, { timeout: 30000 }).catch(() => {});
  }
  entry.lastUsed = Date.now();
  return saveCapture(page, { requestedUrl: page.url(), selector, startedAt, profile, proxy: entry.useTor ? "tor" : "direct" });
}

async function listProfiles() {
  await pruneExited();
  const diskEntries = await fs.readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  const diskNames = diskEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const names = [...new Set([...diskNames, ...profiles.keys()])].sort();
  const items = await Promise.all(names.map(async (name) => {
    const entry = profiles.get(name);
    const running = Boolean(entry && isRunning(entry));
    let cookieCount = null;
    let pageUrl = null;
    if (running) {
      const context = entry.browser.contexts()[0];
      cookieCount = (await context.cookies().catch(() => []))?.length ?? null;
      pageUrl = entry.requestedUrl;
    }
    const savedMode = running ? null : await readProfileMode(name);
    return {
      name,
      running,
      on_disk: diskNames.includes(name),
      proxy: running ? (entry.useTor ? "tor" : "direct") : null,
      saved_proxy_mode: savedMode === null ? null : savedMode ? "tor" : "direct",
      cookie_count: cookieCount,
      page_url: pageUrl,
      last_used: entry ? new Date(entry.lastUsed).toISOString() : null,
      host_dir: hostStateRoot ? path.join(hostStateRoot, "profiles", name) : null
    };
  }));
  return items;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      const running = [...profiles.values()].filter(isRunning).map((entry) => entry.name);
      return jsonResponse(response, 200, { ok: true, profiles_running: running });
    }
    if (request.method === "GET" && request.url === "/profiles") {
      return jsonResponse(response, 200, { profiles: await listProfiles(), max_active_profiles: maxActiveProfiles });
    }
    if (request.method === "GET" && request.url === "/tor_status") {
      return jsonResponse(response, 200, await torStatus());
    }
    if (request.method !== "POST" || !["/scrape", "/capture", "/profile_stop", "/test_cookie", "/tor_new_identity"].includes(request.url)) {
      return jsonResponse(response, 404, { error: "Not found" });
    }

    const params = await parseBody(request);
    if (request.url === "/tor_new_identity") {
      return jsonResponse(response, 200, await enqueue(torNewIdentity));
    }
    if (request.url === "/profile_stop") {
      const name = profileName(params.get("profile"));
      const stopped = await stopProfile(name);
      return jsonResponse(response, 200, { profile: name, stopped });
    }
    if (request.url === "/test_cookie") {
      // Diagnostic helper: set a persistent cookie (7-day expiry) via CDP so
      // session persistence can be verified on sites that only send session cookies.
      const name = profileName(params.get("profile"));
      const entry = await ensureProfile(name);
      const session = await entry.browser.newBrowserCDPSession();
      await session.send("Storage.setCookies", {
        cookies: [{
          name: params.get("name") || "mcp_session",
          value: params.get("value") || "yes",
          url: params.get("url") || "https://httpbin.org/",
          // CDP set-params use `expires` (seconds); `expirationDate` is only the read
          // field name and would be silently ignored (cookie saved as session-only).
          expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
          // CDP defaults SameSite to None, which is invalid without Secure and gets
          // dropped on next load; pin the attributes instead.
          path: "/",
          secure: true,
          samesite: "None"
        }]
      });
      await session.detach().catch(() => {});
      return jsonResponse(response, 200, { profile: name, cookie_set: params.get("name") || "mcp_session" });
    }
    const operation = request.url === "/scrape" ? () => scrape(params) : () => capture(params);
    return jsonResponse(response, 200, await enqueue(operation));
  } catch (error) {
    return jsonResponse(response, 400, { error: error.message });
  }
});

server.listen(apiPort, "0.0.0.0", () => {
  console.log(`Browser scraper listening on ${apiPort} (profiles root ${profilesRoot}, max active ${maxActiveProfiles})`);
});

async function shutdown(signal) {
  console.log(`shutdown(${signal}): stopping ${profiles.size} profile(s)`);
  server.close();
  await Promise.all([...profiles.keys()].map((name) => stopProfile(name).catch((error) => {
    console.log(`shutdown: stopProfile(${name}) failed: ${error.message}`);
  })));
  console.log("shutdown: all profiles stopped, exiting");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
