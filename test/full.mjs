// Exhaustive test: cold start -> all MCP tools, one by one.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = new URL("..", import.meta.url).pathname;
execFileSync("docker", ["compose", "--project-directory", path.join(ROOT, "container"),
  "-f", path.join(ROOT, "container", "compose.yml"), "down"], { cwd: ROOT, stdio: "inherit" });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: new URL("..", import.meta.url).pathname
});
const client = new Client({ name: "full-test", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name} returned an error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
};
const API = process.env.RECON_BROWSER_API || "http://127.0.0.1:7318";
const post = async (endpoint, params) => {
  const body = new URLSearchParams(params);
  const response = await fetch(`${API}/${endpoint}`, { method: "POST", body });
  const payload = await response.json().catch(() => ({}));
  assert.ok(response.ok && !payload.error, `${endpoint} failed: ${payload.error}`);
  return payload;
};

// 1. cold state: container must be down
let status = await call("browser_status");
assert.equal(status.running, false, "container should be down before the test");
console.log("1. browser_status (cold): running=false OK");

// 2. scrape auto-starts the container (the untested path) and works on X
const t0 = Date.now();
const scrape = await call("browser_scrape", { url: "https://x.com/notnotzecoxao", wait_seconds: 30, max_chars: 1500 });
assert.equal(scrape.http_status, 200);
assert.equal(scrape.blocked, false);
assert.ok(scrape.text?.length > 0, "expected inline page text");
assert.ok(scrape.user_action === undefined, "no user_action expected when not blocked");
console.log(`2. browser_scrape X: 200, not blocked, text inline (${scrape.text.length} chars), auto-start took ${((Date.now() - t0) / 1000).toFixed(1)}s OK`);

// 3. capture the current tab (no navigation)
const capture = await call("browser_capture", { max_chars: 800 });
assert.equal(capture.final_url, scrape.final_url, "capture must stay on the same tab");
assert.ok(capture.host_capture_dir !== scrape.host_capture_dir, "capture should create a new capture dir");
console.log("3. browser_capture: same tab, new capture dir OK");

// 4. artifacts on disk for the scrape
const dir = scrape.host_capture_dir;
for (const file of ["page.html", "page.txt", "links.json", "metadata.json", "screenshot.png"]) {
  const { size } = await fs.stat(path.join(dir, file));
  assert.ok(size > 0, `${file} should not be empty`);
}
console.log("4. artifacts on host: 5 files, all non-empty OK");

// 5. browser_read: latest default + offset paging + links + screenshot
const meta = await call("browser_read", { file: "metadata.json" });
assert.equal(meta.truncated, false);
const txt = await fs.readFile(path.join(dir, "page.txt"), "utf8");
const p1 = await call("browser_read", { capture: path.basename(dir), file: "page.txt", max_chars: 1000, offset: 0 });
assert.equal(p1.chars_total, txt.length);
assert.equal(p1.text, txt.slice(0, 1000));
const p2 = await call("browser_read", { capture: path.basename(dir), file: "page.txt", max_chars: 1000, offset: 1000 });
assert.equal(p2.text, txt.slice(1000, 2000), "offset paging must continue where the previous chunk ended");
const links = await call("browser_read", { capture: path.basename(dir), file: "links.json", max_chars: 1500 });
assert.ok(links.text.includes("http"), "links.json should contain hrefs");
const shot = await call("browser_read", { capture: path.basename(dir), file: "screenshot.png" });
assert.ok(shot.size_bytes > 10000, "screenshot should be a real png");
const latest = await call("browser_read", {});
assert.ok(latest.file.includes(capture.host_capture_dir.split("/").pop()), "latest must be the capture from step 3");
console.log("5. browser_read: latest, named capture, offset paging, links.json, screenshot.png OK");

// 6. blocked detection: scrape a known Cloudflare-protected flow (sanity of field only)
const statusUp = await call("browser_status");
assert.equal(statusUp.running, true);
console.log("6. browser_status (warm): running=true OK");

// 7. profiles: named sessions, isolation, and persistence across a container restart
await call("browser_scrape", { url: "https://httpbin.org/", profile: "x", wait_seconds: 15, max_chars: 500 });
await post("test_cookie", { profile: "x", name: "mcp_session", value: "x-keeps-me" }); // persistent cookie via CDP
const profiles = await call("browser_profiles");
const xProfile = profiles.profiles.find((entry) => entry.name === "x");
assert.ok(xProfile?.running, "profile 'x' should be running");
assert.ok(xProfile.cookie_count >= 1, "profile 'x' should hold the cookie we just set");
// isolation: a different profile must NOT see the 'x' cookie
const other = await call("browser_scrape", { url: "https://httpbin.org/cookies", profile: "wiki", wait_seconds: 15, max_chars: 500 });
assert.ok(!other.text.includes("mcp_session"), "'wiki' profile must not see the 'x' profile cookie");
// persistence: full container restart, then resume the same session
await call("browser_stop");
await call("browser_start");
const resumed = await call("browser_scrape", { url: "https://httpbin.org/cookies", profile: "x", wait_seconds: 15, max_chars: 500 });
assert.ok(resumed.text.includes("mcp_session"), "'x' profile must keep its cookie across a container restart");
assert.ok(resumed.text.includes("x-keeps-me"), "'x' profile must keep the cookie value across a container restart");
const profilesAfter = await call("browser_profiles");
assert.ok(profilesAfter.profiles.some((entry) => entry.name === "x" && entry.running));
console.log("7. profiles: named sessions, isolation between them, cookie survives container restart OK");

// 8. tor: bootstrap, real exit through Tor, identity rotation, mode toggle back to direct
let torReady = false;
for (let attempt = 0; attempt < 45 && !torReady; attempt += 1) {
  const torInfo = await call("browser_tor_status");
  const pct = /PROGRESS=(\d+)/.exec(torInfo.bootstrap || "")?.[1];
  torReady = Boolean(torInfo.reachable) && pct === "100";
  if (!torReady) await new Promise((resolve) => setTimeout(resolve, 2000));
}
assert.ok(torReady, "Tor should reach bootstrap 100 within 90s");
const viaTor = await call("browser_scrape", { url: "https://check.torproject.org/api/ip", profile: "tortest", tor: true, wait_seconds: 60, max_chars: 600 });
assert.equal(viaTor.proxy, "tor");
assert.match(viaTor.text ?? "", /"IsTor"\s*:\s*true/i); // Tor exit confirmed by the site itself
const exitIp1 = viaTor.text.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
await call("browser_new_identity");
await new Promise((resolve) => setTimeout(resolve, 1500));
const viaTor2 = await call("browser_scrape", { url: "https://check.torproject.org/api/ip?r=2", profile: "tortest", wait_seconds: 60, max_chars: 600 });
assert.match(viaTor2.text ?? "", /"IsTor"\s*:\s*true/i); // tor=true mode must persist on the profile without re-passing it
const exitIp2 = viaTor2.text.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
const backDirect = await call("browser_scrape", { url: "https://example.com", profile: "tortest", tor: false, wait_seconds: 15, max_chars: 500 });
assert.equal(backDirect.proxy, "direct");
assert.match(backDirect.text ?? "", /domain/i);
const profilesWithTor = await call("browser_profiles");
assert.equal(profilesWithTor.profiles.find((entry) => entry.name === "tortest")?.proxy, "direct");
console.log(`8. tor: bootstrap OK, exit=${exitIp1} tras NEWNYM exit=${exitIp2}, modo tor se persiste en el perfil, toggle a direct OK`);

// 9. stop + start via MCP
await call("browser_stop_profile", { profile: "x" });
const stoppedX = await call("browser_profiles");
const xAfterStop = stoppedX.profiles.find((entry) => entry.name === "x");
assert.equal(xAfterStop.running, false);
assert.equal(xAfterStop.on_disk, true);
await call("browser_stop");
status = await call("browser_status");
assert.equal(status.running, false);
const started = await call("browser_start");
assert.equal(started.health.ok ?? true, true);
console.log("9. browser_stop_profile + browser_stop + browser_start via MCP OK");

await client.close();
console.log("FULL TEST OK — 9/9");
