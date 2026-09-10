import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupervisorAdapter,
  createFakeSupervisorAdapter,
  SUPERVISOR_ADAPTER_METHODS,
} from "../../src/adapters/supervisor/app-server-adapter.mjs";
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
  assert.doesNotMatch(JSON.stringify(event), /turnId|eventCursor|cursor|repositoryDiff/);
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
    { files: [], filesChanged: 0, filesTruncated: false },
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

  eventStore.record("turn/completed", { threadId: "thread-1" });
  assert.deepEqual(events, [
    {
      type: "turn.completed",
      threadId: "thread-1",
      status: "completed",
      changes: { files: [], filesChanged: 0, filesTruncated: false },
    },
  ]);
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
