// Smoke test: boots server.mjs over stdio, lists tools, scrapes and reads.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: new URL("..", import.meta.url).pathname
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const status = await client.callTool({ name: "browser_status", arguments: {} });
const statusJson = JSON.parse(status.content[0].text);
console.log("browser_status.running:", statusJson.running);

const scrape = await client.callTool({
  name: "browser_scrape",
  arguments: { url: "https://example.org", wait_seconds: 10, max_chars: 1200 }
});
const scrapeJson = JSON.parse(scrape.content[0].text);
console.log("scrape:", scrapeJson.final_url, "| blocked:", scrapeJson.blocked, "| text starts:", JSON.stringify((scrapeJson.text || "").slice(0, 40)));

const read = await client.callTool({
  name: "browser_read",
  arguments: { file: "metadata.json", max_chars: 2000 }
});
const readJson = JSON.parse(read.content[0].text);
console.log("read latest metadata.json chars_total:", readJson.chars_total, "truncated:", readJson.truncated);

await client.close();
console.log("SMOKE OK");
