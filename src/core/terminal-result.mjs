import {
  InvalidTerminalResultError,
  InvalidTerminalStatusError,
} from '../shared/errors.mjs';
import {
  normalizeTerminalStatus,
  safeError,
  summarizeChangedFiles,
  truncateAssistantMessage,
} from '../shared/protocol.mjs';
import {
  extractAssistantMessage,
  extractTurnChanges,
} from '../adapters/supervisor/protocol-normalizer.mjs';

function firstString(...values) {
  return values.find((value) => typeof value === 'string') ?? '';
}

function turnRecord(input) {
  return input?.turn ?? input?.turnRecord ?? input?.currentTurn ?? null;
}

function terminalChanges(input) {
  const turn = turnRecord(input);
  const turnId = firstString(input?.turnId, input?.internalTurnId);
  const recordId = firstString(turn?.id, turn?.turnId);
  if (!turn || !turnId || !recordId || turnId !== recordId) {
    return summarizeChangedFiles([]);
  }

  const extracted = extractTurnChanges({ ...input, turn, turnId });
  const explicit = input?.turnChanges;
  if (
    explicit
    && typeof explicit === 'object'
    && explicit.turnId === turnId
    && Array.isArray(explicit.files)
  ) {
    return summarizeChangedFiles([...extracted.files, ...explicit.files]);
  }
  return extracted;
}

function canonicalChanges(value) {
  const files = Array.isArray(value?.files) ? value.files : [];
  const bounded = summarizeChangedFiles(files);
  const filesChanged = Number.isInteger(value?.filesChanged) && value.filesChanged >= bounded.files.length
    ? value.filesChanged
    : bounded.filesChanged;
  return {
    files: bounded.files,
    filesChanged,
    filesTruncated: Boolean(value?.filesTruncated) || filesChanged > bounded.files.length,
  };
}

export class TerminalResult {
  #data;

  constructor(data = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidTerminalResultError('Terminal result data must be an object.');
    }
    if (typeof data.threadId !== 'string' || data.threadId.length === 0) {
      throw new InvalidTerminalResultError();
    }
    const status = normalizeTerminalStatus(data.status);
    if (!status) {
      throw new InvalidTerminalStatusError();
    }
    const message = truncateAssistantMessage(firstString(
      status === 'completed' ? data.finalAssistantMessage : data.lastAssistantMessage,
    ));
    this.#data = Object.freeze({
      threadId: data.threadId,
      status,
      ...(status === 'completed'
        ? { finalAssistantMessage: message }
        : { lastAssistantMessage: message }),
      changes: canonicalChanges(data.changes),
      error: status === 'failed' ? safeError(data.error) : null,
    });
  }

  static fromTerminal(input = {}) {
    const status = normalizeTerminalStatus(input.status ?? input.reason ?? input.type);
    if (!status) {
      throw new InvalidTerminalStatusError();
    }

    if (typeof input.threadId !== 'string' || input.threadId.length === 0) {
      throw new InvalidTerminalResultError();
    }
    const turn = turnRecord(input);
    const turnMessage = extractAssistantMessage(turn);
    const message = firstString(
      status === 'completed' ? input.finalAssistantMessage : input.lastAssistantMessage,
      input.assistantMessage,
      turnMessage,
    );
    return new TerminalResult({
      threadId: input.threadId,
      status,
      ...(status === 'completed'
        ? { finalAssistantMessage: message }
        : { lastAssistantMessage: message }),
      changes: terminalChanges(input),
      error: status === 'failed' ? safeError(input.error ?? input.failure) : null,
    });
  }

  toJSON() {
    return {
      threadId: this.#data.threadId,
      status: this.#data.status,
      ...(this.#data.status === 'completed'
        ? { finalAssistantMessage: this.#data.finalAssistantMessage }
        : { lastAssistantMessage: this.#data.lastAssistantMessage }),
      changes: {
        files: this.#data.changes.files.map((file) => (
          typeof file === 'string' ? file : { ...file }
        )),
        filesChanged: this.#data.changes.filesChanged,
        filesTruncated: this.#data.changes.filesTruncated,
      },
      error: this.#data.error === null ? null : { ...this.#data.error },
    };
  }
}
