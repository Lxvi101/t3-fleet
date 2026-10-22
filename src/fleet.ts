import type { FleetConfig } from "./config.ts";
import type { HistoryStore } from "./history.ts";
import type { Activity, AgentDetail, AgentState, AgentView, HistoryEntry, ServerView, TimelineEntry, UsageAccount } from "./model.ts";
import {
  isThreadActive,
  isWorkItem,
  owningSubagent,
  subagentState,
  threadState,
  type DetailChange,
  type ItemInfo,
  type ProviderUsage,
  type ShellChange,
  type SubagentInfo,
  type ThreadInfo,
} from "./t3/adapter.ts";
import { ServerConnection, type DetailStream } from "./t3/connection.ts";

const FOCUS_MS = 3 * 60_000;
/** Keep a finished thread's stream briefly so its final events and subagent results arrive. */
const LINGER_MS = 45_000;
const ACTIVE_STATES = new Set<AgentState>(["running", "waiting", "blocked"]);

export interface FleetChanges {
  upserts: AgentView[];
  removals: string[];
  servers: ServerView[] | null;
  usage: UsageAccount[] | null;
}

export const threadKey = (serverId: string, threadId: string) => `${serverId}/${threadId}`;
export const subagentKey = (serverId: string, threadId: string, subagentId: string) => `${serverId}/${threadId}#${subagentId}`;

export class Fleet {
  readonly connections = new Map<string, ServerConnection>();
  private readonly focus = new Map<string, number>();
  private readonly lingerUntil = new Map<string, number>();
  /** Agent keys last sent per thread key, to detect removals. */
  private readonly sent = new Map<string, Set<string>>();
  private readonly dirtyThreads = new Set<string>();
  private serversDirty = true;
  private usageDirty = true;
  private readonly reconcileQueued = new Set<string>();

  constructor(
    private readonly config: FleetConfig,
    private readonly history: HistoryStore,
  ) {
    for (const server of config.servers) {
      const connection = new ServerConnection(server, {
        status: (c) => this.onStatus(c),
        shell: (c, change) => this.onShell(c, change),
        detail: (c, threadId, change) => this.onDetail(c, threadId, change),
        usage: () => (this.usageDirty = true),
      });
      this.connections.set(server.id, connection);
    }
    setInterval(() => {
      for (const connection of this.connections.values()) this.queueReconcile(connection);
    }, 10_000);
  }

  start() {
    for (const connection of this.connections.values()) connection.start();
  }

  stop() {
    for (const connection of this.connections.values()) connection.stop();
  }

  // ---- read side ------------------------------------------------------------------------------

  servers(): ServerView[] {
    return [...this.connections.values()].map((c) => ({
      id: c.id,
      label: c.label,
      url: c.baseUrl,
      status: c.status,
      statusDetail: c.statusDetail,
      environmentId: c.descriptor?.environmentId ?? null,
      serverVersion: c.descriptor?.serverVersion ?? null,
      protocolVersion: c.descriptor?.protocolVersion ?? null,
      platform: c.descriptor?.platform ?? null,
      connectedAt: c.connectedAt,
      lastSeenAt: c.lastSeenAt,
      threadCount: c.shell.threads.size,
      liveDetailCount: [...c.details.values()].filter((d) => d.live).length,
    }));
  }

  /** Usage left per provider account, merged across machines that share an account. */
  usage(): UsageAccount[] {
    const accounts = new Map<string, UsageAccount & { from: ProviderUsage }>();
    for (const connection of this.connections.values()) {
      const { providers, sources } = connection.usageState;
      for (const provider of [...providers, ...sources]) {
        if (!provider.enabled) continue;
        if (provider.windows.length === 0 && !provider.unsupported) continue;
        const key = usageKey(provider);
        const existing = accounts.get(key);
        const servers = [...new Set([...(existing?.servers ?? []), connection.label])];
        if (existing && (existing.checkedAt ?? "") >= (provider.checkedAt ?? "")) {
          existing.servers = servers;
          continue;
        }
        accounts.set(key, {
          key,
          driver: provider.driver,
          label: providerLabel(provider),
          account: provider.account,
          plan: provider.plan,
          windows: provider.windows,
          checkedAt: provider.checkedAt,
          servers,
          unsupported: provider.unsupported,
          from: provider,
        });
      }
    }
    return [...accounts.values()]
      .map(({ from: _from, ...account }) => account)
      .sort((a, b) => b.windows.length - a.windows.length || maxUsed(b) - maxUsed(a) || a.label.localeCompare(b.label));
  }

  agents(): AgentView[] {
    const views: AgentView[] = [];
    for (const connection of this.connections.values()) {
      for (const thread of connection.shell.threads.values()) views.push(...this.threadViews(connection, thread));
    }
    return views;
  }

  /** The thread's latest visible message, without attaching a detail stream. */
  latestMessage(key: string): { role: string; text: string; at: string } | null {
    const parsed = this.parseKey(key);
    return parsed && !parsed.subagentId ? parsed.thread.latestMessage : null;
  }

  agentDetail(key: string): AgentDetail | null {
    const parsed = this.parseKey(key);
    if (!parsed) return null;
    const { connection, thread, subagentId } = parsed;
    this.focus.set(threadKey(connection.id, thread.id), Date.now() + FOCUS_MS);
    this.queueReconcile(connection);
    const agent = this.threadViews(connection, thread).find((view) => view.key === key);
    if (!agent) return null;
    const stream = connection.details.get(thread.id);
    const subagent = subagentId ? stream?.state.subagents.get(subagentId) : undefined;
    const timeline: TimelineEntry[] = stream
      ? [...stream.state.items.values()]
          .filter((item) => owningSubagent(stream.state, item.nodeId) === (subagentId ?? null))
          .sort((a, b) => b.ordinal - a.ordinal)
          .slice(0, 80)
          .map((item) => ({ id: item.id, type: item.type, status: item.status, label: item.label, detail: item.detail, at: item.updatedAt }))
      : [];
    return {
      agent,
      server: this.servers().find((server) => server.id === connection.id) ?? null,
      prompt: subagent?.prompt ?? null,
      result: subagent?.result ?? null,
      lastMessage: subagentId ? (subagent?.progress ?? null) : (thread.latestMessage?.text ?? null),
      timeline,
    };
  }

  /** Views changed since the last call. */
  takeChanges(): FleetChanges {
    const upserts: AgentView[] = [];
    const removals: string[] = [];
    for (const dirty of this.dirtyThreads) {
      const [serverId, threadId] = splitOnce(dirty, "/");
      const connection = this.connections.get(serverId);
      const thread = connection?.shell.threads.get(threadId);
      const views = connection && thread ? this.threadViews(connection, thread) : [];
      const keys = new Set(views.map((view) => view.key));
      for (const key of this.sent.get(dirty) ?? []) if (!keys.has(key)) removals.push(key);
      if (keys.size > 0) this.sent.set(dirty, keys);
      else this.sent.delete(dirty);
      upserts.push(...views);
    }
    this.dirtyThreads.clear();
    const servers = this.serversDirty ? this.servers() : null;
    this.serversDirty = false;
    const usage = this.usageDirty ? this.usage() : null;
    this.usageDirty = false;
    return { upserts, removals, servers, usage };
  }

  // ---- views ----------------------------------------------------------------------------------

  private threadViews(connection: ServerConnection, thread: ThreadInfo): AgentView[] {
    const stream = connection.details.get(thread.id);
    const project = thread.projectId ? connection.shell.projects.get(thread.projectId) : undefined;
    const stale = connection.status !== "connected";
    const backing = this.backingSubagent(connection, thread);
    const state = this.effectiveState(connection, thread, backing);
    const fidelity: AgentView["fidelity"] = stream ? (stream.live ? "live" : "last") : "summary";
    const base = {
      serverId: connection.id,
      threadId: thread.id,
      projectId: thread.projectId,
      projectTitle: project?.title ?? null,
      cwd: thread.worktreePath ?? project?.workspaceRoot ?? null,
      branch: thread.branch,
      worktree: thread.worktreePath !== null,
      fidelity,
      stale,
    };
    const key = threadKey(connection.id, thread.id);
    const parentKey = thread.parentThreadId && connection.shell.threads.has(thread.parentThreadId) ? threadKey(connection.id, thread.parentThreadId) : null;
    const views: AgentView[] = [
      {
        ...base,
        key,
        kind: "thread",
        subagentId: null,
        parentKey,
        relationship: parentKey ? (backing?.origin === "provider_native" ? "native-subagent" : thread.relationship) : null,
        title: thread.title,
        provider: thread.provider,
        model: thread.model ?? backing?.model ?? null,
        state,
        rawStatus: backing?.status ?? thread.status,
        activity: activityFor(stream, null, ACTIVE_STATES.has(state)) ?? (backing && progressActivity(backing)) ?? messageActivity(thread),
        pending: thread.pending,
        lastError: thread.lastError ?? (backing?.status === "failed" ? backing.result : null),
        startedAt: backing?.startedAt ?? thread.startedAt,
        completedAt: backing?.completedAt ?? thread.completedAt,
        createdAt: thread.createdAt,
        updatedAt: backing && backing.updatedAt > thread.updatedAt ? backing.updatedAt : thread.updatedAt,
      },
    ];
    if (!stream) return views;
    for (const subagent of stream.state.subagents.values()) {
      // App-owned subagents are full threads and already appear through shell lineage.
      if (subagent.childThreadId && connection.shell.threads.has(subagent.childThreadId)) continue;
      const enclosing = owningSubagent(stream.state, subagent.id);
      let subState = subagentState(subagent);
      // A provider that stops reporting leaves children "running" after the parent finished.
      if (ACTIVE_STATES.has(subState) && !ACTIVE_STATES.has(state)) subState = "unknown";
      views.push({
        ...base,
        key: subagentKey(connection.id, thread.id, subagent.id),
        kind: "subagent",
        subagentId: subagent.id,
        parentKey: enclosing ? subagentKey(connection.id, thread.id, enclosing) : key,
        relationship: "native-subagent",
        title: subagent.title,
        provider: subagent.provider,
        model: subagent.model,
        state: subState,
        rawStatus: subagent.status,
        activity: activityFor(stream, subagent.id, ACTIVE_STATES.has(subState)) ?? progressActivity(subagent),
        pending: null,
        lastError: subagent.status === "failed" ? subagent.result : null,
        startedAt: subagent.startedAt,
        completedAt: subagent.completedAt,
        createdAt: subagent.startedAt ?? thread.createdAt,
        updatedAt: subagent.updatedAt,
      });
    }
    return views;
  }

  /**
   * The parent's subagent record for a child thread. Provider-native subagents (Claude's Task tool)
   * appear in the shell as child threads that always report "idle"; their real lifecycle is this
   * record, which is only known while the parent's detail stream is (or was) attached.
   */
  private backingSubagent(connection: ServerConnection, thread: ThreadInfo): SubagentInfo | null {
    if (!thread.parentThreadId) return null;
    const parentStream = connection.details.get(thread.parentThreadId);
    if (!parentStream) return null;
    for (const subagent of parentStream.state.subagents.values()) if (subagent.childThreadId === thread.id) return subagent;
    return null;
  }

  private effectiveState(connection: ServerConnection, thread: ThreadInfo, backing = this.backingSubagent(connection, thread)): AgentState {
    const own = threadState(thread);
    if (!backing || ACTIVE_STATES.has(own)) return own;
    const state = subagentState(backing);
    const parent = thread.parentThreadId ? connection.shell.threads.get(thread.parentThreadId) : undefined;
    // A provider that stops reporting leaves children "running" after the parent finished.
    if (ACTIVE_STATES.has(state) && parent && !ACTIVE_STATES.has(threadState(parent))) return "unknown";
    return state;
  }

  private parseKey(key: string) {
    const [serverId, rest] = splitOnce(key, "/");
    const [threadId, subagentId] = splitOnce(rest, "#");
    const connection = this.connections.get(serverId);
    const thread = connection?.shell.threads.get(threadId);
    if (!connection || !thread) return null;
    return { connection, thread, subagentId: subagentId || null };
  }

  // ---- write side -----------------------------------------------------------------------------

  private onStatus(connection: ServerConnection) {
    this.serversDirty = true;
    for (const threadId of connection.shell.threads.keys()) this.dirtyThreads.add(threadKey(connection.id, threadId));
    if (connection.status === "connected") {
      this.record(connection, null, null, "server", `Connected to ${connection.label} (t3code ${connection.descriptor?.serverVersion ?? "?"})`);
    } else if (connection.status !== "connecting") {
      const last = this.history.recent(50).findLast((entry) => entry.serverId === connection.id && entry.kind === "server");
      const text = `${connection.label} ${connection.status}${connection.statusDetail ? `: ${connection.statusDetail}` : ""}`;
      if (last?.text !== text) this.record(connection, null, null, "server", text);
    }
  }

  private onShell(connection: ServerConnection, change: ShellChange) {
    this.serversDirty = true;
    switch (change.type) {
      case "snapshot":
      case "synchronized":
      case "project":
        for (const threadId of connection.shell.threads.keys()) this.dirtyThreads.add(threadKey(connection.id, threadId));
        for (const key of this.sent.keys()) if (key.startsWith(`${connection.id}/`)) this.dirtyThreads.add(key);
        break;
      case "thread": {
        const { thread, previous } = change;
        this.dirtyThreads.add(threadKey(connection.id, thread.id));
        if (thread.parentThreadId) this.dirtyThreads.add(threadKey(connection.id, thread.parentThreadId));
        if (connection.synced) this.recordThreadTransition(connection, thread, previous);
        if (previous && isThreadActive(previous) && !isThreadActive(thread)) {
          this.lingerUntil.set(threadKey(connection.id, thread.id), Date.now() + LINGER_MS);
        }
        break;
      }
      case "thread-removed":
        this.dirtyThreads.add(threadKey(connection.id, change.threadId));
        connection.details.get(change.threadId)?.cancel?.();
        connection.details.delete(change.threadId);
        break;
    }
    this.queueReconcile(connection);
  }

  private onDetail(connection: ServerConnection, threadId: string, change: DetailChange) {
    const thread = connection.shell.threads.get(threadId);
    this.dirtyThreads.add(threadKey(connection.id, threadId));
    this.serversDirty = true;
    const stream = connection.details.get(threadId);
    // Child threads take their state from subagent records here.
    if (change.type === "snapshot" || change.type === "synchronized") {
      for (const subagent of stream?.state.subagents.values() ?? []) {
        if (subagent.childThreadId) this.dirtyThreads.add(threadKey(connection.id, subagent.childThreadId));
      }
    }
    if (change.type === "subagent" && change.subagent.childThreadId) {
      this.dirtyThreads.add(threadKey(connection.id, change.subagent.childThreadId));
      this.queueReconcile(connection);
    }
    if (!thread || !stream?.state.synced) return;
    if (change.type === "item") this.recordItem(connection, thread, stream, change.item, change.previous);
    if (change.type === "subagent") this.recordSubagent(connection, thread, change.subagent, change.previous);
  }

  private queueReconcile(connection: ServerConnection) {
    if (this.reconcileQueued.has(connection.id)) return;
    this.reconcileQueued.add(connection.id);
    setTimeout(() => {
      this.reconcileQueued.delete(connection.id);
      this.reconcile(connection);
    }, 100);
  }

  /** Detail streams follow the threads that are working, lingering, or open in the dashboard. */
  private reconcile(connection: ServerConnection) {
    const now = Date.now();
    const candidates: { id: string; priority: number; updatedAt: string }[] = [];
    for (const thread of connection.shell.threads.values()) {
      const key = threadKey(connection.id, thread.id);
      const focused = (this.focus.get(key) ?? 0) > now;
      const lingering = (this.lingerUntil.get(key) ?? 0) > now;
      if (focused) candidates.push({ id: thread.id, priority: 0, updatedAt: thread.updatedAt });
      else if (isThreadActive(thread) || ACTIVE_STATES.has(this.effectiveState(connection, thread))) candidates.push({ id: thread.id, priority: 1, updatedAt: thread.updatedAt });
      else if (lingering) candidates.push({ id: thread.id, priority: 2, updatedAt: thread.updatedAt });
    }
    candidates.sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
    connection.setDetailThreads(new Set(candidates.slice(0, this.config.maxDetailStreams).map((c) => c.id)));
    for (const [key, until] of this.focus) if (until <= now) this.focus.delete(key);
    for (const [key, until] of this.lingerUntil) if (until <= now) this.lingerUntil.delete(key);
  }

  // ---- history --------------------------------------------------------------------------------

  private record(connection: ServerConnection, agentKey: string | null, title: string | null, kind: HistoryEntry["kind"], text: string) {
    this.history.add({ serverId: connection.id, agentKey, title, kind, text });
  }

  private recordThreadTransition(connection: ServerConnection, thread: ThreadInfo, previous: ThreadInfo | undefined) {
    const key = threadKey(connection.id, thread.id);
    if (!previous) {
      const parent = thread.parentThreadId ? connection.shell.threads.get(thread.parentThreadId) : undefined;
      const text = parent
        ? `${thread.relationship === "fork" ? "Forked from" : "Spawned by"} “${parent.title}”`
        : "New thread";
      this.record(connection, key, thread.title, "spawn", text);
      return;
    }
    const before = threadState(previous);
    const after = threadState(thread);
    if (before === after) return;
    switch (after) {
      case "running":
        if (before !== "waiting" && before !== "blocked") this.record(connection, key, thread.title, "lifecycle", "Started working");
        else this.record(connection, key, thread.title, "lifecycle", "Resumed");
        break;
      case "blocked":
        this.record(connection, key, thread.title, "blocked", `Needs you: ${humanizeRequest(thread.pending?.kind)}`);
        break;
      case "waiting":
        this.record(connection, key, thread.title, "lifecycle", thread.blockedOnThreadWait ? "Waiting on subagents" : "Waiting");
        break;
      case "completed":
        this.record(connection, key, thread.title, "lifecycle", "Completed");
        break;
      case "failed":
        this.record(connection, key, thread.title, "error", `Failed${thread.lastError ? `: ${thread.lastError.slice(0, 200)}` : ""}`);
        break;
      case "cancelled":
        this.record(connection, key, thread.title, "lifecycle", "Stopped");
        break;
      case "idle":
        if (ACTIVE_STATES.has(before)) this.record(connection, key, thread.title, "lifecycle", "Went idle");
        break;
    }
  }

  private recordItem(connection: ServerConnection, thread: ThreadInfo, stream: DetailStream, item: ItemInfo, previous: ItemInfo | undefined) {
    const finished = item.status !== "running" && item.status !== "pending";
    const newlyFinished = finished && (!previous || previous.status === "running" || previous.status === "pending");
    const owner = owningSubagent(stream.state, item.nodeId);
    const key = owner ? subagentKey(connection.id, thread.id, owner) : threadKey(connection.id, thread.id);
    const title = owner ? (stream.state.subagents.get(owner)?.title ?? thread.title) : thread.title;
    switch (item.type) {
      case "test_run":
        if (newlyFinished) {
          const ok = item.status === "completed" && (item.exitCode ?? 0) === 0;
          this.record(connection, key, title, ok ? "tool" : "error", `${ok ? "Tests passed" : "Tests failed"}: ${item.detail ?? ""}`);
        }
        break;
      case "command_execution":
        if (newlyFinished) {
          const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
          this.record(connection, key, title, "tool", `${failed ? `Command failed (exit ${item.exitCode ?? "?"})` : "Ran"}: ${item.detail ?? ""}`);
        }
        break;
      case "file_change":
        if (newlyFinished) this.record(connection, key, title, "edit", `Edited ${item.detail ?? "a file"}`);
        break;
      case "error":
        if (!previous) this.record(connection, key, title, "error", `Error: ${item.detail ?? "unknown"}`);
        break;
    }
  }

  private recordSubagent(connection: ServerConnection, thread: ThreadInfo, subagent: SubagentInfo, previous: SubagentInfo | undefined) {
    const childInShell = subagent.childThreadId !== null && connection.shell.threads.has(subagent.childThreadId);
    const key = childInShell ? threadKey(connection.id, subagent.childThreadId!) : subagentKey(connection.id, thread.id, subagent.id);
    if (!previous) {
      // Child threads already got a spawn entry from the shell stream.
      if (childInShell) return;
      this.record(connection, key, subagent.title, "spawn", `Spawned by “${thread.title}”${subagent.model ? ` (${subagent.model})` : ""}`);
      return;
    }
    if (previous.status === subagent.status) return;
    const state = subagentState(subagent);
    if (state === "completed") this.record(connection, key, subagent.title, "lifecycle", "Subagent completed");
    else if (state === "failed") this.record(connection, key, subagent.title, "error", "Subagent failed");
    else if (state === "cancelled") this.record(connection, key, subagent.title, "lifecycle", "Subagent stopped");
  }
}

function activityFor(stream: DetailStream | undefined, subagentId: string | null, agentActive: boolean): Activity | null {
  if (!stream) return null;
  let running: ItemInfo | null = null;
  let latest: ItemInfo | null = null;
  for (const item of stream.state.items.values()) {
    if (!isWorkItem(item) || owningSubagent(stream.state, item.nodeId) !== subagentId) continue;
    if (item.status === "running" && (!running || item.updatedAt > running.updatedAt)) running = item;
    if (!latest || item.ordinal > latest.ordinal) latest = item;
  }
  const pick = agentActive && stream.live && running ? running : latest;
  if (!pick) return null;
  return {
    type: pick.type,
    label: pick.label,
    detail: pick.detail,
    at: pick.updatedAt,
    live: agentActive && stream.live && pick.status === "running",
  };
}

function messageActivity(thread: ThreadInfo): Activity | null {
  if (!thread.latestMessage) return null;
  return {
    type: "message",
    label: thread.latestMessage.role === "user" ? "User said" : "Last message",
    detail: thread.latestMessage.text.split("\n").find((line) => line.trim()) ?? null,
    at: thread.latestMessage.at,
    live: false,
  };
}

function progressActivity(subagent: SubagentInfo): Activity | null {
  if (!subagent.progress) return null;
  return { type: "progress", label: "Progress", detail: subagent.progress, at: subagent.updatedAt, live: false };
}

function humanizeRequest(kind: string | undefined): string {
  if (!kind) return "input requested";
  return kind.replaceAll(/[_-]/g, " ");
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index + 1)];
}

const PROVIDER_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
  antigravity: "Antigravity",
};

function providerLabel(provider: ProviderUsage): string {
  if (provider.id.startsWith("source:")) return `${PROVIDER_NAMES[provider.driver] ?? provider.driver} · ${provider.label}`;
  return provider.label === provider.driver ? (PROVIDER_NAMES[provider.driver] ?? provider.label) : provider.label;
}

/**
 * One subscription often backs the same provider on several machines. Identify the account by
 * fingerprint or email when reported, otherwise by its windows' reset times (rounded, since each
 * machine probes at a slightly different moment).
 */
function usageKey(provider: ProviderUsage): string {
  if (provider.fingerprint) return `${provider.driver}|fp:${provider.fingerprint}`;
  if (provider.account) return `${provider.driver}|${provider.account}`;
  if (provider.windows.length) {
    const resets = provider.windows
      .map((w) => `${w.id}:${w.resetsAt ? Math.round(Date.parse(w.resetsAt) / 300_000) : "-"}`)
      .sort()
      .join(",");
    return `${provider.driver}|${resets}`;
  }
  return `${provider.driver}|${provider.unsupported?.link?.url ?? "unreported"}`;
}

function maxUsed(account: UsageAccount): number {
  return Math.max(0, ...account.windows.map((w) => w.usedPercent));
}
