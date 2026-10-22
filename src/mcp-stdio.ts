// stdio bridge to the dashboard's MCP endpoint, for clients that only launch MCP servers as
// processes: `t3-fleet mcp`. Each JSON-RPC line on stdin is POSTed to /mcp; replies go to stdout.
import { loadConfig } from "./config.ts";

const config = loadConfig();
const endpoint = process.env.T3_FLEET_MCP_URL ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}/mcp`;
const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
if (process.env.FLEET_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.FLEET_ACCESS_TOKEN}`;

let buffer = "";
const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
for (let next = await reader.read(); !next.done; next = await reader.read()) {
  buffer += decoder.decode(next.value, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void forward(line);
  }
}

async function forward(line: string) {
  let id: unknown = null;
  try {
    id = JSON.parse(line)?.id ?? null;
    const response = await fetch(endpoint, { method: "POST", headers, body: line });
    if (response.status === 202) return;
    process.stdout.write(`${(await response.text()).trim()}\n`);
  } catch (error) {
    if (id === null) return;
    const message = `t3-fleet is not reachable at ${endpoint} (${error instanceof Error ? error.message : error}). Is it running? Try: t3-fleet status`;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
  }
}
