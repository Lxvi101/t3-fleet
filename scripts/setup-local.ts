// Connects the monitor to the t3code server on this machine: mints a read-only
// (orchestration:read) session with t3code's own CLI and adds it to ~/.config/t3-fleet/config.json.
// Re-run any time; pass --rotate to replace an existing token.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FILE, FLEET_HOME } from "../src/config.ts";

const home = homedir();
const t3Home = process.env.T3CODE_HOME ?? join(home, ".t3");
const tokenFile = join(FLEET_HOME, "local.token");
const configFile = CONFIG_FILE;
const rotate = process.argv.includes("--rotate");
const cli = [process.env.T3_CLI, join(t3Home, "bin", "t3"), Bun.which("t3")].find((path) => path && existsSync(path));

if (!existsSync(tokenFile) || rotate) {
  if (!cli) {
    console.error("Could not find the t3 CLI (~/.t3/bin/t3). Open T3 Code once, or set T3_CLI.");
    process.exit(1);
  }
  const issued = Bun.spawnSync([cli, "auth", "session", "issue", "--scope", "orchestration:read", "--label", "fleet-monitor", "--ttl", "365d", "--token-only"], {
    stderr: "pipe",
  });
  const token = issued.stdout.toString().trim();
  if (issued.exitCode !== 0 || !token) {
    console.error(`t3 auth session issue failed:\n${issued.stderr.toString()}`);
    process.exit(1);
  }
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, token);
  chmodSync(tokenFile, 0o600);
  console.log(`Issued a read-only session (orchestration:read) → ${tokenFile}`);
} else {
  console.log(`Using existing token ${tokenFile} (pass --rotate to replace it)`);
}

const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : { host: "127.0.0.1", port: 4777, servers: [] };
if (!config.servers.some((server: { id: string }) => server.id === "local")) {
  config.servers.unshift({ id: "local", runtimeFile: join(t3Home, "userdata", "server-runtime.json"), tokenFile });
  mkdirSync(FLEET_HOME, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Added the local server to ${configFile}`);
}

