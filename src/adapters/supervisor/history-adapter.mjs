import { extractTurnChanges, normalizeTurn } from './protocol-normalizer.mjs';

function sourceValue(value) {
  return value?.thread ?? value;
}

function stableMetadata(value) {
  const source = sourceValue(value);
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }
  const result = {};
  const id = typeof source.id === 'string' ? source.id : source.threadId;
  if (typeof id === 'string' && id.length > 0) result.id = id;
  if (typeof source.cwd === 'string') result.cwd = source.cwd;
  if (typeof source.workingDirectory === 'string') result.workingDirectory = source.workingDirectory;
  if (typeof source.title === 'string') result.title = source.title;
  if (typeof source.status === 'string') result.status = source.status;
  else if (typeof source.status?.type === 'string') result.status = source.status.type;
  if (typeof source.createdAt === 'string') result.createdAt = source.createdAt;
  if (typeof source.updatedAt === 'string') result.updatedAt = source.updatedAt;
  return result;
}

function rawTurns(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.turns)) return value.turns;
  return [];
}

function normalizeHistoryResult(value) {
  return { turns: rawTurns(value).map(normalizeTurn).filter(Boolean) };
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
    if (typeof turnId !== 'string' || turnId.length === 0) {
      return { files: [], filesChanged: 0, filesTruncated: false };
    }
    const rawHistory = await adapter.readRecentTurns(threadId, { turnId });
    const turn = rawTurns(rawHistory).find((entry) => entry?.id === turnId || entry?.turnId === turnId);
    if (!turn) {
      return { files: [], filesChanged: 0, filesTruncated: false };
    }
    return extractTurnChanges({ threadId, turnId, turn });
  };

  return {
    async readThreadMetadata(...args) {
      return stableMetadata(await adapter.readThreadMetadata(...args));
    },
    readRecentTurns,
    readTurnChanges,
    getChangedFiles: readTurnChanges,
    usesRepositoryGit: false,
  };
}
