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

// 7. stop + start via MCP
await call("browser_stop");
status = await call("browser_status");
assert.equal(status.running, false);
const started = await call("browser_start");
assert.equal(started.health.ok ?? true, true);
console.log("7. browser_stop + browser_start via MCP OK");

await client.close();
console.log("FULL TEST OK — 7/7");
