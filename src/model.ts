// Normalized fleet model. Nothing here knows t3code's wire shapes; see src/t3/adapter.ts.

export type AgentState =
  | "running"
  | "waiting" // waiting on its own subagents or a background task
  | "blocked" // waiting on the user: approval or question
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type ServerStatus = "connecting" | "connected" | "offline" | "unauthorized" | "incompatible";

export interface ServerView {
  id: string;
  label: string;
  url: string | null;
  status: ServerStatus;
  statusDetail: string | null;
  environmentId: string | null;
  serverVersion: string | null;
  protocolVersion: number | null;
  platform: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  threadCount: number;
  liveDetailCount: number;
}

export interface Activity {
  type: string;
  label: string;
  detail: string | null;
  at: string;
  /** True while the provider reports the item as in progress; false means last observed. */
  live: boolean;
}

export interface AgentView {
  key: string;
  serverId: string;
  kind: "thread" | "subagent";
  threadId: string;
  subagentId: string | null;
  parentKey: string | null;
  relationship: "subagent" | "fork" | "native-subagent" | null;
  title: string;
  provider: string;
  model: string | null;
  projectId: string | null;
  projectTitle: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: boolean;
  state: AgentState;
  rawStatus: string;
  activity: Activity | null;
  /** live: detail stream attached; last: detail frozen after the stream ended; summary: shell only. */
  fidelity: "live" | "last" | "summary";
  pending: { kind: string; blocking: boolean } | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Stable ordering key for layouts. */
  createdAt: string;
  updatedAt: string;
  /** Server is unreachable; everything above is the last value seen. */
  stale: boolean;
}

export interface TimelineEntry {
  id: string;
  type: string;
  status: string;
  label: string;
  detail: string | null;
  at: string;
}

export interface AgentDetail {
  agent: AgentView;
  server: ServerView | null;
  prompt: string | null;
  result: string | null;
  lastMessage: string | null;
  timeline: TimelineEntry[];
}

export interface HistoryEntry {
  id: number;
  at: string;
  serverId: string;
  agentKey: string | null;
  /** Agent title at the time, so persisted entries stay readable after the agent is gone. */
  title: string | null;
  kind: "server" | "lifecycle" | "spawn" | "tool" | "edit" | "blocked" | "error";
  text: string;
}

export interface UsageAccount {
  key: string;
  driver: string;
  label: string;
  account: string | null;
  plan: string | null;
  windows: { id: string; kind: string; label: string; usedPercent: number; resetsAt: string | null }[];
  checkedAt: string | null;
  /** Machines reporting this account. Several machines often share one subscription. */
  servers: string[];
  unsupported: { message: string | null; link: { label: string; url: string } | null } | null;
}
