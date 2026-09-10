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
    changes: {
      files: Array.from({ length: 25 }, (_, index) => ({
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
  assert.equal(json.completionId, "completion-1");
  assert.equal(json.assistantMessage.length, 16_000);
  assert.equal(json.changes.files.length, 20);
  assert.doesNotMatch(JSON.stringify(json), /turnId|eventCursor|cursor/);
  assert.equal(json.error, null);
});

test("TerminalResult failed and interrupted payloads preserve safe terminal details", () => {
  const failed = TerminalResult.fromTerminal(terminalInput("failed"));
  assert.deepEqual(failed.toJSON(), {
    completionId: "completion-1",
    threadId: "thread-1",
    workspace: "/workspace",
    status: "failed",
    assistantMessage: "a".repeat(16_000),
    changes: {
      files: Array.from({ length: 20 }, (_, index) => ({
        path: `src/file-${index}.mjs`,
        kind: "modified",
      })),
    },
    error: { code: "upstream_error", message: "failure" },
  });

  const interrupted = TerminalResult.fromTerminal(
    terminalInput("interrupted", { assistantMessage: "stopped", changes: { files: [] }, error: null }),
  );
  assert.equal(interrupted.toJSON().status, "interrupted");
  assert.equal(interrupted.toJSON().assistantMessage, "stopped");
  assert.deepEqual(interrupted.toJSON().changes, { files: [] });
  assert.equal(interrupted.toJSON().error, null);
});

test("TerminalResult rejects non-terminal status", () => {
  assert.throws(
    () => TerminalResult.fromTerminal(terminalInput("running")),
    (error) => error.code === "invalid_terminal_status",
  );
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
});
