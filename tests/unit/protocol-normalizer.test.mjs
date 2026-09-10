import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupervisorAdapter,
  createFakeSupervisorAdapter,
  SUPERVISOR_ADAPTER_METHODS,
} from "../../src/adapters/supervisor/app-server-adapter.mjs";
import { EventStore } from "../../vendor/codex-supervisor-mcp/src/event-store.mjs";
import { createHistoryAdapter } from "../../src/adapters/supervisor/history-adapter.mjs";
import {
  normalizeEvent,
  normalizeTurn,
  extractTurnChanges,
} from "../../src/adapters/supervisor/protocol-normalizer.mjs";
import { publicProjection } from "../../src/shared/protocol.mjs";

test("normalizeEvent returns a bounded public projection without internal ids", () => {
  const event = normalizeEvent({
    method: "turn/completed",
    kind: "notification",
    threadId: "thread-1",
    turnId: "turn-1",
    eventCursor: 17,
    params: {
      turnId: "turn-1",
      eventCursor: 17,
      repositoryDiff: { files: ["dirty-before-turn.txt"] },
    },
    turn: {
      id: "turn-1",
      status: "completed",
      assistantMessage: "done",
      changes: {
        files: ["src/one.mjs"],
      },
    },
  });

  assert.deepEqual(event, {
    type: "turn.completed",
    threadId: "thread-1",
    status: "completed",
    assistantMessage: "done",
    changes: { files: ["src/one.mjs"], filesChanged: 1, filesTruncated: false },
  });
  assert.equal(event.internalTurnId, "turn-1");
  assert.equal(event.verifiedTurnIdentity, true);
  assert.equal(Object.keys(event).includes("internalTurnId"), false);
  assert.equal(Object.keys(event).includes("verifiedTurnIdentity"), false);
  assert.doesNotMatch(JSON.stringify(event), /turnId|eventCursor|cursor|repositoryDiff/);
  assert.deepEqual(publicProjection(event), {
    type: "turn.completed",
    threadId: "thread-1",
    status: "completed",
    assistantMessage: "done",
    changes: { files: ["src/one.mjs"], filesChanged: 1, filesTruncated: false },
  });
});

test("normalizeEvent rejects conflicting thread and turn identities", () => {
  const conflict = normalizeEvent({
    method: "turn/completed",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {
      threadId: "thread-2",
      turn: { id: "turn-2", status: "completed" },
    },
  });

  assert.equal(conflict.threadId, null);
  assert.equal("internalTurnId" in conflict, false);
  assert.equal(conflict.verifiedThreadIdentity, false);
  assert.equal(conflict.verifiedTurnIdentity, false);
  assert.equal("status" in conflict, false);
  assert.equal(conflict.verifiedTerminalStatus, false);
  assert.equal(Object.keys(conflict).includes("verifiedTurnIdentity"), false);
});

test("normalizeEvent preserves terminal status provenance and rejects status conflicts", () => {
  for (const [method, status] of [
    ["turn/completed", "completed"],
    ["turn/failed", "failed"],
    ["turn/interrupted", "interrupted"],
  ]) {
    const event = normalizeEvent({
      method,
      threadId: "thread-status",
      turnId: "turn-status",
      turn: { id: "turn-status", status },
    });
    assert.equal(event.status, status);
    assert.equal(event.verifiedTerminalStatus, true);
    assert.ok(event.internalStatusSources.some((source) => source.source === "event.type"));
    assert.equal(Object.keys(event).includes("internalStatusSources"), false);
  }

  for (const input of [
    {
      method: "turn/completed",
      turn: { id: "turn-status", status: "failed" },
    },
    {
      method: "turn/failed",
      turn: { id: "turn-status", status: "completed" },
    },
    {
      method: "turn/interrupted",
      turn: { id: "turn-status", status: "running" },
    },
    {
      method: "error",
      kind: "lifecycle",
      status: "completed",
      params: { error: { source: "app-server-process" } },
    },
  ]) {
    const event = normalizeEvent({
      threadId: "thread-status",
      turnId: "turn-status",
      ...input,
    });
    assert.equal("status" in event, false);
    assert.equal(event.verifiedTerminalStatus, false);
  }
});

test("normalizeEvent rejects nested thread and turn identity conflicts as non-terminal", () => {
  const threadConflict = normalizeEvent({
    method: "turn/completed",
    threadId: "thread-1",
    turnId: "turn-1",
    turn: {
      id: "turn-1",
      thread: { id: "thread-2" },
      status: "completed",
    },
  });
  assert.equal(threadConflict.threadId, null);
  assert.equal(threadConflict.verifiedThreadIdentity, false);
  assert.equal(threadConflict.verifiedTerminalStatus, false);
  assert.equal("status" in threadConflict, false);

  const turnConflict = normalizeEvent({
    method: "turn/completed",
    threadId: "thread-1",
    internalTurnId: "turn-1",
    turnRecord: { id: "turn-2", status: "completed" },
  });
  assert.equal(turnConflict.verifiedTurnIdentity, false);
  assert.equal("internalTurnId" in turnConflict, false);
  assert.equal(turnConflict.verifiedTerminalStatus, false);
  assert.equal("status" in turnConflict, false);
});

test("normalizeEvent supports vendor EventStore params.turn, params.item and params.diff", () => {
  const completed = normalizeEvent({
    sequence: 21,
    receivedAt: "secret",
    method: "turn/completed",
    kind: "notification",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: "final answer" }],
      },
      diff: { turnId: "turn-1", files: ["src/changed.mjs"] },
      item: { type: "agentMessage", turnId: "turn-1", text: "ignored duplicate" },
    },
  });
  assert.deepEqual(completed, {
    type: "turn.completed",
    threadId: "thread-1",
    status: "completed",
    assistantMessage: "final answer",
    changes: { files: ["src/changed.mjs"], filesChanged: 1, filesTruncated: false },
  });

  const diff = normalizeEvent({
    method: "turn/diff/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      diff: { turnId: "turn-1", fileChanges: [{ path: "src/file.mjs", kind: "modified" }] },
    },
  });
  assert.deepEqual(diff, {
    type: "turn.diff.updated",
    threadId: "thread-1",
    changes: {
      files: [{ path: "src/file.mjs", kind: "modified" }],
      filesChanged: 1,
      filesTruncated: false,
    },
  });
  assert.deepEqual(normalizeTurn({
    id: "turn-1",
    status: { type: "completed" },
    items: [{ type: "agentMessage", content: [{ type: "text", text: "from history" }] }],
  }), {
    status: "completed",
    finalAssistantMessage: "from history",
    changes: { files: [], filesChanged: 0, filesTruncated: false },
  });
});

test("ordinary error and item completion are not terminal events", () => {
  const error = normalizeEvent({
    method: "error",
    threadId: "thread-1",
    params: { error: { code: "request_error", message: "retryable" } },
  });
  assert.deepEqual(error, {
    type: "error",
    threadId: "thread-1",
    error: { code: "request_error", message: "retryable" },
  });
  assert.equal("status" in error, false);

  const item = normalizeEvent({
    method: "item/completed",
    threadId: "thread-1",
    params: {
      turnId: "turn-1",
      item: { type: "agentMessage", status: "completed", text: "item done" },
    },
  });
  assert.deepEqual(item, {
    type: "item.completed",
    threadId: "thread-1",
    assistantMessage: "item done",
  });
  assert.equal("status" in item, false);

  const processFailure = normalizeEvent({
    sequence: 44,
    method: "error",
    kind: "lifecycle",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {
      error: {
        type: "AppServerError",
        source: "app-server-process",
        message: "raw process details",
      },
    },
  });
  assert.deepEqual(processFailure, {
    type: "supervisor.process.failed",
    threadId: "thread-1",
    status: "failed",
    error: { code: "app_server_crash", message: "Codex app-server process failed." },
  });
  assert.doesNotMatch(JSON.stringify(processFailure), /sequence|turnId|params|raw process details/);

  const unscopedProcessFailure = normalizeEvent({
    type: "process_failure",
    affectedThreads: 2,
  });
  assert.deepEqual(unscopedProcessFailure, {
    type: "supervisor.process.notice",
    threadId: null,
    error: { code: "app_server_crash", message: "Codex app-server process failed." },
  });
  assert.equal("status" in unscopedProcessFailure, false);
});

test("changed files come only from the current turn structured record", () => {
  assert.deepEqual(
    extractTurnChanges({
      threadId: "thread-1",
      turnId: "turn-1",
      turn: {
        id: "turn-1",
        fileChanges: [
          { path: "a.mjs", kind: "modified" },
          { path: "b.mjs", kind: "added" },
        ],
      },
      diff: { files: ["dirty-repository-file.mjs"] },
      repositoryDiff: { files: ["another-dirty-file.mjs"] },
    }),
    {
      files: [
        { path: "a.mjs", kind: "modified" },
        { path: "b.mjs", kind: "added" },
      ],
      filesChanged: 2,
      filesTruncated: false,
    },
  );
  assert.deepEqual(
    extractTurnChanges({
      threadId: "thread-1",
      turnId: "turn-1",
      turn: { id: "other-turn", changes: { files: ["wrong-turn.mjs"] } },
      diff: { files: ["dirty-repository-file.mjs"] },
    }),
    { files: [], filesChanged: 0, filesTruncated: false },
  );
  assert.deepEqual(
    extractTurnChanges({
      threadId: "thread-1",
      turn: { id: "turn-1", changes: { files: ["missing-event-turn-id.mjs"] } },
    }),
    { files: ["missing-event-turn-id.mjs"], filesChanged: 1, filesTruncated: false },
  );
  assert.deepEqual(
    extractTurnChanges({
      threadId: "thread-1",
      turnId: "turn-1",
      turn: { id: "turn-1" },
      fileChanges: [{ path: "top-level.mjs", kind: "modified", turnId: "turn-1" }],
      params: {
        turnId: "turn-1",
        fileChanges: [{ path: "unscoped-params.mjs", kind: "modified" }],
      },
    }),
    { files: [], filesChanged: 0, filesTruncated: false },
  );
  assert.deepEqual(
    extractTurnChanges({
      threadId: "thread-1",
      turnId: "turn-1",
      turn: { id: "turn-1" },
      params: {
        turnId: "turn-1",
        fileChanges: {
          turnId: "turn-1",
          files: [{ path: "scoped-params.mjs", kind: "added" }],
        },
      },
    }),
    {
      files: [{ path: "scoped-params.mjs", kind: "added" }],
      filesChanged: 1,
      filesTruncated: false,
    },
  );
});

test("history adapter exposes turn-scoped history and never queries repository git state", async () => {
  const calls = [];
  const adapter = createHistoryAdapter({
    async readThreadMetadata(threadId) {
      calls.push(["readThreadMetadata", threadId]);
      return {
        id: threadId,
        cwd: "/workspace",
        turns: [{ id: "turn-secret" }],
        turnId: "turn-secret",
        eventCursor: 99,
        raw: { approval: "secret" },
      };
    },
    async readRecentTurns(threadId, options) {
      calls.push(["readRecentTurns", threadId, options]);
      return {
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", text: "ok" }],
            changes: { files: ["src/changed.mjs"] },
          },
        ],
      };
    },
  });

  assert.deepEqual(await adapter.readThreadMetadata("thread-1"), {
    id: "thread-1",
    cwd: "/workspace",
  });
  assert.deepEqual(await adapter.readRecentTurns("thread-1", { limit: 1 }), {
    turns: [
      {
        status: "completed",
        finalAssistantMessage: "ok",
        changes: { files: ["src/changed.mjs"], filesChanged: 1, filesTruncated: false },
      },
    ],
  });
  assert.deepEqual(await adapter.readTurnChanges("thread-1", "turn-1"), {
    files: ["src/changed.mjs"],
    filesChanged: 1,
    filesTruncated: false,
  });
  assert.deepEqual(calls, [
    ["readThreadMetadata", "thread-1"],
    ["readRecentTurns", "thread-1", { limit: 1 }],
    ["readRecentTurns", "thread-1", { turnId: "turn-1" }],
  ]);
  assert.equal(adapter.usesRepositoryGit, false);
});

test("publicProjection recursively removes internal protocol fields", () => {
  assert.deepEqual(publicProjection({
    threadId: "thread-1",
    turnId: "turn-1",
    nested: { eventCursor: 2, approval: { raw: "secret" }, visible: true },
    list: [{ sequence: 3, value: "ok" }],
  }), {
    threadId: "thread-1",
    nested: { visible: true },
    list: [{ value: "ok" }],
  });
});

test("supervisor adapter defines the complete fake contract and maps operations", async () => {
  const calls = [];
  const eventStore = {
    sequence: 3,
    events: [],
    record() {},
    recordProcessFailure() {},
  };
  const client = {
    loadedThreads: new Set(),
    eventStore,
    async request(method, params) {
      calls.push([method, params]);
      if (method === "thread/start") return { thread: { id: "thread-1", cwd: params.cwd } };
      if (method === "thread/resume") return { thread: { id: params.threadId, cwd: params.cwd } };
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress" } };
      if (method === "thread/list") return { data: [], nextCursor: null };
      if (method === "thread/read") return { thread: { id: params.threadId, cwd: "/workspace" } };
      if (method === "model/list") return { data: [{ id: "gpt-5.6-luna", supportedReasoningEfforts: ["xhigh"] }] };
      if (method === "config/read") return { config: { model: "gpt-5.6-luna" } };
      return {};
    },
    async notify(method, params) {
      calls.push([method, params]);
      return {};
    },
  };
  const adapter = createSupervisorAdapter({ client, eventStore });

  assert.deepEqual(Object.keys(adapter).sort(), [...SUPERVISOR_ADAPTER_METHODS].sort());
  assert.deepEqual(await adapter.startThread({ workspace: "/workspace" }), {
    thread: { id: "thread-1", cwd: "/workspace" },
  });
  assert.deepEqual(await adapter.resumeThread({ threadId: "thread-1", workspace: "/workspace" }), {
    thread: { id: "thread-1", cwd: "/workspace" },
  });
  assert.deepEqual(await adapter.startTurn({
    threadId: "thread-1",
    workspace: "/workspace",
    prompt: "work",
    model: "gpt-5.6-luna",
    effort: "xhigh",
  }), {
    threadId: "thread-1",
    turnId: "turn-1",
    turn: { id: "turn-1", status: "inProgress" },
  });
  await adapter.steerTurn({ threadId: "thread-1", prompt: "more" });
  await adapter.interruptTurn({ threadId: "thread-1" });
  assert.deepEqual(await adapter.listThreads({ workspace: "/workspace" }), { threads: [], nextCursor: null });
  assert.deepEqual(await adapter.readThreadMetadata("thread-1"), { id: "thread-1", cwd: "/workspace" });
  assert.deepEqual(await adapter.readRecentTurns("thread-1"), { turns: [] });
  await adapter.readRecentTurns("thread-1", { includeTurns: false, turnId: "turn-1" });
  assert.deepEqual(await adapter.listModels(), [{ id: "gpt-5.6-luna", supportedReasoningEfforts: ["xhigh"] }]);
  assert.deepEqual(await adapter.readEffectiveConfig(), { model: "gpt-5.6-luna" });
  const unsubscribe = adapter.subscribeRuntimeEvents(() => {});
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.ok(calls.some(([method]) => method === "turn/steer"));
  assert.ok(calls.some(([method]) => method === "turn/interrupt"));
  const metadataCall = calls.filter(([method]) => method === "thread/read")[0];
  assert.equal(metadataCall[1].includeTurns, false);
  const recentTurnsCall = calls.filter(([method]) => method === "thread/read").at(-1);
  assert.equal(recentTurnsCall[1].includeTurns, true);
  assert.equal("turnId" in recentTurnsCall[1], false);
});

test("supervisor adapter bridges events from an injected EventStore", () => {
  const eventStore = {
    record(method, params) {
      return {
        sequence: 9,
        turnId: params.turnId,
        method,
        params,
        threadId: params.threadId,
      };
    },
  };
  const adapter = createSupervisorAdapter({
    eventStore,
    client: {
      eventStore,
      async request() {
        return {};
      },
    },
  });
  const events = [];
  adapter.subscribeRuntimeEvents((event) => events.push(event));

  eventStore.record("turn/completed", { threadId: "thread-1", turnId: "turn-1" });
  assert.deepEqual(events, [
    {
      type: "turn.completed",
      threadId: "thread-1",
      status: "completed",
      changes: { files: [], filesChanged: 0, filesTruncated: false },
    },
  ]);
});

test("supervisor adapter emits one thread-scoped terminal event per active process failure", () => {
  const eventStore = new EventStore();
  const adapter = createSupervisorAdapter({
    eventStore,
    client: {
      eventStore,
      async request() {
        return {};
      },
    },
  });
  const events = [];
  adapter.subscribeRuntimeEvents((event) => events.push(event));

  eventStore.recordTurnStart("thread-1", { id: "turn-1" });
  eventStore.recordTurnStart("thread-2", { id: "turn-2" });
  eventStore.recordProcessFailure(new Error("raw process details"));

  assert.equal(events.length, 2);
  assert.deepEqual(events.map(({ threadId, type, status, error }) => ({ threadId, type, status, error })), [
    {
      threadId: "thread-1",
      type: "supervisor.process.failed",
      status: "failed",
      error: { code: "app_server_crash", message: "Codex app-server process failed." },
    },
    {
      threadId: "thread-2",
      type: "supervisor.process.failed",
      status: "failed",
      error: { code: "app_server_crash", message: "Codex app-server process failed." },
    },
  ]);
  assert.ok(events.every((event) => event.threadId));
});

test("fake adapter rejects invalid or unknown injected implementations", async () => {
  assert.throws(
    () => createFakeSupervisorAdapter({ startThread: "not-a-function" }),
    /must be a function/,
  );
  assert.throws(
    () => createFakeSupervisorAdapter({ unsupportedMethod() {} }),
    /Unknown supervisor adapter method/,
  );
});
