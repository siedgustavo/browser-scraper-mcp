// Smoke test for the Streamable HTTP transport (RECON_BROWSER_MCP_HTTP_PORT).
// Does not need the scraper container: only initialize + tools/list run here.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 7399;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn("node", [path.join(ROOT, "server.mjs")], {
  env: { ...process.env, RECON_BROWSER_MCP_HTTP_PORT: String(PORT), RECON_BROWSER_MANAGED: "remote" },
  stdio: ["ignore", "ignore", "inherit"]
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`/health never became ready on ${BASE}`);
}

function post(body, sessionId) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(body)
  });
}

// The SDK may answer with plain JSON or an SSE stream; both carry one payload.
function parsePayload(text) {
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
  return JSON.parse(dataLines.length ? dataLines.at(-1).slice(5).trim() : text);
}

try {
  const health = await waitHealth();
  if (!health.ok || health.transport !== "streamable-http") {
    throw new Error(`unexpected /health payload: ${JSON.stringify(health)}`);
  }

  const initResponse = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-smoke", version: "0.0.0" }
    }
  });
  if (!initResponse.ok) throw new Error(`initialize returned HTTP ${initResponse.status}`);
  const sessionId = initResponse.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize did not return an mcp-session-id header");
  const init = parsePayload(await initResponse.text());
  if (init.result?.serverInfo?.name !== "recon-browser") {
    throw new Error(`unexpected initialize payload: ${JSON.stringify(init)}`);
  }

  const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  if (!notified.ok) throw new Error(`notifications/initialized returned HTTP ${notified.status}`);

  const toolsResponse = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
  const tools = parsePayload(await toolsResponse.text());
  const names = (tools.result?.tools || []).map((tool) => tool.name);
  for (const expected of ["browser_scrape", "browser_capture", "browser_interact", "browser_read"]) {
    if (!names.includes(expected)) throw new Error(`tools/list is missing ${expected}`);
  }

  // A second, independent session must get its own id (shared API, per-session transport).
  const second = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-smoke-2", version: "0.0.0" } }
  });
  const secondSessionId = second.headers.get("mcp-session-id");
  if (!secondSessionId || secondSessionId === sessionId) throw new Error("second session did not get a distinct id");

  console.log(`http smoke OK (${names.length} tools, sessions ${sessionId.slice(0, 8)}…/${secondSessionId.slice(0, 8)}…)`);
} finally {
  child.kill("SIGTERM");
}
