import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.SCRAPER_PORT || 7317);
const capturesRoot = "/data/captures";
const hostStateRoot = process.env.BROWSER_SCRAPER_HOST_STATE || null;
const challengePattern = /just a moment|enable javascript and cookies|checking your browser|verify you are human|attention required|captcha/i;

await fs.mkdir(capturesRoot, { recursive: true });

async function connectBrowser() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await chromium.connectOverCDP("http://127.0.0.1:9222");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

const browser = await connectBrowser();
const context = browser.contexts()[0];

let queue = Promise.resolve();

async function resolvePage() {
  const live = context.pages().filter((candidate) => !candidate.isClosed());
  return live.find((candidate) => /^https?:/.test(candidate.url())) || live[0] || await context.newPage();
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

async function saveCapture(page, { requestedUrl = null, status = null, selector = null, startedAt }) {
  const finalUrl = page.url();
  const parsed = new URL(finalUrl === "about:blank" ? "https://blank.invalid/" : finalUrl);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const captureName = `${stamp}-${safeSegment(parsed.hostname)}-${safeSegment(parsed.pathname)}`;
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
    files: ["page.html", "page.txt", "links.json", "screenshot.png", "metadata.json"]
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
  const startedAt = Date.now();
  const target = validateUrl(params.get("url"));
  const selector = params.get("selector") || null;
  const waitSeconds = Math.min(Math.max(Number(params.get("wait_seconds") || 20), 1), 120);
  const page = await resolvePage();
  const navigation = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.bringToFront();
  await waitForPage(page, selector, waitSeconds);
  return saveCapture(page, { requestedUrl: target.href, status: navigation?.status() ?? null, selector, startedAt });
}

async function capture(params) {
  const startedAt = Date.now();
  const selector = params.get("selector") || null;
  const page = await resolvePage();
  if (selector) {
    await page.waitForFunction((value) => Boolean(document.querySelector(value)), selector, { timeout: 30000 }).catch(() => {});
  }
  return saveCapture(page, { requestedUrl: page.url(), selector, startedAt });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    const page = await resolvePage().catch(() => null);
    return jsonResponse(response, 200, { ok: true, page_url: page?.url() ?? null });
  }
  if (request.method !== "POST" || !["/scrape", "/capture"].includes(request.url)) {
    return jsonResponse(response, 404, { error: "Not found" });
  }

  try {
    const params = await parseBody(request);
    const operation = request.url === "/scrape" ? () => scrape(params) : () => capture(params);
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return jsonResponse(response, 200, await result);
  } catch (error) {
    return jsonResponse(response, 400, { error: error.message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Browser scraper listening on ${port}`);
});

async function shutdown() {
  server.close();
  await browser.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
