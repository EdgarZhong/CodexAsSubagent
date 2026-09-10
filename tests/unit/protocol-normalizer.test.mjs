import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupervisorAdapter,
  SUPERVISOR_ADAPTER_METHODS,
} from "../../src/adapters/supervisor/app-server-adapter.mjs";
import { createHistoryAdapter } from "../../src/adapters/supervisor/history-adapter.mjs";
import {
  normalizeEvent,
  extractTurnChanges,
} from "../../src/adapters/supervisor/protocol-normalizer.mjs";

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
    changes: { files: ["src/one.mjs"] },
  });
  assert.doesNotMatch(JSON.stringify(event), /turnId|eventCursor|cursor|repositoryDiff/);
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
    },
  );
  assert.deepEqual(
    extractTurnChanges({
      threadId: "thread-1",
      turnId: "turn-1",
      turn: { id: "other-turn", changes: { files: ["wrong-turn.mjs"] } },
      diff: { files: ["dirty-repository-file.mjs"] },
    }),
    { files: [] },
  );
});

test("history adapter exposes turn-scoped history and never queries repository git state", async () => {
  const calls = [];
  const adapter = createHistoryAdapter({
    async readThreadMetadata(threadId) {
      calls.push(["readThreadMetadata", threadId]);
      return { id: threadId, cwd: "/workspace" };
    },
    async readRecentTurns(threadId, options) {
      calls.push(["readRecentTurns", threadId, options]);
      return {
        turns: [
          {
            id: "turn-1",
            status: "completed",
            assistantMessage: "ok",
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
        id: "turn-1",
        status: "completed",
        assistantMessage: "ok",
        changes: { files: ["src/changed.mjs"] },
      },
    ],
  });
  assert.deepEqual(await adapter.readTurnChanges("thread-1", "turn-1"), {
    files: ["src/changed.mjs"],
  });
  assert.deepEqual(calls, [
    ["readThreadMetadata", "thread-1"],
    ["readRecentTurns", "thread-1", { limit: 1 }],
    ["readRecentTurns", "thread-1", { turnId: "turn-1" }],
  ]);
  assert.equal(adapter.usesRepositoryGit, false);
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
  assert.deepEqual(await adapter.listModels(), [{ id: "gpt-5.6-luna", supportedReasoningEfforts: ["xhigh"] }]);
  assert.deepEqual(await adapter.readEffectiveConfig(), { model: "gpt-5.6-luna" });
  const unsubscribe = adapter.subscribeRuntimeEvents(() => {});
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.ok(calls.some(([method]) => method === "turn/steer"));
  assert.ok(calls.some(([method]) => method === "turn/interrupt"));
});

test("supervisor adapter bridges events from an injected EventStore", () => {
  const eventStore = {
    record(method, params) {
      return { method, params, threadId: params.threadId };
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
    { method: "turn/completed", params: { threadId: "thread-1" }, threadId: "thread-1" },
  ]);
});
