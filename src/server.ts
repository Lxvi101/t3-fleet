import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Fleet } from "./fleet.ts";
import { HistoryStore } from "./history.ts";
import type { HistoryEntry } from "./model.ts";

const config = loadConfig();
const history = new HistoryStore(join(config.dataDir, "history.jsonl"));
const fleet = new Fleet(config, history);
const publicDir = join(import.meta.dir, "..", "public");
const accessToken = process.env.FLEET_ACCESS_TOKEN ?? null;
const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);

if (!loopback && !accessToken) {
  console.error(`Refusing to listen on ${config.host} without FLEET_ACCESS_TOKEN: the dashboard shows prompts and paths.`);
  process.exit(1);
}

type Client = { send(event: string, data: unknown): void };
const clients = new Set<Client>();
let pendingHistory: HistoryEntry[] = [];
history.subscribe((entry) => pendingHistory.push(entry));

setInterval(() => {
  const changes = fleet.takeChanges();
  const newHistory = pendingHistory;
  pendingHistory = [];
  if (clients.size === 0) return;
  if (changes.upserts.length || changes.removals.length || changes.servers || changes.usage || newHistory.length) {
    const patch = { ...changes, history: newHistory };
    for (const client of clients) client.send("patch", patch);
  }
}, 250);

function snapshot() {
  return { servers: fleet.servers(), agents: fleet.agents(), usage: fleet.usage(), history: history.recent(300), now: new Date().toISOString() };
}

function authorized(request: Request, url: URL): boolean {
  if (!accessToken) return true;
  const cookie = request.headers.get("cookie") ?? "";
  return url.searchParams.get("token") === accessToken || cookie.split(/;\s*/).includes(`fleet_token=${accessToken}`);
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (!authorized(request, url)) return new Response("Unauthorized", { status: 401 });
    const setCookie: Record<string, string> =
      accessToken && url.searchParams.get("token") === accessToken
        ? { "set-cookie": `fleet_token=${accessToken}; HttpOnly; SameSite=Strict; Path=/` }
        : {};

    switch (url.pathname) {
      case "/":
        return new Response(Bun.file(join(publicDir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", ...setCookie } });
      case "/app.js":
      case "/app.css":
      case "/map.js":
        return new Response(Bun.file(join(publicDir, url.pathname.slice(1))));
      case "/api/health":
        return Response.json({ ok: true, servers: fleet.servers().map((s) => ({ id: s.id, status: s.status })) });
      case "/api/state":
        return Response.json(snapshot());
      case "/api/agent": {
        const detail = fleet.agentDetail(url.searchParams.get("key") ?? "");
        return detail ? Response.json(detail) : Response.json({ error: "not found" }, { status: 404 });
      }
      case "/api/events": {
        server.timeout(request, 0);
        let client: Client;
        let heartbeat: ReturnType<typeof setInterval>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            client = {
              send(event, data) {
                try {
                  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                } catch {
                  clients.delete(client);
                }
              },
            };
            client.send("state", snapshot());
            clients.add(client);
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch {
                clearInterval(heartbeat);
              }
            }, 15_000);
          },
          cancel() {
            clients.delete(client);
            clearInterval(heartbeat);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  },
});

fleet.start();
console.log(`t3-fleet monitoring ${config.servers.length} server(s) at http://${server.hostname}:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    fleet.stop();
    server.stop(true);
    process.exit(0);
  });
}
