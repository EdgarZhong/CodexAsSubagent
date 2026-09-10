import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeTerminalStatus, safeError, summarizeChangedFiles, truncateAssistantMessage } from '../../shared/protocol.mjs';

export const DELIVERY_STATES = Object.freeze([
  'pending',
  'claimed_direct',
  'claimed_hook',
  'delivered',
]);

export const DEFAULT_DELIVERY_LEASE_MS = 30_000;
export const DEFAULT_DATA_DIR = join(homedir(), '.codex-as-subagent');

const DELIVERY_STATE_SQL = "'pending', 'claimed_direct', 'claimed_hook', 'delivered'";
const TERMINAL_STATUS_SQL = "'completed', 'failed', 'interrupted'";

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function asTimestamp(value, fallback = Date.now()) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Timestamp must be valid.');
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Timestamp must be valid.');
    return date.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Timestamp must be valid.');
    return date.toISOString();
  }
  const date = new Date(fallback);
  if (Number.isNaN(date.getTime())) throw new TypeError('Timestamp must be valid.');
  return date.toISOString();
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('limit must be a positive integer.');
  }
  return value;
}

function changedFiles(value) {
  return summarizeChangedFiles(value?.files);
}

function canonicalPayload(value, fallbackThreadId) {
  const source = typeof value?.toJSON === 'function' ? value.toJSON() : value;
  if (!isRecord(source)) {
    throw new TypeError('Terminal result payload must be an object.');
  }

  const threadId = requiredString(source.threadId ?? fallbackThreadId, 'threadId');
  const status = normalizeTerminalStatus(source.status);
  if (!status) throw new TypeError('Terminal result status must be terminal.');

  const payload = {
    threadId,
    status,
  };
  if (Number.isSafeInteger(source.durationSec) && source.durationSec >= 0) {
    payload.durationSec = source.durationSec;
  }
  const messageKey = status === 'completed' ? 'finalAssistantMessage' : 'lastAssistantMessage';
  payload[messageKey] = truncateAssistantMessage(source[messageKey]);
  const changes = changedFiles(source.changes);
  const filesChanged = Number.isSafeInteger(source.changes?.filesChanged)
    && source.changes.filesChanged >= changes.files.length
    ? source.changes.filesChanged
    : changes.filesChanged;
  payload.changes = {
    files: changes.files,
    filesChanged,
    filesTruncated: Boolean(source.changes?.filesTruncated) || filesChanged > changes.files.length,
  };
  payload.error = status === 'failed' ? safeError(source.error) : null;
  return payload;
}

function executionFromRow(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    turnId: row.turn_id,
    workspace: row.workspace,
    ownerInstanceId: row.owner_instance_id,
    model: row.model,
    effort: row.effort,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    reservationId: row.reservation_id,
    reservationKind: row.reservation_kind,
    reservationCreatedAt: row.reservation_created_at,
  };
}

function completionFromRow(row) {
  if (!row) return null;
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    completionId: row.completion_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    workspace: row.workspace,
    terminalStatus: row.terminal_status,
    payload,
    deliveryState: row.delivery_state,
    deliveryId: row.delivery_id,
    deliveryStartedAt: row.delivery_started_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}

function changesCount(result) {
  return Number(result?.changes ?? 0);
}

function optionsFrom(first, second = {}) {
  if (typeof first === 'string') {
    return { ...second, threadId: first };
  }
  if (!isRecord(first)) return { ...second };
  return { ...first, ...second };
}

export class SqliteStore {
  static open(dataDir = DEFAULT_DATA_DIR) {
    const directory = isRecord(dataDir) ? dataDir.dataDir ?? DEFAULT_DATA_DIR : dataDir;
    requiredString(directory, 'dataDir');
    const canonicalDir = resolve(directory);
    mkdirSync(canonicalDir, { recursive: true });
    const databasePath = join(canonicalDir, 'state.sqlite');
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = FULL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS executions (
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          owner_instance_id TEXT NOT NULL,
          model TEXT,
          effort TEXT,
          started_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          reservation_id TEXT,
          reservation_kind TEXT,
          reservation_created_at TEXT,
          PRIMARY KEY (thread_id, turn_id),
          CHECK (reservation_kind IS NULL OR reservation_kind = 'direct')
        );

        CREATE TABLE IF NOT EXISTS completions (
          completion_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          workspace TEXT NOT NULL,
          terminal_status TEXT NOT NULL CHECK (terminal_status IN (${TERMINAL_STATUS_SQL})),
          payload_json TEXT NOT NULL,
          delivery_state TEXT NOT NULL CHECK (delivery_state IN (${DELIVERY_STATE_SQL})),
          delivery_id TEXT,
          delivery_started_at TEXT,
          delivered_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (thread_id, turn_id)
        );

        CREATE INDEX IF NOT EXISTS completions_pending_workspace_idx
          ON completions(workspace, delivery_state, created_at);

        INSERT INTO meta(key, value)
          VALUES ('schema_version', '1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    return new SqliteStore(db, databasePath);
  }

  constructor(db, databasePath) {
    this.db = db;
    this.path = databasePath;
    this.closed = false;
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  #transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = callback();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  #findExecution(threadId, turnId) {
    const statement = turnId === undefined
      ? this.db.prepare('SELECT * FROM executions WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1')
      : this.db.prepare('SELECT * FROM executions WHERE thread_id = ? AND turn_id = ?');
    const row = turnId === undefined ? statement.get(threadId) : statement.get(threadId, turnId);
    return executionFromRow(row);
  }

  #findCompletion(completionId) {
    return completionFromRow(this.db.prepare('SELECT * FROM completions WHERE completion_id = ?').get(completionId));
  }

  createExecution(input = {}) {
    const options = optionsFrom(input);
    const threadId = requiredString(options.threadId, 'threadId');
    const turnId = requiredString(options.turnId, 'turnId');
    const workspace = requiredString(options.workspace, 'workspace');
    const ownerInstanceId = requiredString(options.ownerInstanceId ?? randomUUID(), 'ownerInstanceId');
    const now = options.now;
    const startedAt = asTimestamp(options.startedAt ?? now);
    const lastActivityAt = asTimestamp(options.lastActivityAt ?? now ?? startedAt);

    return this.#transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO executions(
          thread_id, turn_id, workspace, owner_instance_id, model, effort,
          started_at, last_activity_at, reservation_id, reservation_kind,
          reservation_created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(thread_id, turn_id) DO NOTHING
      `).run(
        threadId,
        turnId,
        workspace,
        ownerInstanceId,
        options.model ?? null,
        options.effort ?? null,
        startedAt,
        lastActivityAt,
      );
      const execution = this.#findExecution(threadId, turnId);
      return {
        created: changesCount(result) === 1,
        ...execution,
        execution,
      };
    });
  }

  getExecution(threadOrOptions, turnId) {
    const options = typeof threadOrOptions === 'string'
      ? { threadId: threadOrOptions, turnId }
      : optionsFrom(threadOrOptions);
    const threadId = requiredString(options.threadId, 'threadId');
    return this.#findExecution(threadId, options.turnId);
  }

  listExecutions(options = {}) {
    const workspace = options.workspace;
    const rows = workspace === undefined
      ? this.db.prepare('SELECT * FROM executions ORDER BY last_activity_at DESC').all()
      : this.db.prepare('SELECT * FROM executions WHERE workspace = ? ORDER BY last_activity_at DESC').all(
        requiredString(workspace, 'workspace'),
      );
    return rows.map(executionFromRow);
  }

  reserveDirect(first, reservationId, now) {
    const options = typeof first === 'string'
      ? { threadId: first, reservationId, now }
      : optionsFrom(first);
    const threadId = requiredString(options.threadId, 'threadId');
    const requestedReservationId = requiredString(options.reservationId ?? options.deliveryId ?? randomUUID(), 'reservationId');
    const timestamp = asTimestamp(options.now);
    const workspace = options.workspace;

    return this.#transaction(() => {
      const executionStatement = workspace === undefined
        ? this.db.prepare('SELECT * FROM executions WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1')
        : this.db.prepare('SELECT * FROM executions WHERE thread_id = ? AND workspace = ? ORDER BY started_at DESC LIMIT 1');
      const executionRow = workspace === undefined
        ? executionStatement.get(threadId)
        : executionStatement.get(threadId, requiredString(workspace, 'workspace'));
      const execution = executionFromRow(executionRow);

      if (execution) {
        if (execution.reservationId === requestedReservationId && execution.reservationKind === 'direct') {
          return {
            reserved: true,
            source: 'execution',
            reservationId: requestedReservationId,
            reservationKind: 'direct',
            threadId: execution.threadId,
            turnId: execution.turnId,
            workspace: execution.workspace,
          };
        }
        if (execution.reservationId !== null) {
          return { reserved: false, reason: 'already_reserved', threadId, turnId: execution.turnId };
        }
        const update = this.db.prepare(`
          UPDATE executions
          SET reservation_id = ?, reservation_kind = 'direct', reservation_created_at = ?
          WHERE thread_id = ? AND turn_id = ? AND reservation_id IS NULL
        `).run(requestedReservationId, timestamp, execution.threadId, execution.turnId);
        if (changesCount(update) !== 1) {
          return { reserved: false, reason: 'already_reserved', threadId, turnId: execution.turnId };
        }
        return {
          reserved: true,
          source: 'execution',
          reservationId: requestedReservationId,
          reservationKind: 'direct',
          threadId: execution.threadId,
          turnId: execution.turnId,
          workspace: execution.workspace,
        };
      }

      const completionStatement = workspace === undefined
        ? this.db.prepare(`
          SELECT * FROM completions
          WHERE thread_id = ? AND delivery_state = 'pending'
          ORDER BY created_at ASC LIMIT 1
        `)
        : this.db.prepare(`
          SELECT * FROM completions
          WHERE thread_id = ? AND workspace = ? AND delivery_state = 'pending'
          ORDER BY created_at ASC LIMIT 1
        `);
      const pendingRow = workspace === undefined
        ? completionStatement.get(threadId)
        : completionStatement.get(threadId, requiredString(workspace, 'workspace'));
      if (!pendingRow) {
        return { reserved: false, reason: 'not_found', threadId };
      }
      const claimed = this.db.prepare(`
        UPDATE completions
        SET delivery_state = 'claimed_direct', delivery_id = ?, delivery_started_at = ?, delivered_at = NULL
        WHERE completion_id = ? AND delivery_state = 'pending'
      `).run(requestedReservationId, timestamp, pendingRow.completion_id);
      if (changesCount(claimed) !== 1) {
        return { reserved: false, reason: 'already_claimed', threadId };
      }
      const completion = this.#findCompletion(pendingRow.completion_id);
      return {
        reserved: true,
        source: 'completion',
        reservationId: requestedReservationId,
        reservationKind: 'direct',
        threadId: completion.threadId,
        turnId: completion.turnId,
        workspace: completion.workspace,
        completion,
      };
    });
  }

  releaseReservation(first, reservationId) {
    const options = typeof first === 'string'
      ? { threadId: first, reservationId }
      : optionsFrom(first);
    const threadId = options.threadId === undefined ? undefined : requiredString(options.threadId, 'threadId');
    const requestedReservationId = options.reservationId ?? options.deliveryId;

    return this.#transaction(() => {
      let completionChanges = 0;
      if (requestedReservationId !== undefined) {
        requiredString(requestedReservationId, 'reservationId');
        const completionResult = threadId === undefined
          ? this.db.prepare(`
            UPDATE completions
            SET delivery_state = 'pending', delivery_id = NULL, delivery_started_at = NULL, delivered_at = NULL
            WHERE delivery_id = ? AND delivery_state = 'claimed_direct'
          `).run(requestedReservationId)
          : this.db.prepare(`
            UPDATE completions
            SET delivery_state = 'pending', delivery_id = NULL, delivery_started_at = NULL, delivered_at = NULL
            WHERE delivery_id = ? AND thread_id = ? AND delivery_state = 'claimed_direct'
          `).run(requestedReservationId, threadId);
        completionChanges = changesCount(completionResult);
      }

      let executionChanges = 0;
      if (threadId !== undefined || requestedReservationId !== undefined) {
        let executionResult;
        if (threadId !== undefined && requestedReservationId !== undefined) {
          executionResult = this.db.prepare(`
            UPDATE executions
            SET reservation_id = NULL, reservation_kind = NULL, reservation_created_at = NULL
            WHERE thread_id = ? AND reservation_id = ? AND reservation_kind = 'direct'
          `).run(threadId, requestedReservationId);
        } else if (threadId !== undefined) {
          executionResult = this.db.prepare(`
            UPDATE executions
            SET reservation_id = NULL, reservation_kind = NULL, reservation_created_at = NULL
            WHERE thread_id = ? AND reservation_kind = 'direct'
          `).run(threadId);
        } else {
          executionResult = this.db.prepare(`
            UPDATE executions
            SET reservation_id = NULL, reservation_kind = NULL, reservation_created_at = NULL
            WHERE reservation_id = ? AND reservation_kind = 'direct'
          `).run(requestedReservationId);
        }
        executionChanges = changesCount(executionResult);
      }
      return {
        released: completionChanges + executionChanges > 0,
        completionCount: completionChanges,
        executionCount: executionChanges,
        reservationId: requestedReservationId ?? null,
        threadId: threadId ?? null,
      };
    });
  }

  insertCompletionFirst(first, second = {}) {
    const options = optionsFrom(first, second);
    const inputPayload = options.terminalResult ?? options.result ?? options.payload ?? options;
    const threadId = requiredString(options.threadId ?? inputPayload?.threadId, 'threadId');
    const turnId = requiredString(options.turnId ?? options.internalTurnId ?? inputPayload?.turnId, 'turnId');
    const payload = canonicalPayload(inputPayload, threadId);
    const completionId = requiredString(options.completionId ?? options.id ?? randomUUID(), 'completionId');
    const requestedWorkspace = options.workspace ?? payload.workspace;
    const createdAt = asTimestamp(options.createdAt ?? options.now);

    return this.#transaction(() => {
      const executionRow = this.db.prepare(
        'SELECT * FROM executions WHERE thread_id = ? AND turn_id = ?',
      ).get(threadId, turnId);
      const execution = executionFromRow(executionRow);
      const existing = this.db.prepare(
        'SELECT * FROM completions WHERE thread_id = ? AND turn_id = ?',
      ).get(threadId, turnId);
      if (existing) {
        if (requestedWorkspace !== undefined && requestedWorkspace !== existing.workspace) {
          throw new Error('Terminal completion workspace does not match its completion.');
        }
        this.db.prepare('DELETE FROM executions WHERE thread_id = ? AND turn_id = ?').run(threadId, turnId);
        return {
          inserted: false,
          ...completionFromRow(existing),
        };
      }
      const workspace = requiredString(execution?.workspace ?? requestedWorkspace, 'workspace');
      if (execution && requestedWorkspace !== undefined && requestedWorkspace !== execution.workspace) {
        throw new Error('Terminal completion workspace does not match its execution.');
      }

      const directReservation = execution?.reservationKind === 'direct' && execution.reservationId
        ? execution.reservationId
        : null;
      const deliveryState = directReservation ? 'claimed_direct' : 'pending';
      const insertResult = this.db.prepare(`
        INSERT INTO completions(
          completion_id, thread_id, turn_id, workspace, terminal_status,
          payload_json, delivery_state, delivery_id, delivery_started_at,
          delivered_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(thread_id, turn_id) DO NOTHING
      `).run(
        completionId,
        threadId,
        turnId,
        workspace,
        payload.status,
        JSON.stringify(payload),
        deliveryState,
        directReservation,
        directReservation ? asTimestamp(options.deliveryStartedAt ?? options.now) : null,
        createdAt,
      );

      this.db.prepare('DELETE FROM executions WHERE thread_id = ? AND turn_id = ?').run(threadId, turnId);
      const row = this.db.prepare(
        'SELECT * FROM completions WHERE thread_id = ? AND turn_id = ?',
      ).get(threadId, turnId);
      return {
        inserted: changesCount(insertResult) === 1,
        ...completionFromRow(row),
      };
    });
  }

  getCompletion(completionOrOptions) {
    const options = typeof completionOrOptions === 'string'
      ? { completionId: completionOrOptions }
      : optionsFrom(completionOrOptions);
    if (options.completionId !== undefined) {
      return this.#findCompletion(requiredString(options.completionId, 'completionId'));
    }
    const threadId = requiredString(options.threadId, 'threadId');
    const turnId = requiredString(options.turnId, 'turnId');
    return completionFromRow(this.db.prepare(
      'SELECT * FROM completions WHERE thread_id = ? AND turn_id = ?',
    ).get(threadId, turnId));
  }

  listCompletions(options = {}) {
    const workspace = options.workspace;
    const state = options.deliveryState ?? options.delivery_state;
    const clauses = [];
    const values = [];
    if (workspace !== undefined) {
      clauses.push('workspace = ?');
      values.push(requiredString(workspace, 'workspace'));
    }
    if (state !== undefined) {
      if (!DELIVERY_STATES.includes(state)) throw new TypeError('Unknown delivery state.');
      clauses.push('delivery_state = ?');
      values.push(state);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM completions${where} ORDER BY created_at ASC`).all(...values);
    return rows.map(completionFromRow);
  }

  claimPendingHook(first, second = {}) {
    const options = typeof first === 'string'
      ? { ...second, workspace: first }
      : optionsFrom(first, second);
    const workspace = requiredString(options.workspace, 'workspace');
    const deliveryId = requiredString(options.deliveryId ?? randomUUID(), 'deliveryId');
    const timestamp = asTimestamp(options.now);
    const limit = positiveInteger(options.limit, 100);

    return this.#transaction(() => {
      const rows = this.db.prepare(`
        SELECT completion_id FROM completions
        WHERE workspace = ? AND delivery_state = 'pending'
        ORDER BY created_at ASC
        LIMIT ?
      `).all(workspace, limit);
      const claimedIds = [];
      const update = this.db.prepare(`
        UPDATE completions
        SET delivery_state = 'claimed_hook', delivery_id = ?, delivery_started_at = ?, delivered_at = NULL
        WHERE completion_id = ? AND delivery_state = 'pending'
      `);
      for (const row of rows) {
        const result = update.run(deliveryId, timestamp, row.completion_id);
        if (changesCount(result) === 1) claimedIds.push(row.completion_id);
      }
      return claimedIds.map((completionId) => this.#findCompletion(completionId));
    });
  }

  ackDelivery(first, second) {
    const options = typeof first === 'string'
      ? { deliveryId: first, now: second }
      : optionsFrom(first);
    const deliveryId = requiredString(options.deliveryId, 'deliveryId');
    const deliveredAt = asTimestamp(options.now);

    return this.#transaction(() => {
      const rows = this.db.prepare(`
        SELECT completion_id FROM completions
        WHERE delivery_id = ? AND delivery_state IN ('claimed_direct', 'claimed_hook')
      `).all(deliveryId);
      if (rows.length === 0) return null;
      const result = this.db.prepare(`
        UPDATE completions
        SET delivery_state = 'delivered', delivered_at = ?
        WHERE delivery_id = ? AND delivery_state IN ('claimed_direct', 'claimed_hook')
      `).run(deliveredAt, deliveryId);
      const count = changesCount(result);
      if (count === 0) return null;
      const completions = rows.map((row) => this.#findCompletion(row.completion_id));
      return {
        ...completions[0],
        acknowledged: true,
        count,
        completions,
      };
    });
  }

  requeueExpiredLeases(options = {}) {
    const now = asTimestamp(options.now);
    const leaseMs = options.leaseMs ?? options.leaseDurationMs ?? DEFAULT_DELIVERY_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 0) {
      throw new TypeError('leaseMs must be a non-negative integer.');
    }
    const cutoff = new Date(Date.parse(now) - leaseMs).toISOString();
    return this.#transaction(() => {
      const result = this.db.prepare(`
        UPDATE completions
        SET delivery_state = 'pending', delivery_id = NULL, delivery_started_at = NULL, delivered_at = NULL
        WHERE delivery_state IN ('claimed_direct', 'claimed_hook')
          AND delivery_started_at IS NOT NULL
          AND delivery_started_at <= ?
      `).run(cutoff);
      return changesCount(result);
    });
  }
}

export function openSqliteStore(dataDir = DEFAULT_DATA_DIR) {
  return SqliteStore.open(dataDir);
}
