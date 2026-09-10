import assert from "node:assert/strict";
import test from "node:test";

import { ModelService } from "../../src/core/model-service.mjs";
import { TerminalResult } from "../../src/core/terminal-result.mjs";

function terminalInput(status, overrides = {}) {
  return {
    completionId: "completion-1",
    threadId: "thread-1",
    turnId: "turn-1",
    eventCursor: 42,
    workspace: "/workspace",
    status,
    assistantMessage: "a".repeat(16_500),
    changes: { files: ["untrusted-top-level.mjs"] },
    turn: {
      id: "turn-1",
      fileChanges: Array.from({ length: 25 }, (_, index) => ({
        path: `src/file-${index}.mjs`,
        kind: "modified",
      })),
    },
    error: { code: "upstream_error", message: "failure" },
    ...overrides,
  };
}

test("TerminalResult completed payload is bounded and strips internal fields", () => {
  const result = TerminalResult.fromTerminal(terminalInput("completed"));
  const json = result.toJSON();

  assert.equal(json.status, "completed");
  assert.equal(json.threadId, "thread-1");
  assert.equal(json.finalAssistantMessage.length, 16_000);
  assert.equal(json.changes.files.length, 20);
  assert.equal(json.changes.filesChanged, 25);
  assert.equal(json.changes.filesTruncated, true);
  assert.doesNotMatch(JSON.stringify(json), /turnId|eventCursor|cursor/);
  assert.doesNotMatch(JSON.stringify(json), /workspace|completionId/);
  assert.equal("lastAssistantMessage" in json, false);
  assert.equal(json.error, null);
});

test("TerminalResult failed and interrupted payloads preserve safe terminal details", () => {
  const failed = TerminalResult.fromTerminal(terminalInput("failed"));
  assert.deepEqual(failed.toJSON(), {
    threadId: "thread-1",
    status: "failed",
    lastAssistantMessage: "a".repeat(16_000),
    changes: {
      files: Array.from({ length: 20 }, (_, index) => ({
        path: `src/file-${index}.mjs`,
        kind: "modified",
      })),
      filesChanged: 25,
      filesTruncated: true,
    },
    error: { code: "upstream_error", message: "failure" },
  });

  const interrupted = TerminalResult.fromTerminal(
    terminalInput("interrupted", {
      assistantMessage: "stopped",
      changes: { files: [] },
      turn: { id: "turn-1", fileChanges: [] },
      error: null,
    }),
  );
  assert.equal(interrupted.toJSON().status, "interrupted");
  assert.equal(interrupted.toJSON().lastAssistantMessage, "stopped");
  assert.deepEqual(interrupted.toJSON().changes, {
    files: [],
    filesChanged: 0,
    filesTruncated: false,
  });
  assert.equal(interrupted.toJSON().error, null);
  assert.equal("finalAssistantMessage" in interrupted.toJSON(), false);
});

test("TerminalResult rejects non-terminal status", () => {
  assert.throws(
    () => TerminalResult.fromTerminal(terminalInput("running")),
    (error) => error.code === "invalid_terminal_status",
  );
});

test("TerminalResult requires verified turn provenance and a non-empty thread id", () => {
  const untrusted = TerminalResult.fromTerminal({
    threadId: "thread-1",
    status: "completed",
    finalAssistantMessage: "safe",
    changes: { files: ["untrusted.mjs"] },
  });
  assert.deepEqual(untrusted.toJSON().changes, {
    files: [],
    filesChanged: 0,
    filesTruncated: false,
  });

  const mismatched = TerminalResult.fromTerminal({
    threadId: "thread-1",
    turnId: "turn-1",
    turn: { id: "turn-2", fileChanges: ["wrong-turn.mjs"] },
    status: "completed",
  });
  assert.deepEqual(mismatched.toJSON().changes, {
    files: [],
    filesChanged: 0,
    filesTruncated: false,
  });

  assert.throws(
    () => TerminalResult.fromTerminal({ status: "completed" }),
    (error) => error.code === "invalid_terminal_result",
  );
  const direct = new TerminalResult({
    threadId: "thread-1",
    status: "completed",
    finalAssistantMessage: "ok",
    workspace: "/secret",
    completionId: "secret",
    turnId: "secret",
  });
  assert.deepEqual(direct.toJSON(), {
    threadId: "thread-1",
    status: "completed",
    finalAssistantMessage: "ok",
    changes: { files: [], filesChanged: 0, filesTruncated: false },
    error: null,
  });
});

test("ModelService resolves default and explicit model/effort pairs", async () => {
  const service = new ModelService({
    models: [
      { id: "gpt-5.6-luna", supportedReasoningEfforts: ["medium", "xhigh"] },
      { id: "small-model", supportedReasoningEfforts: ["low"] },
    ],
  });

  assert.deepEqual(await service.resolveSpawn(), {
    model: "gpt-5.6-luna",
    effort: "xhigh",
  });
  assert.deepEqual(await service.resolveSpawn("small-model"), {
    model: "small-model",
    effort: "low",
  });
  assert.deepEqual(await service.resolveSpawn("small-model", "low"), {
    model: "small-model",
    effort: "low",
  });
  await assert.rejects(
    () => service.resolveSpawn("missing-model"),
    (error) => error.code === "invalid_model",
  );
  await assert.rejects(
    () => service.resolveSpawn("small-model", "xhigh"),
    (error) => error.code === "invalid_effort",
  );
  await assert.rejects(
    () => new ModelService({ models: [{ id: "small-model", efforts: ["low"] }] }).resolveSpawn(),
    (error) => error.code === "default_model_unavailable",
  );
  await assert.rejects(
    () => new ModelService({ models: [] }).resolveSpawn("made-up-model", "made-up-effort"),
    (error) => error.code === "invalid_model",
  );

  const configured = new ModelService({
    models: [{ id: "configured-model", supportedReasoningEfforts: ["low"] }],
    effectiveConfig: {
      model: "configured-model",
      model_reasoning_effort: "low",
    },
  });
  assert.deepEqual(await configured.resolveSpawn(), {
    model: "configured-model",
    effort: "low",
  });
});
