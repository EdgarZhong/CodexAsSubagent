import { extractTurnChanges, normalizeTurn } from './protocol-normalizer.mjs';

function normalizeHistoryResult(value) {
  if (Array.isArray(value)) {
    return { turns: value.map(normalizeTurn).filter(Boolean) };
  }
  const turns = Array.isArray(value?.turns)
    ? value.turns.map(normalizeTurn).filter(Boolean)
    : [];
  const result = { turns };
  if (value?.nextCursor !== undefined) {
    result.nextCursor = value.nextCursor;
  }
  return result;
}

export function createHistoryAdapter(adapter) {
  if (!adapter || typeof adapter.readThreadMetadata !== 'function' || typeof adapter.readRecentTurns !== 'function') {
    throw new TypeError('History adapter requires readThreadMetadata and readRecentTurns.');
  }

  const readRecentTurns = async (threadId, options = {}) => {
    const result = await adapter.readRecentTurns(threadId, options);
    return normalizeHistoryResult(result);
  };

  const readTurnChanges = async (threadId, turnId) => {
    const history = await readRecentTurns(threadId, { turnId });
    const turn = history.turns.find((entry) => entry?.id === turnId);
    if (!turn) {
      return { files: [] };
    }
    return extractTurnChanges({ threadId, turnId, turn });
  };

  return {
    readThreadMetadata: (...args) => adapter.readThreadMetadata(...args),
    readRecentTurns,
    readTurnChanges,
    getChangedFiles: readTurnChanges,
    usesRepositoryGit: false,
  };
}
