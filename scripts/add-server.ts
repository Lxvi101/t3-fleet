// Adds a remote t3code server to the fleet.
//   bun run add-server <id> <url> --ssh <user@host>   mint a read-only token on the host over SSH
//   bun run add-server <id> <url>                      paste a token minted on the host with:
//     t3 auth session issue --scope orchestration:read --label fleet-monitor --ttl 365d --token-only
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, FLEET_HOME } from "../src/config.ts";

const [id, url] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const sshIndex = process.argv.indexOf("--ssh");
const sshHost = sshIndex === -1 ? null : process.argv[sshIndex + 1];
if (!id || !url || !/^[\w.-]+$/.test(id) || !/^https?:\/\//.test(url)) {
  console.error("Usage: bun run add-server <id> <http(s)://host:port> [--ssh user@host]");
  process.exit(1);
}

const descriptor = await fetch(new URL("/.well-known/t3/environment", url), { signal: AbortSignal.timeout(8000) })
  .then((response) => response.json() as Promise<{ label?: string; serverVersion?: string; orchestrationProtocolVersion?: number }>)
  .catch((error) => {
    console.error(`Cannot reach ${url}: ${error.message}. Is the server listening on a reachable address (LAN/Tailscale), not 127.0.0.1?`);
    process.exit(1);
  });
console.log(`Found “${descriptor.label}” (t3code ${descriptor.serverVersion}, protocol ${descriptor.orchestrationProtocolVersion})`);

let token: string;
if (sshHost) {
  const remote = `T=$(command -v t3 || echo "$HOME/.t3/bin/t3"); "$T" auth session issue --scope orchestration:read --label fleet-monitor --ttl 365d --token-only`;
  const issued = Bun.spawnSync(["ssh", sshHost, remote], { stderr: "pipe" });
  token = issued.stdout.toString().trim().split("\n").at(-1) ?? "";
  if (issued.exitCode !== 0 || !token) {
    console.error(`Token issue over SSH failed:\n${issued.stderr.toString()}`);
    process.exit(1);
  }
} else {
  process.stdout.write("Paste the read-only token from the remote host: ");
  for await (const line of console) {
    token = line.trim();
    break;
  }
}
if (!token!) process.exit(1);

const ticket = await fetch(new URL("/api/auth/websocket-ticket", url), { method: "POST", headers: { authorization: `Bearer ${token}` } });
if (!ticket.ok) {
  console.error(`The server rejected that token (HTTP ${ticket.status}).`);
  process.exit(1);
}

const tokenFile = join(FLEET_HOME, `${id}.token`);
mkdirSync(FLEET_HOME, { recursive: true });
writeFileSync(tokenFile, token);
chmodSync(tokenFile, 0o600);

const configFile = CONFIG_FILE;
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : { host: "127.0.0.1", port: 4777, servers: [] };
config.servers = config.servers.filter((server: { id: string }) => server.id !== id);
config.servers.push({ id, url, tokenFile });
writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Added ${id} → ${url}.`);
