// Read-only MCP server for the fleet, served over streamable HTTP at /mcp (stateless JSON
// responses). `src/mcp-stdio.ts` bridges it for clients that only speak stdio.

import type { Fleet } from "./fleet.ts";
import type { HistoryStore } from "./history.ts";
import type { AgentView } from "./model.ts";
import type { Sentinel } from "./sentinel.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ACTIVE = new Set(["running", "waiting", "blocked"]);
const WINDOWS: Record<string, number> = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3 };

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, any>): unknown;
}

export function createMcp(fleet: Fleet, history: HistoryStore, sentinel: Sentinel | null) {
  const serverLabel = new Map<string, string>();
  const label = (serverId: string) => {
    if (!serverLabel.has(serverId)) for (const server of fleet.servers()) serverLabel.set(server.id, server.label);
    return serverLabel.get(serverId) ?? serverId;
  };
  const slim = (agent: AgentView) => ({
    key: agent.key,
    title: agent.title,
    state: agent.state,
    machine: label(agent.serverId),
    project: agent.projectTitle,
    branch: agent.branch,
    cwd: agent.cwd,
    provider: agent.provider,
    model: agent.model,
    kind: agent.kind === "subagent" ? "native-subagent" : (agent.relationship ?? "thread"),
    parentKey: agent.parentKey,
    activity: agent.activity ? { label: agent.activity.label, detail: agent.activity.detail, live: agent.activity.live, at: agent.activity.at } : null,
    needs: agent.pending,
    lastError: agent.lastError,
    startedAt: agent.startedAt,
    updatedAt: agent.updatedAt,
    stale: agent.stale || undefined,
  });

  const tools: Tool[] = [
    {
      name: "fleet_overview",
      description:
        "Snapshot of the whole T3 Code fleet: machines and their connection status, agent counts by state, every agent that is working or needs the user right now, open alerts, and provider usage left. Start here.",
      inputSchema: { type: "object", properties: {} },
      run: () => {
        const agents = fleet.agents();
        const counts: Record<string, number> = {};
        for (const agent of agents) counts[agent.state] = (counts[agent.state] ?? 0) + 1;
        return {
          now: new Date().toISOString(),
          machines: fleet.servers().map((s) => ({ id: s.id, name: s.label, status: s.status, detail: s.statusDetail, platform: s.platform, version: s.serverVersion, threads: s.threadCount })),
          counts,
          active: agents.filter((a) => ACTIVE.has(a.state)).map(slim),
          alerts: sentinel?.openAlerts() ?? [],
          usage: usageSummary(fleet),
        };
      },
    },
    {
      name: "list_agents",
      description: "List agents (threads and subagents) across all machines, most important first. Filter by state, machine, project, provider, or free text.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["running", "waiting", "blocked", "failed", "completed", "idle", "cancelled", "unknown", "active"], description: "'active' = running, waiting or blocked" },
          machine: { type: "string", description: "Machine id or name" },
          project: { type: "string" },
          provider: { type: "string" },
          query: { type: "string", description: "Matches title, project, branch, path and activity" },
          window: { type: "string", enum: ["1h", "24h", "7d", "all"], description: "Only agents updated within this window (active agents always included). Default 24h." },
          limit: { type: "number", description: "Default 30, max 200" },
        },
      },
      run: (args) => {
        const now = Date.now();
        const windowMs = WINDOWS[args.window ?? "24h"];
        const q = String(args.query ?? "").toLowerCase();
        const machine = String(args.machine ?? "").toLowerCase();
        const rank = ["blocked", "running", "waiting", "failed", "unknown", "completed", "cancelled", "idle"];
        const rows = fleet
          .agents()
          .filter((a) => ACTIVE.has(a.state) || !windowMs || now - Date.parse(a.updatedAt) <= windowMs)
          .filter((a) => !args.state || (args.state === "active" ? ACTIVE.has(a.state) : a.state === args.state))
          .filter((a) => !machine || a.serverId.toLowerCase() === machine || label(a.serverId).toLowerCase().includes(machine))
          .filter((a) => !args.project || (a.projectTitle ?? "").toLowerCase().includes(String(args.project).toLowerCase()))
          .filter((a) => !args.provider || a.provider.toLowerCase().includes(String(args.provider).toLowerCase()))
          .filter((a) => !q || [a.title, a.projectTitle, a.branch, a.cwd, a.activity?.label, a.activity?.detail].join(" ").toLowerCase().includes(q))
          .sort((a, b) => rank.indexOf(a.state) - rank.indexOf(b.state) || b.updatedAt.localeCompare(a.updatedAt));
        const limit = Math.min(Math.max(Number(args.limit ?? 30), 1), 200);
        return { total: rows.length, agents: rows.slice(0, limit).map(slim) };
      },
    },
    {
      name: "get_agent",
      description: "Full detail for one agent by key: where it runs, parent and children, its prompt/result (subagents), latest message, and its recent timeline of commands, edits, tests and messages.",
      inputSchema: { type: "object", properties: { key: { type: "string", description: "Agent key from list_agents or fleet_overview" } }, required: ["key"] },
      run: (args) => {
        const detail = fleet.agentDetail(String(args.key ?? ""));
        if (!detail) return { error: "No agent with that key." };
        const children = fleet.agents().filter((a) => a.parentKey === detail.agent.key).map((a) => ({ key: a.key, title: a.title, state: a.state }));
        return { agent: slim(detail.agent), children, prompt: detail.prompt, result: detail.result, latestMessage: detail.lastMessage, timeline: detail.timeline.slice(0, 40) };
      },
    },
    {
      name: "get_usage",
      description: "Provider usage left per account (Claude session/weekly limits, Codex weekly, …), merged across machines, with reset times.",
      inputSchema: { type: "object", properties: {} },
      run: () => usageSummary(fleet),
    },
    {
      name: "recent_activity",
      description: "Fleet-wide activity feed, newest first: agents starting/finishing, commands, edits, test results, failures, spawned subagents, machines connecting.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Default 50, max 300" }, machine: { type: "string" }, sinceMinutes: { type: "number" } },
      },
      run: (args) => {
        const since = args.sinceMinutes ? Date.now() - Number(args.sinceMinutes) * 60e3 : 0;
        const machine = String(args.machine ?? "").toLowerCase();
        const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 300);
        return history
          .recent(2000)
          .filter((e) => Date.parse(e.at) >= since)
          .filter((e) => !machine || e.serverId.toLowerCase() === machine || label(e.serverId).toLowerCase().includes(machine))
          .slice(-limit)
          .reverse()
          .map((e) => ({ at: e.at, machine: label(e.serverId), agent: e.title, agentKey: e.agentKey, kind: e.kind, text: e.text }));
      },
    },
    {
      name: "get_alerts",
      description: "Alerts raised by the t3-fleet sentinel: threads that really need the user, with why and what to do.",
      inputSchema: { type: "object", properties: { includeResolved: { type: "boolean" } } },
      run: (args) => (sentinel ? (args.includeResolved ? sentinel.allAlerts() : sentinel.openAlerts()) : []),
    },
  ];

  async function handle(message: any): Promise<any | null> {
    const { id, method, params } = message ?? {};
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
    if (id === undefined || id === null) return null; // notification
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "t3-fleet", version: "0.2.0" },
          instructions:
            "Read-only view of the user's T3 Code coding agents across all their machines. Call fleet_overview first, then list_agents/get_agent to dig in. Agent keys look like '<machine>/<threadId>' or '<machine>/<threadId>#<subagentId>'.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools.map(({ run: _run, ...tool }) => ({ ...tool, annotations: { readOnlyHint: true } })) });
      case "tools/call": {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, `Unknown tool ${params?.name}`);
        try {
          const result = await tool.run(params?.arguments ?? {});
          return reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
        } catch (error) {
          return reply({ content: [{ type: "text", text: String(error) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  return {
    tools,
    /** Handles one POST to /mcp. */
    async http(request: Request): Promise<Response> {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
      let body: any;
      try {
        body = await request.json();
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
      }
      const batch = Array.isArray(body);
      const replies = (await Promise.all((batch ? body : [body]).map(handle))).filter((r) => r !== null);
      if (replies.length === 0) return new Response(null, { status: 202 });
      return Response.json(batch ? replies : replies[0]);
    },
  };
}

function usageSummary(fleet: Fleet) {
  return fleet.usage().map((account) => ({
    provider: account.label,
    plan: account.plan,
    machines: account.servers,
    limits: account.windows.map((w) => ({ window: w.label, leftPercent: Math.round(100 - w.usedPercent), resetsAt: w.resetsAt })),
    note: account.windows.length ? undefined : account.unsupported?.link ? `Not reported here; see ${account.unsupported.link.url}` : "Not reported",
  }));
}
