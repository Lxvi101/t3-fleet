// The sentinel watches the fleet and interrupts the user only when a thread really needs them.
// Cheap rules pick candidates (blocked, failed, asking a question, stalled, out of usage, machine
// offline); a Codex CLI agent with the fleet MCP judges each new candidate once. It also writes
// periodic briefings and answers questions about the fleet.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Fleet } from "./fleet.ts";
import type { HistoryStore } from "./history.ts";
import type { AgentView } from "./model.ts";

export interface SentinelConfig {
  enabled: boolean;
  codex: string | null;
  model: string;
  effort: string;
  briefEveryMinutes: number;
  desktop: boolean;
  ntfy: string | null;
}

export interface Alert {
  id: string;
  agentKey: string | null;
  machine: string | null;
  title: string;
  severity: "urgent" | "important";
  headline: string;
  why: string;
  action: string;
  source: "agent" | "rule";
  createdAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

export interface Briefing {
  text: string;
  at: string;
}

interface Candidate {
  id: string;
  kind: "blocked" | "failed" | "question" | "stalled" | "usage" | "offline";
  agentKey: string | null;
  machine: string | null;
  title: string;
  facts: Record<string, unknown>;
}

interface Decision {
  needsUser: boolean;
  severity: "urgent" | "important" | "low";
  headline: string;
  why: string;
  action: string;
  decidedAt: string;
}

const SCAN_MS = 15_000;
const RECENT_MS = 30 * 60e3;
const STALL_MS = 25 * 60e3;
const OFFLINE_MS = 3 * 60e3;
const RUN_TIMEOUT_MS = 4 * 60e3;
const QUESTION = /\?\s*$|\b(should i|do you want|want me to|would you like|let me know|which (one|option)|please (confirm|approve|choose|decide)|need(s)? (you|your)|waiting (for|on) you|can you|could you|your call|blocked on)\b/i;

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "needsUser", "severity", "headline", "why", "action"],
        properties: {
          id: { type: "string" },
          needsUser: { type: "boolean" },
          severity: { type: "string", enum: ["urgent", "important", "low"] },
          headline: { type: "string", description: "Under 70 characters, names the agent's task" },
          why: { type: "string", description: "One sentence: what exactly is blocked or broken" },
          action: { type: "string", description: "One short imperative: what the user should do" },
        },
      },
    },
  },
};

export function resolveCodex(configured?: string | null): string | null {
  const candidates = [configured, Bun.which("codex"), join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}

export class Sentinel {
  private readonly alerts = new Map<string, Alert>();
  private readonly decisions = new Map<string, Decision>();
  private readonly offlineSince = new Map<string, number>();
  private briefing: Briefing | null = null;
  private busy: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private triagePending = false;
  private lastBriefAt = 0;
  private lastActivityId = 0;
  private readonly listeners = new Set<() => void>();
  private readonly stateFile: string;

  constructor(
    private readonly fleet: Fleet,
    private readonly history: HistoryStore,
    readonly config: SentinelConfig,
    private readonly mcpUrl: string,
    private readonly dashboardUrl: string,
    private readonly dataDir: string,
  ) {
    this.stateFile = join(dataDir, "sentinel.json");
    this.load();
  }

  start() {
    setTimeout(() => this.scan(), 20_000);
    setInterval(() => this.scan(), SCAN_MS);
    if (this.config.briefEveryMinutes > 0 && this.config.codex) {
      setInterval(() => {
        const due = Date.now() - this.lastBriefAt >= this.config.briefEveryMinutes * 60e3;
        const newest = this.history.recent(1)[0]?.id ?? 0;
        if (due && newest !== this.lastActivityId) void this.brief().catch(() => {});
      }, 60_000);
    }
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  state() {
    return {
      enabled: this.config.enabled,
      agent: this.config.codex ? `Codex · ${this.config.model}` : null,
      busy: this.busy,
      alerts: this.openAlerts(),
      briefing: this.briefing,
    };
  }

  openAlerts(): Alert[] {
    return [...this.alerts.values()].filter((a) => !a.resolvedAt && !a.dismissedAt).sort((a, b) => (a.severity === b.severity ? b.createdAt.localeCompare(a.createdAt) : a.severity === "urgent" ? -1 : 1));
  }

  allAlerts(): Alert[] {
    return [...this.alerts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  dismiss(id: string) {
    const alert = this.alerts.get(id);
    if (!alert || alert.dismissedAt) return false;
    alert.dismissedAt = new Date().toISOString();
    this.changed();
    return true;
  }

  // ---- candidates -------------------------------------------------------------------------------

  candidates(): Candidate[] {
    const now = Date.now();
    const out: Candidate[] = [];
    const servers = this.fleet.servers();
    const machine = (serverId: string) => servers.find((s) => s.id === serverId)?.label ?? serverId;
    const agents = this.fleet.agents();
    const byKey = new Map(agents.map((a) => [a.key, a]));
    const parentWorking = (agent: AgentView) => {
      const parent = agent.parentKey ? byKey.get(agent.parentKey) : undefined;
      return parent && ["running", "waiting", "blocked"].includes(parent.state);
    };
    const base = (agent: AgentView) => ({
      agentKey: agent.key,
      machine: machine(agent.serverId),
      title: agent.title,
    });
    const facts = (agent: AgentView) => ({
      project: agent.projectTitle,
      branch: agent.branch,
      provider: agent.provider,
      kind: agent.kind === "subagent" ? "native-subagent" : (agent.relationship ?? "thread"),
      state: agent.state,
      activity: agent.activity ? `${agent.activity.label}${agent.activity.detail ? `: ${agent.activity.detail}` : ""}` : null,
      updatedAt: agent.updatedAt,
    });

    for (const agent of agents) {
      if (agent.stale) continue;
      if (agent.state === "blocked" && agent.pending) {
        out.push({ ...base(agent), id: `${agent.key}|blocked|${agent.pending.kind}`, kind: "blocked", facts: { ...facts(agent), waitingFor: agent.pending.kind } });
        continue;
      }
      // Children are their parent's business while the parent is still working.
      if (agent.parentKey && parentWorking(agent)) continue;
      const age = now - Date.parse(agent.updatedAt);
      if (agent.state === "failed" && age < RECENT_MS) {
        out.push({ ...base(agent), id: `${agent.key}|failed|${agent.lastError ?? ""}`, kind: "failed", facts: { ...facts(agent), error: agent.lastError } });
      } else if ((agent.state === "completed" || agent.state === "idle") && agent.kind === "thread" && age < RECENT_MS) {
        const message = this.fleet.latestMessage(agent.key);
        if (message && message.role === "assistant" && QUESTION.test(message.text.slice(-600))) {
          out.push({
            ...base(agent),
            id: `${agent.key}|question|${message.at}`,
            kind: "question",
            facts: { ...facts(agent), lastMessageTail: message.text.slice(-1200) },
          });
        }
      } else if (agent.state === "running" && agent.kind === "thread") {
        const last = Date.parse(agent.activity?.at ?? agent.updatedAt);
        if (now - last > STALL_MS) {
          out.push({ ...base(agent), id: `${agent.key}|stalled|${Math.floor(last / STALL_MS)}`, kind: "stalled", facts: { ...facts(agent), minutesSinceLastActivity: Math.round((now - last) / 60e3) } });
        }
      }
    }

    for (const account of this.fleet.usage()) {
      for (const window of account.windows) {
        const left = 100 - window.usedPercent;
        if (left > 10) continue;
        out.push({
          id: `usage|${account.key}|${window.id}|${window.resetsAt ?? ""}`,
          kind: "usage",
          agentKey: null,
          machine: null,
          title: `${account.label} ${window.label}`,
          facts: { provider: account.label, window: window.label, leftPercent: Math.round(left), resetsAt: window.resetsAt, runningAgents: agents.filter((a) => a.state === "running").length },
        });
      }
    }

    for (const server of servers) {
      if (server.status === "connected") {
        this.offlineSince.delete(server.id);
        continue;
      }
      if (!this.offlineSince.has(server.id)) this.offlineSince.set(server.id, now);
      if (now - this.offlineSince.get(server.id)! > OFFLINE_MS) {
        out.push({
          id: `offline|${server.id}|${this.offlineSince.get(server.id)}`,
          kind: "offline",
          agentKey: null,
          machine: server.label,
          title: server.label,
          facts: { status: server.status, detail: server.statusDetail, offlineMinutes: Math.round((now - this.offlineSince.get(server.id)!) / 60e3) },
        });
      }
    }
    return out;
  }

  // ---- triage -----------------------------------------------------------------------------------

  private scan() {
    if (!this.config.enabled) return;
    const candidates = this.candidates();
    const live = new Set(candidates.map((c) => c.id));
    let changed = false;
    for (const alert of this.alerts.values()) {
      if (!alert.resolvedAt && !live.has(alert.id)) {
        alert.resolvedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.changed();
    const fresh = candidates.filter((c) => !this.decisions.has(c.id));
    if (fresh.length === 0 || this.triagePending) return;
    this.triagePending = true;
    void this.enqueue("triage", () => this.triage(fresh)).finally(() => (this.triagePending = false));
  }

  private async triage(candidates: Candidate[]) {
    let decided: Map<string, Decision>;
    let fromAgent = false;
    try {
      if (!this.config.codex) throw new Error("Codex CLI not found");
      decided = await this.judge(candidates);
      fromAgent = true;
    } catch (error) {
      console.warn(`[sentinel] agent triage failed, using rules: ${error instanceof Error ? error.message : error}`);
      decided = new Map(candidates.map((c) => [c.id, ruleDecision(c)]));
    }
    for (const candidate of candidates) {
      const decision = decided.get(candidate.id) ?? ruleDecision(candidate);
      this.decisions.set(candidate.id, decision);
      if (!decision.needsUser || decision.severity === "low" || this.alerts.has(candidate.id)) continue;
      const alert: Alert = {
        id: candidate.id,
        agentKey: candidate.agentKey,
        machine: candidate.machine,
        title: candidate.title,
        severity: decision.severity,
        headline: decision.headline || candidate.title,
        why: decision.why,
        action: decision.action,
        source: fromAgent && decided.has(candidate.id) ? "agent" : "rule",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        dismissedAt: null,
      };
      this.alerts.set(alert.id, alert);
      this.history.add({ serverId: "sentinel", agentKey: alert.agentKey, title: alert.title, kind: "blocked", text: `Alert: ${alert.headline}. ${alert.why}` });
      await this.notify(alert);
    }
    this.save();
    this.changed();
  }

  private async judge(candidates: Candidate[]): Promise<Map<string, Decision>> {
    const prompt = `You are the t3-fleet sentinel. The user runs many AI coding agents (T3 Code threads and their subagents) across several machines. Your only job: decide which of the candidates below REALLY need the user right now, so they get interrupted rarely and never for nothing.

Interrupt (needsUser=true) only when an agent genuinely cannot continue without the user, or something is broken that only the user can fix. Examples:
- an approval or question the agent is blocked on;
- a thread that failed with an error needing human action (auth expired, usage limit hit, missing credentials, crash), not one the agent recovered from;
- the agent finished but stopped on a real decision it cannot make itself;
- an agent that appears hung for a long time;
- provider usage almost exhausted while agents are running;
- a machine that went offline while it had work.

A "completed" or "idle" thread has ended its turn: if its last message asks the user to decide or provide something it cannot decide itself, that work IS waiting on the user.

Do NOT interrupt for: finished work that merely offers optional next steps ("want me to also…?"), routine completions, failures already retried or superseded by later activity, subagent failures their parent handles, long commands that are clearly still progressing.

Severity: "urgent" = work is stopped and waiting on the user now; "important" = should look soon; "low" = not worth an interruption.
Use the t3-fleet MCP tools (get_agent, recent_activity) to check context when a candidate is ambiguous. Do not run shell commands.

Candidates:
${JSON.stringify(candidates.map(({ id, kind, machine, title, agentKey, facts }) => ({ id, kind, machine, title, agentKey, facts })), null, 1)}

Return one decision per candidate id.`;
    const text = await this.runCodex(prompt, DECISION_SCHEMA);
    const parsed = JSON.parse(text);
    const out = new Map<string, Decision>();
    for (const d of parsed.decisions ?? []) {
      if (typeof d?.id !== "string") continue;
      out.set(d.id, { needsUser: !!d.needsUser, severity: d.severity, headline: String(d.headline ?? ""), why: String(d.why ?? ""), action: String(d.action ?? ""), decidedAt: new Date().toISOString() });
    }
    return out;
  }

  // ---- briefings and questions -----------------------------------------------------------------

  brief(): Promise<Briefing> {
    return this.enqueue("briefing", async () => {
      this.lastBriefAt = Date.now();
      this.lastActivityId = this.history.recent(1)[0]?.id ?? 0;
      const text = await this.runCodex(
        `Brief the user on their T3 Code agent fleet right now, using the t3-fleet MCP tools (start with fleet_overview; use recent_activity for the last hour).
Cover: what is running and where (machine, project, what it is doing), what finished or failed recently, anything that needs them, and provider usage left.
At most 5 "- " bullets of under 16 words each, most important first. No preamble, no headings, no bold. Name agents by title. Skip anything uneventful. Do not run shell commands.`,
      );
      this.briefing = { text: text.trim(), at: new Date().toISOString() };
      this.save();
      return this.briefing;
    });
  }

  ask(question: string): Promise<string> {
    return this.enqueue("question", () =>
      this.runCodex(
        `The user asks about their T3 Code agent fleet: "${question.replaceAll('"', "'").slice(0, 2000)}"
Answer using the t3-fleet MCP tools (fleet_overview, list_agents, get_agent, recent_activity, get_usage). Be concise and specific: name agents, machines and projects. Plain text, no preamble. Do not run shell commands.`,
      ).then((answer) => answer.trim()),
    );
  }

  // ---- plumbing --------------------------------------------------------------------------------

  private enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.busy = label;
      this.changed();
      try {
        return await task();
      } finally {
        this.busy = null;
        this.changed();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async runCodex(prompt: string, schema?: object): Promise<string> {
    if (!this.config.codex) throw new Error("Codex CLI not found; set sentinel.codex in config.json");
    const dir = join(tmpdir(), "t3-fleet");
    mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outFile = join(dir, `out-${stamp}.txt`);
    const args = [
      this.config.codex,
      "exec",
      // The user's own Codex config may load many MCP servers and plugins; the sentinel needs none.
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-m",
      this.config.model,
      "-c",
      `model_reasoning_effort="${this.config.effort}"`,
      "-c",
      `mcp_servers.t3fleet.url="${this.mcpUrl}"`,
      "-C",
      dir,
      "-o",
      outFile,
    ];
    if (schema) {
      const schemaFile = join(dir, `schema-${stamp}.json`);
      writeFileSync(schemaFile, JSON.stringify(schema));
      args.push("--output-schema", schemaFile);
    }
    args.push("-");
    const proc = Bun.spawn(args, { stdin: new Blob([prompt]), stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    if (code !== 0 || !existsSync(outFile)) throw new Error(`codex exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
    return readFileSync(outFile, "utf8");
  }

  private async notify(alert: Alert) {
    const title = alert.severity === "urgent" ? "Agent needs you" : "Agent needs attention";
    const subtitle = [alert.machine, alert.title].filter(Boolean).join(" · ").slice(0, 120);
    const message = `${alert.headline}. ${alert.action}`.slice(0, 240);
    const url = `${this.dashboardUrl}/${alert.agentKey ? `#agent=${encodeURIComponent(alert.agentKey)}` : ""}`;
    if (this.config.desktop) {
      try {
        if (process.platform === "darwin") {
          const notifier = Bun.which("terminal-notifier") ?? ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find(existsSync);
          if (notifier) {
            Bun.spawn([notifier, "-title", title, "-subtitle", subtitle, "-message", message, "-open", url, "-sound", "Glass", "-group", alert.id.slice(0, 60)]);
          } else {
            const q = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
            Bun.spawn(["osascript", "-e", `display notification ${q(message)} with title ${q(title)} subtitle ${q(subtitle)} sound name "Glass"`]);
          }
        } else if (Bun.which("notify-send")) {
          Bun.spawn(["notify-send", "-u", alert.severity === "urgent" ? "critical" : "normal", `${title}: ${subtitle}`, message]);
        }
      } catch (error) {
        console.warn(`[sentinel] desktop notification failed: ${error}`);
      }
    }
    if (this.config.ntfy) {
      await fetch(this.config.ntfy, {
        method: "POST",
        body: message,
        headers: { Title: `${title}: ${subtitle}`.slice(0, 200), Priority: alert.severity === "urgent" ? "high" : "default", Tags: "robot", Click: url },
      }).catch((error) => console.warn(`[sentinel] ntfy failed: ${error}`));
    }
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private load() {
    try {
      const state = JSON.parse(readFileSync(this.stateFile, "utf8"));
      for (const [id, decision] of Object.entries(state.decisions ?? {})) this.decisions.set(id, decision as Decision);
      for (const alert of state.alerts ?? []) this.alerts.set(alert.id, alert);
      this.briefing = state.briefing ?? null;
    } catch {}
  }

  private save() {
    // Forget decisions and closed alerts after two days so the file stays small.
    const cutoff = new Date(Date.now() - 2 * 86400e3).toISOString();
    for (const [id, decision] of this.decisions) if (decision.decidedAt < cutoff) this.decisions.delete(id);
    for (const [id, alert] of this.alerts) if ((alert.resolvedAt || alert.dismissedAt) && alert.createdAt < cutoff) this.alerts.delete(id);
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({ decisions: Object.fromEntries(this.decisions), alerts: [...this.alerts.values()], briefing: this.briefing }));
    } catch {}
  }
}

/** Used when no agent is available: only states that are unambiguous get an alert. */
function ruleDecision(candidate: Candidate): Decision {
  const decidedAt = new Date().toISOString();
  switch (candidate.kind) {
    case "blocked":
      return { needsUser: true, severity: "urgent", headline: `${candidate.title} is waiting for you`, why: `Blocked on ${String(candidate.facts.waitingFor ?? "input").replaceAll("_", " ")}.`, action: "Open the thread and respond.", decidedAt };
    case "offline":
      return { needsUser: true, severity: "important", headline: `${candidate.title} is unreachable`, why: String(candidate.facts.detail ?? "The machine stopped responding."), action: "Check the machine and its T3 Code server.", decidedAt };
    case "usage":
      return Number(candidate.facts.leftPercent) <= 5
        ? { needsUser: true, severity: "important", headline: `${candidate.title} almost used up`, why: `${candidate.facts.leftPercent}% left.`, action: "Pause or move work to another provider.", decidedAt }
        : { needsUser: false, severity: "low", headline: "", why: "", action: "", decidedAt };
    default:
      return { needsUser: false, severity: "low", headline: "", why: "", action: "", decidedAt };
  }
}
