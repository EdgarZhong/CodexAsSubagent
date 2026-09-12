const INTERNAL_KEYS = new Set([
  'approval', 'cwd', 'cursor', 'claimId', 'eventCursor', 'internalTurnId',
  'params', 'raw', 'sandbox', 'turnId', 'workspace', 'request', 'requestId',
  'reservation', 'reservationId', 'reservationKind', 'reservationCreatedAt',
  'receivedAt', 'sequence', 'requestKey', 'config', 'effectiveConfig',
  'approvalPolicy', 'sandboxPolicy',
]);

function project(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((entry) => project(entry, seen));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.toJSON === 'function') return project(value.toJSON(), seen);
  if (seen.has(value)) return undefined;
  seen.add(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (INTERNAL_KEYS.has(key)) continue;
    result[key] = project(entry, seen);
  }
  seen.delete(value);
  return result;
}

export function projectSpawnAck(value) { return project(value); }
export function projectStatus(value) { return project(value); }
export function projectTerminalResult(value) { return project(value); }
export function projectWaitMany(value) { return project(value); }
export function projectListThreads(value) { return project(value); }
export function projectReadThread(value) { return project(value); }
export function projectModels(value) { return project(value); }
export function projectInterrupt(value) { return project(value); }
export function projectPublic(value) { return project(value); }
