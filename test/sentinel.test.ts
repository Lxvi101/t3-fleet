import { describe, expect, test } from "bun:test";
import type { AgentView } from "../src/model.ts";
import { Sentinel } from "../src/sentinel.ts";

const now = new Date().toISOString();
const agent = (overrides: Partial<AgentView>): AgentView => ({
  key: "m/t1",
  serverId: "m",
  kind: "thread",
  threadId: "t1",
  subagentId: null,
  parentKey: null,
  relationship: null,
  title: "Fix login",
  provider: "codex",
  model: null,
  projectId: null,
  projectTitle: "app",
  cwd: null,
  branch: null,
  worktree: false,
  state: "idle",
  rawStatus: "idle",
  activity: null,
  fidelity: "summary",
  pending: null,
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
  work: 0,
  stale: false,
  ...overrides,
});

function sentinelFor(agents: AgentView[], messages: Record<string, string> = {}, servers: { id: string; label: string; status: string; statusDetail: string | null }[] = [{ id: "m", label: "Mac", status: "connected", statusDetail: null }]) {
  const fleet = {
    agents: () => agents,
    servers: () => servers,
    usage: () => [],
    latestMessage: (key: string) => (messages[key] ? { role: "assistant", text: messages[key], at: now } : null),
  };
  const history = { recent: () => [], add() {} };
  const config = { enabled: true, codex: null, model: "gpt-6-luna", effort: "low", briefEveryMinutes: 0, desktop: false, ntfy: null };
  return new Sentinel(fleet as any, history as any, config, "", "", `/tmp/t3-fleet-test-${Math.random()}`);
}

describe("sentinel candidates", () => {
  test("a blocked agent is always a candidate", () => {
    const kinds = sentinelFor([agent({ state: "blocked", pending: { kind: "command_approval", blocking: true } })]).candidates().map((c) => c.kind);
    expect(kinds).toEqual(["blocked"]);
  });

  test("a failed child is its working parent's business", () => {
    const parent = agent({ key: "m/p", state: "running" });
    const child = agent({ key: "m/c", parentKey: "m/p", relationship: "subagent", state: "failed", lastError: "boom" });
    expect(sentinelFor([parent, child]).candidates()).toEqual([]);
  });

  test("a finished thread only counts when its last message asks the user something", () => {
    const asking = agent({ key: "m/a", state: "completed" });
    const done = agent({ key: "m/b", state: "completed" });
    const candidates = sentinelFor([asking, done], { "m/a": "Tests pass. Should I merge it into main?", "m/b": "All done, tests pass." }).candidates();
    expect(candidates.map((c) => c.agentKey)).toEqual(["m/a"]);
  });

  test("an unreachable machine waits a few minutes before it is a candidate", () => {
    const sentinel = sentinelFor([], {}, [{ id: "m", label: "Mac", status: "offline", statusDetail: "unreachable" }]);
    expect(sentinel.candidates()).toEqual([]);
  });
});
