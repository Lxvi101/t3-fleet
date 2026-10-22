// Everything that knows t3code's wire shapes lives here, so an upstream protocol change is
// a change to this file only. Decoding is deliberately loose: unknown fields are ignored,
// unknown event and item types are skipped, and missing optional fields fall back.

import type { AgentState } from "../model.ts";

export const SUPPORTED_PROTOCOL_VERSIONS = [2];

export const RPC = {
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  subscribeServerConfig: "subscribeServerConfig",
} as const;

export const PATHS = {
  descriptor: "/.well-known/t3/environment",
  wsTicket: "/api/auth/websocket-ticket",
  ws: "/ws",
  protocolQueryParam: "orchestrationProtocol",
  ticketQueryParam: "wsTicket",
} as const;

export interface Descriptor {
  environmentId: string | null;
  label: string | null;
  serverVersion: string | null;
  protocolVersion: number | null;
  platform: string | null;
}

export function parseDescriptor(raw: any): Descriptor {
  const platform = raw?.platform;
  return {
    environmentId: str(raw?.environmentId),
    label: str(raw?.label),
    serverVersion: str(raw?.serverVersion),
    protocolVersion: typeof raw?.orchestrationProtocolVersion === "number" ? raw.orchestrationProtocolVersion : null,
    platform: platform ? [platform.os, platform.arch, platform.machine].filter(Boolean).join(" / ") : null,
  };
}

export function wsUrl(baseUrl: string, protocolVersion: number, ticket: string): string {
  const url = new URL(PATHS.ws, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(PATHS.protocolQueryParam, String(protocolVersion));
  url.searchParams.set(PATHS.ticketQueryParam, ticket);
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// Shell stream: projects and thread summaries for a whole environment.

export interface ProjectInfo {
  id: string;
  title: string;
  workspaceRoot: string | null;
}

export interface PendingRequest {
  kind: string;
  blocking: boolean;
}

export interface ThreadInfo {
  id: string;
  projectId: string | null;
  title: string;
  provider: string;
  model: string | null;
  branch: string | null;
  worktreePath: string | null;
  parentThreadId: string | null;
  relationship: "subagent" | "fork" | null;
  status: string;
  activityRunStatus: string | null;
  activeRunId: string | null;
  blockedOnThreadWait: boolean;
  pendingBackgroundTasks: number;
  pending: PendingRequest | null;
  lastError: string | null;
  latestMessage: { role: string; text: string; at: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Visible conversation items: a rough measure of how much work the thread has done. */
  items: number;
}

export interface ShellState {
  sequence: number | null;
  projects: Map<string, ProjectInfo>;
  threads: Map<string, ThreadInfo>;
}

export type ShellChange =
  | { type: "snapshot" }
  | { type: "synchronized" }
  | { type: "project" }
  | { type: "thread"; thread: ThreadInfo; previous: ThreadInfo | undefined }
  | { type: "thread-removed"; threadId: string; previous: ThreadInfo | undefined };

export function emptyShell(): ShellState {
  return { sequence: null, projects: new Map(), threads: new Map() };
}

export function applyShellItem(shell: ShellState, item: any): ShellChange | null {
  if (typeof item?.sequence === "number") shell.sequence = item.sequence;
  switch (item?.kind) {
    case "synchronized":
      return { type: "synchronized" };
    case "snapshot": {
      const snapshot = item.snapshot ?? {};
      // Snapshots carrying resolvedRepositoryIdentityRoots are project-metadata refreshes
      // (threads: []) that follow the authoritative snapshot; merge them, never replace.
      if (item.resolvedRepositoryIdentityRoots !== undefined) {
        for (const raw of arr(snapshot.projects)) {
          const project = parseProject(raw);
          if (project) shell.projects.set(project.id, project);
        }
        return { type: "project" };
      }
      shell.sequence = num(snapshot.snapshotSequence) ?? shell.sequence;
      shell.projects.clear();
      for (const raw of arr(snapshot.projects)) {
        const project = parseProject(raw);
        if (project) shell.projects.set(project.id, project);
      }
      shell.threads.clear();
      // Archived threads are finished history the dashboard does not track.
      for (const raw of arr(snapshot.threads)) {
        const thread = parseThread(raw);
        if (thread) shell.threads.set(thread.id, thread);
      }
      return { type: "snapshot" };
    }
    case "project.updated": {
      const project = parseProject(item.project);
      if (project) shell.projects.set(project.id, project);
      return { type: "project" };
    }
    case "project.removed":
      shell.projects.delete(item.projectId);
      return { type: "project" };
    case "thread.updated": {
      const thread = parseThread(item.thread);
      if (!thread) return null;
      const previous = shell.threads.get(thread.id);
      if (item.location === "archive") {
        shell.threads.delete(thread.id);
        return previous ? { type: "thread-removed", threadId: thread.id, previous } : null;
      }
      shell.threads.set(thread.id, thread);
      return { type: "thread", thread, previous };
    }
    case "thread.removed": {
      const previous = shell.threads.get(item.threadId);
      shell.threads.delete(item.threadId);
      return { type: "thread-removed", threadId: item.threadId, previous };
    }
    default:
      return null;
  }
}

function parseProject(raw: any): ProjectInfo | null {
  if (!str(raw?.id)) return null;
  return { id: raw.id, title: str(raw.title) ?? raw.id, workspaceRoot: str(raw.workspaceRoot) };
}

function parseThread(raw: any): ThreadInfo | null {
  if (!str(raw?.id) || raw.deletedAt) return null;
  const message = raw.latestVisibleMessage;
  const pending = raw.pendingRuntimeRequest;
  return {
    id: raw.id,
    projectId: str(raw.projectId),
    title: firstLine(str(raw.title) ?? "Untitled thread", 140),
    provider: str(raw.providerInstanceId) ?? str(raw.modelSelection?.instanceId) ?? "unknown",
    model: str(raw.modelSelection?.model),
    branch: str(raw.branch),
    worktreePath: str(raw.worktreePath),
    parentThreadId: str(raw.lineage?.parentThreadId),
    relationship: raw.lineage?.relationshipToParent === "fork" ? "fork" : raw.lineage?.relationshipToParent === "subagent" ? "subagent" : null,
    status: str(raw.status) ?? "idle",
    activityRunStatus: str(raw.activityRunStatus),
    activeRunId: str(raw.activeRunId),
    blockedOnThreadWait: raw.blockedOnThreadWait === true,
    pendingBackgroundTasks: arr(raw.pendingBackgroundTasks).length,
    pending: pending ? { kind: requestKind(pending.kind), blocking: pending.blocking !== false } : null,
    lastError: str(raw.lastError),
    latestMessage: message
      ? { role: str(message.role) ?? "assistant", text: truncate(str(message.text) ?? "", 600), at: str(message.updatedAt) ?? raw.updatedAt }
      : null,
    startedAt: str(raw.activityRunStartedAt) ?? str(raw.latestRunStartedAt),
    completedAt: str(raw.latestRunCompletedAt),
    items: num(raw.visibleItemCount) ?? num(raw.itemCount) ?? 0,
    createdAt: str(raw.createdAt) ?? new Date(0).toISOString(),
    updatedAt: str(raw.updatedAt) ?? str(raw.createdAt) ?? new Date(0).toISOString(),
  };
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function isThreadActive(thread: ThreadInfo): boolean {
  return ACTIVE_RUN_STATUSES.has(thread.status) || thread.activeRunId !== null || thread.pending !== null;
}

export function threadState(thread: ThreadInfo): AgentState {
  if (thread.pending?.blocking) return "blocked";
  if (thread.blockedOnThreadWait) return "waiting";
  // `status` is the latest run's outcome; a queued run that was cancelled leaves it "cancelled"
  // while an earlier run is still working. The active run's own status is the live truth.
  if (thread.activeRunId && thread.activityRunStatus) return thread.activityRunStatus === "waiting" ? "waiting" : "running";
  switch (thread.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "idle":
      return thread.activeRunId ? "running" : "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "cancelled";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------------------------
// Thread stream: runs, execution nodes, subagents and turn items for one thread.

export interface SubagentInfo {
  id: string;
  parentNodeId: string | null;
  childThreadId: string | null;
  origin: string;
  provider: string;
  model: string | null;
  title: string;
  prompt: string;
  status: string;
  progress: string | null;
  result: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ItemInfo {
  id: string;
  type: string;
  status: string;
  nodeId: string | null;
  ordinal: number;
  label: string;
  detail: string | null;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ThreadDetailState {
  sequence: number | null;
  synced: boolean;
  nodeParents: Map<string, string | null>;
  subagents: Map<string, SubagentInfo>;
  items: Map<string, ItemInfo>;
}

export type DetailChange =
  | { type: "snapshot" }
  | { type: "synchronized" }
  | { type: "item"; item: ItemInfo; previous: ItemInfo | undefined }
  | { type: "subagent"; subagent: SubagentInfo; previous: SubagentInfo | undefined }
  | { type: "other" };

const MAX_ITEMS_PER_THREAD = 300;

export function emptyDetail(): ThreadDetailState {
  return { sequence: null, synced: false, nodeParents: new Map(), subagents: new Map(), items: new Map() };
}

export function applyThreadItem(detail: ThreadDetailState, item: any): DetailChange | null {
  if (typeof item?.sequence === "number") detail.sequence = item.sequence;
  switch (item?.kind) {
    case "synchronized":
      detail.synced = true;
      return { type: "synchronized" };
    case "snapshot": {
      detail.sequence = num(item.snapshotSequence) ?? detail.sequence;
      const projection = item.projection ?? {};
      detail.nodeParents.clear();
      for (const node of arr(projection.nodes)) if (str(node?.id)) detail.nodeParents.set(node.id, str(node.parentNodeId));
      detail.subagents.clear();
      for (const raw of arr(projection.subagents)) {
        const subagent = parseSubagent(raw);
        if (subagent) detail.subagents.set(subagent.id, subagent);
      }
      detail.items.clear();
      for (const raw of arr(projection.turnItems)) {
        const parsed = parseItem(raw);
        if (parsed) detail.items.set(parsed.id, parsed);
      }
      pruneItems(detail);
      return { type: "snapshot" };
    }
    case "event":
      return applyEvent(detail, item.event);
    default:
      // "unknown-event" and future kinds: the sequence above still advances.
      return null;
  }
}

function applyEvent(detail: ThreadDetailState, event: any): DetailChange | null {
  const payload = event?.payload;
  switch (event?.type) {
    case "node.updated":
      if (str(payload?.id)) detail.nodeParents.set(payload.id, str(payload.parentNodeId));
      return { type: "other" };
    case "subagent.updated": {
      const subagent = parseSubagent(payload);
      if (!subagent) return null;
      const previous = detail.subagents.get(subagent.id);
      detail.subagents.set(subagent.id, subagent);
      return { type: "subagent", subagent, previous };
    }
    case "turn-item.updated": {
      const parsed = parseItem(payload);
      if (!parsed) return null;
      const previous = detail.items.get(parsed.id);
      detail.items.set(parsed.id, parsed);
      if (!previous) pruneItems(detail);
      return { type: "item", item: parsed, previous };
    }
    case "run.updated":
    case "runtime-request.updated":
      return { type: "other" };
    default:
      return null;
  }
}

function pruneItems(detail: ThreadDetailState) {
  if (detail.items.size <= MAX_ITEMS_PER_THREAD) return;
  const sorted = [...detail.items.values()].sort((a, b) => a.ordinal - b.ordinal);
  for (const item of sorted.slice(0, sorted.length - MAX_ITEMS_PER_THREAD)) detail.items.delete(item.id);
}

function parseSubagent(raw: any): SubagentInfo | null {
  if (!str(raw?.id)) return null;
  const prompt = str(raw.prompt) ?? "";
  return {
    id: raw.id,
    parentNodeId: str(raw.parentNodeId),
    childThreadId: str(raw.childThreadId),
    origin: str(raw.origin) ?? "provider_native",
    provider: str(raw.providerInstanceId) ?? str(raw.driver) ?? "unknown",
    model: str(raw.model) ?? str(raw.modelSelection?.model),
    title: firstLine(str(raw.title) ?? str(raw.workflow?.name) ?? (prompt || "Subagent"), 140),
    prompt: truncate(prompt, 2000),
    status: str(raw.status) ?? "running",
    progress: str(raw.progress),
    result: raw.result ? truncate(String(raw.result), 2000) : null,
    startedAt: str(raw.startedAt),
    completedAt: str(raw.completedAt),
    updatedAt: str(raw.updatedAt) ?? new Date().toISOString(),
  };
}

export function subagentState(subagent: SubagentInfo): AgentState {
  switch (subagent.status) {
    case "pending":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return "unknown";
  }
}

const TEST_COMMAND = /\b(vitest|jest|pytest|mocha|playwright test|cargo test|go test|bun test|swift test|xcodebuild test|(?:npm|pnpm|yarn|vp)(?: run)? test|rspec|phpunit)\b/;

function parseItem(raw: any): ItemInfo | null {
  if (!str(raw?.id) || !str(raw?.type)) return null;
  const { label, detail } = describeItem(raw);
  return {
    id: raw.id,
    type: raw.type === "command_execution" && TEST_COMMAND.test(String(raw.input ?? "")) ? "test_run" : raw.type,
    status: str(raw.status) ?? "completed",
    nodeId: str(raw.nodeId),
    ordinal: num(raw.ordinal) ?? 0,
    label,
    detail,
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
    startedAt: str(raw.startedAt),
    completedAt: str(raw.completedAt),
    updatedAt: str(raw.updatedAt) ?? str(raw.startedAt) ?? new Date().toISOString(),
  };
}

function describeItem(raw: any): { label: string; detail: string | null } {
  const running = raw.status === "running" || raw.streaming === true;
  switch (raw.type) {
    case "command_execution": {
      const command = firstLine(stripCd(String(raw.input ?? "")), 200);
      if (TEST_COMMAND.test(String(raw.input ?? ""))) return { label: running ? "Running tests" : "Ran tests", detail: command };
      return { label: running ? "Running command" : "Ran command", detail: command };
    }
    case "file_change": {
      const counts = raw.additions != null || raw.deletions != null ? ` (+${raw.additions ?? 0} −${raw.deletions ?? 0})` : "";
      return { label: running ? "Editing file" : "Edited file", detail: `${str(raw.fileName) ?? "file"}${counts}` };
    }
    case "reasoning":
      return { label: running ? "Thinking" : "Thought", detail: firstLine(String(raw.text ?? ""), 200) || null };
    case "assistant_message":
      return { label: running ? "Writing response" : "Responded", detail: firstLine(String(raw.text ?? ""), 200) || null };
    case "user_message":
      return { label: "User message", detail: firstLine(String(raw.text ?? ""), 200) || null };
    case "file_search":
      return { label: running ? "Searching files" : "Searched files", detail: str(raw.pattern) };
    case "web_search":
      return { label: running ? "Searching the web" : "Searched the web", detail: arr(raw.patterns).join(", ") || null };
    case "dynamic_tool":
      return { label: `${running ? "Calling" : "Called"} ${str(raw.toolName) ?? "tool"}`, detail: summarizeToolInput(raw.input) };
    case "subagent":
      return { label: running ? "Delegating to subagent" : "Subagent finished", detail: firstLine(str(raw.title) ?? String(raw.prompt ?? ""), 200) || null };
    case "approval_request":
      return { label: "Waiting for approval", detail: firstLine(str(raw.prompt) ?? str(raw.reason) ?? String(raw.requestKind ?? ""), 200) || null };
    case "user_input_request":
      return { label: "Asking the user", detail: firstLine(String(raw.questions?.[0]?.question ?? raw.questions?.[0]?.prompt ?? ""), 200) || null };
    case "todo_list":
      return { label: "Updated plan", detail: `${arr(raw.steps).length} steps` };
    case "proposed_plan":
      return { label: running ? "Drafting plan" : "Proposed plan", detail: firstLine(String(raw.markdown ?? ""), 200) || null };
    case "error":
      return { label: "Error", detail: firstLine(String(raw.failure?.message ?? raw.failure?.detail ?? raw.title ?? ""), 200) || null };
    case "compaction":
      return { label: running ? "Compacting context" : "Compacted context", detail: null };
    case "handoff":
      return { label: "Provider handoff", detail: null };
    case "checkpoint":
      return { label: "Checkpoint", detail: null };
    default:
      return { label: String(raw.title ?? raw.type).replaceAll("_", " "), detail: null };
  }
}

/** Items that only describe conversation flow, not work, never become an agent's activity. */
export function isWorkItem(item: ItemInfo): boolean {
  return item.type !== "user_message" && item.type !== "checkpoint";
}

/** The native subagent an item ran under, found by walking execution-node parents. */
export function owningSubagent(detail: ThreadDetailState, nodeId: string | null): string | null {
  let current = nodeId;
  for (let depth = 0; current && depth < 32; depth++) {
    const parent = detail.nodeParents.get(current) ?? null;
    if (parent && detail.subagents.has(parent)) return parent;
    current = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Server config stream: provider instances and the usage limits each one reports.

export interface UsageWindow {
  id: string;
  kind: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface ProviderUsage {
  /** Provider instance id, or `source:<id>/<account>` for accounts from a usage-limit source. */
  id: string;
  driver: string;
  label: string;
  account: string | null;
  plan: string | null;
  enabled: boolean;
  checkedAt: string | null;
  windows: UsageWindow[];
  /** The provider can't report windows here; `link` points to where it can. */
  unsupported: { message: string | null; link: { label: string; url: string } | null } | null;
  fingerprint: string | null;
}

export interface ConfigState {
  providers: ProviderUsage[];
  sources: ProviderUsage[];
}

export function emptyConfig(): ConfigState {
  return { providers: [], sources: [] };
}

/** Returns true when usage data changed. */
export function applyConfigItem(config: ConfigState, item: any): boolean {
  switch (item?.type) {
    case "snapshot":
      config.providers = arr(item.config?.providers).map(parseProvider).filter((p): p is ProviderUsage => p !== null);
      return true;
    case "providerStatuses":
      config.providers = arr(item.payload?.providers).map(parseProvider).filter((p): p is ProviderUsage => p !== null);
      return true;
    case "usageLimitSourcesUpdated":
      config.sources = arr(item.payload?.sources).flatMap((source: any) =>
        arr(source?.accounts).map((account: any) =>
          parseLimits(
            {
              id: `source:${source.id}/${account.id}`,
              driver: str(account.driver) ?? "unknown",
              label: str(source.label) ?? "Usage source",
              account: str(account.email),
              plan: str(account.plan),
              enabled: true,
            },
            account.usageLimits,
          ),
        ),
      );
      return true;
    default:
      return false;
  }
}

function parseProvider(raw: any): ProviderUsage | null {
  if (!str(raw?.instanceId) && !str(raw?.driver)) return null;
  return parseLimits(
    {
      id: str(raw.instanceId) ?? raw.driver,
      driver: str(raw.driver) ?? "unknown",
      label: str(raw.displayName) ?? str(raw.driver) ?? "Provider",
      account: str(raw.auth?.email),
      plan: str(raw.auth?.label),
      enabled: raw.enabled === true && raw.auth?.status !== "unauthenticated",
    },
    raw.usageLimits,
  );
}

function parseLimits(base: Omit<ProviderUsage, "checkedAt" | "windows" | "unsupported" | "fingerprint">, limits: any): ProviderUsage {
  const windows = arr(limits?.windows)
    .filter((w: any) => str(w?.id) && typeof w.usedPercent === "number")
    .map((w: any) => ({
      id: w.id,
      kind: str(w.kind) ?? "other",
      label: str(w.label) ?? w.id,
      usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
      resetsAt: str(w.resetsAt),
    }));
  const link = limits?.externalUsage && str(limits.externalUsage.url) ? { label: str(limits.externalUsage.label) ?? "Usage", url: limits.externalUsage.url } : null;
  return {
    ...base,
    checkedAt: str(limits?.checkedAt),
    windows,
    unsupported: windows.length === 0 && (limits?.unavailable || link) ? { message: str(limits?.unavailable?.message), link } : null,
    fingerprint: str(limits?.credentialFingerprint),
  };
}

// ---------------------------------------------------------------------------------------------

function requestKind(kind: unknown): string {
  if (typeof kind === "string") return kind;
  const obj = kind as any;
  return str(obj?.type) ?? str(obj?.kind) ?? str(obj?._tag) ?? "request";
}

function summarizeToolInput(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "string") return firstLine(input, 160);
  const obj = input as Record<string, unknown>;
  for (const key of ["description", "command", "path", "file_path", "url", "query", "pattern", "prompt"]) {
    if (typeof obj[key] === "string") return firstLine(obj[key] as string, 160);
  }
  return firstLine(JSON.stringify(input), 160);
}

function stripCd(command: string): string {
  return command.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, "");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arr(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(text: string, max: number): string {
  const line = text.trim().split("\n").find((part) => part.trim().length > 0) ?? "";
  return truncate(line.trim(), max);
}
