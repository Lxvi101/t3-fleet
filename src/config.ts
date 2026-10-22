import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ServerConfig {
  id: string;
  label?: string;
  /** Base URL of the t3code server, e.g. http://100.64.0.12:3773 */
  url?: string;
  /** For a server on this machine: t3code's server-runtime.json, re-read on every connect. */
  runtimeFile?: string;
  token?: string;
  tokenFile?: string;
  tokenEnv?: string;
}

export interface FleetConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Upper bound on concurrent per-thread detail streams per server. */
  maxDetailStreams: number;
  servers: ServerConfig[];
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/** Config and tokens live outside the checkout so updates and reinstalls never touch them. */
export const FLEET_HOME = resolve(expandHome(process.env.T3_FLEET_CONFIG_DIR ?? "~/.config/t3-fleet"));
export const CONFIG_FILE = resolve(expandHome(process.env.FLEET_CONFIG ?? `${FLEET_HOME}/config.json`));

export function loadConfig(file = CONFIG_FILE): FleetConfig {
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { servers: [] };
  if (!existsSync(file)) console.warn(`No config at ${file}; starting with no servers. Run \`t3-fleet setup\` or \`t3-fleet add\`.`);
  const servers: ServerConfig[] = Array.isArray(raw.servers) ? raw.servers : [];
  const ids = new Set<string>();
  for (const server of servers) {
    if (!server.id || !/^[\w.-]+$/.test(server.id)) throw new Error(`Server ids must match [\\w.-]+: ${JSON.stringify(server.id)}`);
    if (ids.has(server.id)) throw new Error(`Duplicate server id ${server.id}`);
    ids.add(server.id);
    if (!server.url && !server.runtimeFile) throw new Error(`Server ${server.id} needs url or runtimeFile`);
  }
  return {
    host: process.env.FLEET_HOST ?? raw.host ?? "127.0.0.1",
    port: Number(process.env.FLEET_PORT ?? raw.port ?? 4777),
    dataDir: resolve(expandHome(raw.dataDir ?? `${FLEET_HOME}/data`)),
    maxDetailStreams: Number(raw.maxDetailStreams ?? 40),
    servers,
  };
}

export function readToken(server: ServerConfig): string | null {
  if (server.token) return server.token;
  if (server.tokenEnv && process.env[server.tokenEnv]) return process.env[server.tokenEnv]!.trim();
  if (server.tokenFile) {
    const file = expandHome(server.tokenFile);
    if (existsSync(file)) return readFileSync(file, "utf8").trim() || null;
  }
  return null;
}

export function resolveBaseUrl(server: ServerConfig): string | null {
  if (server.runtimeFile) {
    try {
      const runtime = JSON.parse(readFileSync(expandHome(server.runtimeFile), "utf8"));
      if (typeof runtime.origin === "string") return runtime.origin;
      if (runtime.port) return `http://${runtime.host ?? "127.0.0.1"}:${runtime.port}`;
    } catch {}
  }
  return server.url ?? null;
}
