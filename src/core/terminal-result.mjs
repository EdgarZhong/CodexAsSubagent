import { randomUUID } from 'node:crypto';

import { MAX_CHANGED_FILES } from '../shared/constants.mjs';
import { InvalidTerminalStatusError } from '../shared/errors.mjs';
import {
  capChangedFiles,
  normalizeTerminalStatus,
  safeError,
  truncateAssistantMessage,
} from '../shared/protocol.mjs';

function firstString(...values) {
  return values.find((value) => typeof value === 'string') ?? '';
}

function terminalChanges(input) {
  if (Array.isArray(input?.changes?.files)) return capChangedFiles(input.changes.files);
  if (Array.isArray(input?.fileChanges)) return capChangedFiles(input.fileChanges);
  if (Array.isArray(input?.turn?.fileChanges)) return capChangedFiles(input.turn.fileChanges);
  if (Array.isArray(input?.turn?.changes?.files)) return capChangedFiles(input.turn.changes.files);
  return [];
}

function optionalString(result, key, ...values) {
  const value = firstString(...values);
  if (value) result[key] = value;
}

export class TerminalResult {
  constructor(data) {
    this.data = Object.freeze({ ...data });
  }

  static fromTerminal(input = {}) {
    const status = normalizeTerminalStatus(input.status ?? input.reason ?? input.type);
    if (!status) {
      throw new InvalidTerminalStatusError();
    }

    const result = {
      completionId: typeof input.completionId === 'string' && input.completionId.length > 0
        ? input.completionId
        : randomUUID(),
      threadId: typeof input.threadId === 'string' ? input.threadId : '',
      status,
      assistantMessage: truncateAssistantMessage(firstString(
        input.assistantMessage,
        input.message,
        input.latestAgentMessage,
        input.text,
      )),
      changes: { files: terminalChanges(input).slice(0, MAX_CHANGED_FILES) },
      error: status === 'failed' ? safeError(input.error ?? input.failure) : null,
    };
    optionalString(result, 'workspace', input.workspace, input.cwd);
    optionalString(result, 'summary', input.summary);
    optionalString(result, 'startedAt', input.startedAt);
    optionalString(result, 'completedAt', input.completedAt);
    if (Number.isFinite(input.durationSec)) {
      result.durationSec = input.durationSec;
    }
    return new TerminalResult(result);
  }

  toJSON() {
    return {
      ...this.data,
      changes: { files: [...this.data.changes.files] },
      error: this.data.error === null ? null : { ...this.data.error },
    };
  }
}
