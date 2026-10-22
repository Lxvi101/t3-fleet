import { describe, expect, test } from "bun:test";
import { applyShellItem, applyThreadItem, emptyDetail, emptyShell, owningSubagent, parseDescriptor, threadState } from "../src/t3/adapter.ts";

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: "t1",
  projectId: "p1",
  title: "Fix the thing",
  providerInstanceId: "claudeAgent",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  branch: "main",
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t1" },
  status: "idle",
  activeRunId: null,
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  createdAt: "2026-10-22T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:00.000Z",
  deletedAt: null,
  someFieldFromANewerServer: { anything: true },
  ...overrides,
});

const snapshot = (threads: unknown[]) => ({
  kind: "snapshot",
  snapshot: { schemaVersion: 2, snapshotSequence: 10, projects: [{ id: "p1", title: "app", workspaceRoot: "/src/app" }], threads, archivedThreads: [] },
});

describe("shell stream", () => {
  test("a project-metadata snapshot merges projects and keeps threads", () => {
    const shell = emptyShell();
    applyShellItem(shell, snapshot([thread()]));
    applyShellItem(shell, {
      kind: "snapshot",
      snapshot: { schemaVersion: 2, snapshotSequence: 10, projects: [{ id: "p1", title: "app (renamed)", workspaceRoot: "/src/app" }], threads: [], archivedThreads: [] },
      resolvedRepositoryIdentityRoots: ["/src/app"],
    });
    expect(shell.threads.size).toBe(1);
    expect(shell.projects.get("p1")?.title).toBe("app (renamed)");
  });

  test("tracks sequence and archives remove threads", () => {
    const shell = emptyShell();
    applyShellItem(shell, snapshot([thread()]));
    expect(shell.sequence).toBe(10);
    const change = applyShellItem(shell, { kind: "thread.updated", sequence: 11, location: "archive", thread: thread() });
    expect(change?.type).toBe("thread-removed");
    expect(shell.threads.size).toBe(0);
    expect(shell.sequence).toBe(11);
  });

  test("unknown item kinds are ignored but still advance the cursor", () => {
    const shell = emptyShell();
    expect(applyShellItem(shell, { kind: "something.new", sequence: 42 })).toBeNull();
    expect(shell.sequence).toBe(42);
  });

  test("state mapping prefers what needs the user", () => {
    const shell = emptyShell();
    applyShellItem(shell, snapshot([thread({ status: "running", pendingRuntimeRequest: { id: "r", kind: "command", createdAt: "x" } })]));
    expect(threadState(shell.threads.get("t1")!)).toBe("blocked");
    applyShellItem(shell, { kind: "thread.updated", sequence: 12, location: "active", thread: thread({ status: "running", pendingRuntimeRequest: { id: "r", kind: "command", createdAt: "x", blocking: false } }) });
    expect(threadState(shell.threads.get("t1")!)).toBe("running");
    applyShellItem(shell, { kind: "thread.updated", sequence: 13, location: "active", thread: thread({ status: "running", blockedOnThreadWait: true }) });
    expect(threadState(shell.threads.get("t1")!)).toBe("waiting");
  });

  test("an active run outranks a cancelled latest run", () => {
    const shell = emptyShell();
    applyShellItem(shell, snapshot([thread({ status: "cancelled", activeRunId: "run-1", activityRunStatus: "running" })]));
    expect(threadState(shell.threads.get("t1")!)).toBe("running");
  });
});

describe("thread stream", () => {
  test("attributes items to the native subagent they ran under", () => {
    const detail = emptyDetail();
    applyThreadItem(detail, {
      kind: "snapshot",
      snapshotSequence: 5,
      projection: {
        nodes: [
          { id: "root", parentNodeId: null },
          { id: "sub-1", parentNodeId: "root" },
          { id: "tool-a", parentNodeId: "sub-1" },
          { id: "tool-b", parentNodeId: "root" },
        ],
        subagents: [{ id: "sub-1", parentNodeId: "root", status: "running", prompt: "Look into flaky tests", updatedAt: "2026-10-22T10:00:00.000Z" }],
        turnItems: [],
      },
    });
    expect(owningSubagent(detail, "tool-a")).toBe("sub-1");
    expect(owningSubagent(detail, "tool-b")).toBeNull();
    // The delegating item sits on the subagent's own node and belongs to the parent.
    expect(owningSubagent(detail, "sub-1")).toBeNull();
  });

  test("describes items and recognizes test runs", () => {
    const detail = emptyDetail();
    const change = applyThreadItem(detail, {
      kind: "event",
      sequence: 6,
      event: { type: "turn-item.updated", payload: { id: "i1", type: "command_execution", status: "running", input: "cd /repo && bun test src", ordinal: 1, updatedAt: "2026-10-22T10:00:00.000Z" } },
    });
    expect(change?.type).toBe("item");
    const item = detail.items.get("i1")!;
    expect(item.type).toBe("test_run");
    expect(item.label).toBe("Running tests");
    expect(item.detail).toBe("bun test src");
    expect(detail.sequence).toBe(6);
  });

  test("unknown events are skipped", () => {
    const detail = emptyDetail();
    expect(applyThreadItem(detail, { kind: "event", sequence: 7, event: { type: "brand-new.event", payload: {} } })).toBeNull();
    expect(applyThreadItem(detail, { kind: "unknown-event", sequence: 8, eventType: "x" })).toBeNull();
    expect(detail.sequence).toBe(8);
  });
});

test("descriptor parsing tolerates missing fields", () => {
  expect(parseDescriptor({}).protocolVersion).toBeNull();
  expect(parseDescriptor({ orchestrationProtocolVersion: 2, platform: { os: "darwin", arch: "arm64" } })).toMatchObject({ protocolVersion: 2, platform: "darwin / arm64" });
});
