import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PRESENCE_LEASE_MS } from '../../shared/constants.mjs';
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

// 全部 CAS 表。检测到旧 V1 schema 时按规格 §2.11 整体 DROP 后按 V2 重建，不做任何数据迁移。
const CAS_TABLES = Object.freeze([
  'meta',
  'executions',
  'completions',
  'thread_holds',
  'host_presence',
  'current_sessions',
]);

const V2_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS executions (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    host TEXT NOT NULL,
    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL,
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

  CREATE INDEX IF NOT EXISTS executions_scope_idx
    ON executions(host, workspace, session_id, last_activity_at);

  CREATE TABLE IF NOT EXISTS completions (
    completion_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    host TEXT NOT NULL,
    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    terminal_status TEXT NOT NULL CHECK (terminal_status IN (${TERMINAL_STATUS_SQL})),
    payload_json TEXT NOT NULL,
    delivery_state TEXT NOT NULL CHECK (delivery_state IN (${DELIVERY_STATE_SQL})),
    delivery_id TEXT,
    delivery_started_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (thread_id, turn_id)
  );

  CREATE INDEX IF NOT EXISTS completions_pending_scope_idx
    ON completions(host, workspace, session_id, delivery_state, created_at);

  DROP INDEX IF EXISTS completions_pending_workspace_idx;

  CREATE TABLE IF NOT EXISTS thread_holds (
    thread_id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    holder_host TEXT NOT NULL,
    hold_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS thread_holds_holder_idx
    ON thread_holds(holder_host, workspace);

  CREATE TABLE IF NOT EXISTS host_presence (
    host TEXT NOT NULL,
    workspace TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (host, workspace, instance_id)
  );

  CREATE INDEX IF NOT EXISTS host_presence_expiry_idx
    ON host_presence(host, workspace, expires_at);

  CREATE TABLE IF NOT EXISTS current_sessions (
    host TEXT NOT NULL,
    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (host, workspace)
  );

  INSERT INTO meta(key, value)
    VALUES ('schema_version', '2')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;

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

function presenceLeaseMs(value) {
  const lease = value ?? PRESENCE_LEASE_MS;
  if (!Number.isSafeInteger(lease) || lease < 0) {
    throw new TypeError('leaseMs must be a non-negative integer.');
  }
  return lease;
}

function changedFiles(value) {
  return summarizeChangedFiles(value?.files);
}

function canonicalPayload(value, fallbackThreadId, fallbackTurnId) {
  const source = typeof value?.toJSON === 'function' ? value.toJSON() : value;
  if (!isRecord(source)) {
    throw new TypeError('Terminal result payload must be an object.');
  }

  if (source.threadId !== undefined && source.threadId !== fallbackThreadId) {
    throw new TypeError('Terminal result threadId does not match the completion row.');
  }
  if (source.turnId !== undefined && source.turnId !== fallbackTurnId) {
    throw new TypeError('Terminal result turnId does not match the completion row.');
  }
  const threadId = requiredString(fallbackThreadId ?? source.threadId, 'threadId');
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
    host: row.host,
    workspace: row.workspace,
    sessionId: row.session_id,
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
    host: row.host,
    workspace: row.workspace,
    sessionId: row.session_id,
    terminalStatus: row.terminal_status,
    payload,
    deliveryState: row.delivery_state,
    deliveryId: row.delivery_id,
    deliveryStartedAt: row.delivery_started_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}

function threadHoldFromRow(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    workspace: row.workspace,
    holderHost: row.holder_host,
    holdId: row.hold_id,
    acquiredAt: row.acquired_at,
    updatedAt: row.updated_at,
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

function tableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
}

// V1 → V2 不做迁移（规格 §2.11）：schema_version 缺失/小于 2，或 executions/completions
// 缺少 host 列，即判定为旧 schema，需要整体废弃重建。全新空库直接按 V2 建立。
function requiresV2Rebuild(db) {
  const tables = tableNames(db);
  if (!tables.has('meta') && !tables.has('executions') && !tables.has('completions')) {
    return false;
  }
  let version = null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    version = row?.value ?? null;
  } catch {
    version = null;
  }
  if (version !== '2') return true;
  const hasHostColumn = (tableName) => {
    if (!tables.has(tableName)) return true;
    return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === 'host');
  };
  return !hasHostColumn('executions') || !hasHostColumn('completions');
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
      if (requiresV2Rebuild(db)) {
        db.exec('BEGIN IMMEDIATE;');
        try {
          for (const table of CAS_TABLES) {
            db.exec(`DROP TABLE IF EXISTS ${table};`);
          }
          db.exec('COMMIT;');
        } catch (error) {
          try {
            db.exec('ROLLBACK;');
          } catch {
            // Preserve the original database error.
          }
          throw error;
        }
      }
      db.exec(V2_SCHEMA_SQL);
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

  #upsertCurrentSession(host, workspace, sessionId, timestamp) {
    this.db.prepare(`
      INSERT INTO current_sessions(host, workspace, session_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(host, workspace) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `).run(host, workspace, sessionId, timestamp);
  }

  #upsertThreadHold(threadId, workspace, holderHost, holdId, timestamp) {
    this.db.prepare(`
      INSERT INTO thread_holds(thread_id, workspace, holder_host, hold_id, acquired_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        workspace = excluded.workspace,
        holder_host = excluded.holder_host,
        hold_id = excluded.hold_id,
        acquired_at = excluded.acquired_at,
        updated_at = excluded.updated_at
    `).run(threadId, workspace, holderHost, holdId, timestamp, timestamp);
  }

  createExecution(input = {}) {
    const options = optionsFrom(input);
    const host = requiredString(options.host, 'host');
    const workspace = requiredString(options.workspace, 'workspace');
    const sessionId = requiredString(options.sessionId, 'sessionId');
    const threadId = requiredString(options.threadId, 'threadId');
    const turnId = requiredString(options.turnId, 'turnId');
    const ownerInstanceId = requiredString(options.ownerInstanceId ?? randomUUID(), 'ownerInstanceId');
    const startedAt = asTimestamp(options.startedAt ?? options.now);
    const lastActivityAt = asTimestamp(options.lastActivityAt ?? options.now ?? startedAt);

    return this.#transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO executions(
          thread_id, turn_id, host, workspace, session_id, owner_instance_id,
          model, effort, started_at, last_activity_at,
          reservation_id, reservation_kind, reservation_created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(thread_id, turn_id) DO NOTHING
      `).run(
        threadId,
        turnId,
        host,
        workspace,
        sessionId,
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

  // Trusted supervisor event path 专用：按物理 Thread ID 关联 Execution。
  // 不得被 MCP、Hook、drain 或普通 Host request 调用（规格 §2.8）。
  getExecutionByPhysicalThreadId(threadId, turnId) {
    const id = requiredString(threadId, 'threadId');
    return this.#findExecution(id, turnId);
  }

  listExecutions(options = {}) {
    const clauses = [];
    const values = [];
    if (options.host !== undefined) {
      clauses.push('host = ?');
      values.push(requiredString(options.host, 'host'));
    }
    if (options.workspace !== undefined) {
      clauses.push('workspace = ?');
      values.push(requiredString(options.workspace, 'workspace'));
    }
    if (options.sessionId !== undefined) {
      clauses.push('session_id = ?');
      values.push(requiredString(options.sessionId, 'sessionId'));
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(
      `SELECT * FROM executions${where} ORDER BY last_activity_at DESC`,
    ).all(...values);
    return rows.map(executionFromRow);
  }

  reserveDirect(input = {}) {
    const options = optionsFrom(input);
    const host = requiredString(options.host, 'host');
    const workspace = requiredString(options.workspace, 'workspace');
    const sessionId = requiredString(options.sessionId, 'sessionId');
    const threadId = requiredString(options.threadId, 'threadId');
    const requestedReservationId = requiredString(options.reservationId ?? options.deliveryId ?? randomUUID(), 'reservationId');
    const timestamp = asTimestamp(options.now);

    return this.#transaction(() => {
      const executionRow = this.db.prepare(`
        SELECT * FROM executions
        WHERE thread_id = ? AND host = ? AND workspace = ? AND session_id = ?
        ORDER BY started_at DESC LIMIT 1
      `).get(threadId, host, workspace, sessionId);
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
            host: execution.host,
            workspace: execution.workspace,
            sessionId: execution.sessionId,
          };
        }
        if (execution.reservationId !== null) {
          return { reserved: false, reason: 'already_reserved', threadId, turnId: execution.turnId };
        }
        const update = this.db.prepare(`
          UPDATE executions
          SET reservation_id = ?, reservation_kind = 'direct', reservation_created_at = ?
          WHERE thread_id = ? AND turn_id = ? AND host = ? AND reservation_id IS NULL
        `).run(requestedReservationId, timestamp, execution.threadId, execution.turnId, host);
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
          host: execution.host,
          workspace: execution.workspace,
          sessionId: execution.sessionId,
        };
      }

      // 归属诊断：thread 上存在其他 HostScope 的 active execution 时，给出明确的拒绝原因。
      // 只读取归属字段用于裁决，不返回其他 Host 的业务数据。
      const foreignRow = this.db.prepare(`
        SELECT host, workspace, session_id, turn_id FROM executions
        WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1
      `).get(threadId);
      if (foreignRow) {
        if (foreignRow.host !== host) {
          return {
            reserved: false,
            reason: 'host_mismatch',
            threadId,
            holderHost: foreignRow.host,
          };
        }
        return {
          reserved: false,
          reason: 'session_mismatch',
          threadId,
          holderHost: foreignRow.host,
          holderSessionId: foreignRow.session_id,
          holderWorkspace: foreignRow.workspace,
        };
      }

      const pendingRow = this.db.prepare(`
        SELECT * FROM completions
        WHERE thread_id = ? AND host = ? AND workspace = ? AND session_id = ?
          AND delivery_state = 'pending'
        ORDER BY created_at ASC LIMIT 1
      `).get(threadId, host, workspace, sessionId);
      if (!pendingRow) {
        return { reserved: false, reason: 'not_found', threadId };
      }
      const claimed = this.db.prepare(`
        UPDATE completions
        SET delivery_state = 'claimed_direct', delivery_id = ?, delivery_started_at = ?, delivered_at = NULL
        WHERE completion_id = ? AND host = ? AND delivery_state = 'pending'
      `).run(requestedReservationId, timestamp, pendingRow.completion_id, host);
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
        host: completion.host,
        workspace: completion.workspace,
        sessionId: completion.sessionId,
        completion,
      };
    });
  }

  releaseReservation(input = {}) {
    const options = optionsFrom(input);
    const host = requiredString(options.host, 'host');
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
            WHERE host = ? AND delivery_id = ? AND delivery_state = 'claimed_direct'
          `).run(host, requestedReservationId)
          : this.db.prepare(`
            UPDATE completions
            SET delivery_state = 'pending', delivery_id = NULL, delivery_started_at = NULL, delivered_at = NULL
            WHERE host = ? AND delivery_id = ? AND thread_id = ? AND delivery_state = 'claimed_direct'
          `).run(host, requestedReservationId, threadId);
        completionChanges = changesCount(completionResult);
      }

      let executionChanges = 0;
      if (threadId !== undefined || requestedReservationId !== undefined) {
        let executionResult;
        if (threadId !== undefined && requestedReservationId !== undefined) {
          executionResult = this.db.prepare(`
            UPDATE executions
            SET reservation_id = NULL, reservation_kind = NULL, reservation_created_at = NULL
            WHERE host = ? AND thread_id = ? AND reservation_id = ? AND reservation_kind = 'direct'
          `).run(host, threadId, requestedReservationId);
        } else if (threadId !== undefined) {
          executionResult = this.db.prepare(`
            UPDATE executions
            SET reservation_id = NULL, reservation_kind = NULL, reservation_created_at = NULL
            WHERE host = ? AND thread_id = ? AND reservation_kind = 'direct'
          `).run(host, threadId);
        } else {
          executionResult = this.db.prepare(`
            UPDATE executions
            SET reservation_id = NULL, reservation_kind = NULL, reservation_created_at = NULL
            WHERE host = ? AND reservation_id = ? AND reservation_kind = 'direct'
          `).run(host, requestedReservationId);
        }
        executionChanges = changesCount(executionResult);
      }
      return {
        released: completionChanges + executionChanges > 0,
        completionCount: completionChanges,
        executionCount: executionChanges,
        host,
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
    const payload = canonicalPayload(inputPayload, threadId, turnId);
    const requestedStatus = options.status ?? options.terminalStatus;
    if (requestedStatus !== undefined && normalizeTerminalStatus(requestedStatus) !== payload.status) {
      throw new TypeError('Terminal result status does not match the completion row.');
    }
    const completionId = requiredString(options.completionId ?? options.id ?? randomUUID(), 'completionId');
    const requestedHost = options.host;
    const requestedWorkspace = options.workspace ?? payload.workspace;
    const requestedSessionId = options.sessionId;
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
        if (requestedHost !== undefined && requestedHost !== existing.host) {
          throw new Error('Terminal completion host does not match its completion.');
        }
        if (requestedWorkspace !== undefined && requestedWorkspace !== existing.workspace) {
          throw new Error('Terminal completion workspace does not match its completion.');
        }
        if (requestedSessionId !== undefined && requestedSessionId !== existing.session_id) {
          throw new Error('Terminal completion session does not match its completion.');
        }
        this.db.prepare('DELETE FROM executions WHERE thread_id = ? AND turn_id = ?').run(threadId, turnId);
        return {
          inserted: false,
          ...completionFromRow(existing),
        };
      }

      let host;
      let workspace;
      let sessionId;
      if (execution) {
        // Terminal 事务内 provenance 直接从 Execution 继承，不得读取 current_session 重算（规格 §2.4）。
        host = execution.host;
        workspace = execution.workspace;
        sessionId = execution.sessionId;
        if (requestedHost !== undefined && requestedHost !== host) {
          throw new Error('Terminal completion host does not match its execution.');
        }
        if (requestedWorkspace !== undefined && requestedWorkspace !== workspace) {
          throw new Error('Terminal completion workspace does not match its execution.');
        }
        if (requestedSessionId !== undefined && requestedSessionId !== sessionId) {
          throw new Error('Terminal completion session does not match its execution.');
        }
      } else {
        // 无 Execution 的 trusted/recovery 路径必须显式携带 provenance。
        host = requiredString(requestedHost, 'host');
        workspace = requiredString(requestedWorkspace, 'workspace');
        sessionId = requiredString(requestedSessionId, 'sessionId');
      }

      const directReservation = execution?.reservationKind === 'direct' && execution.reservationId
        ? execution.reservationId
        : null;
      const deliveryState = directReservation ? 'claimed_direct' : 'pending';
      const insertResult = this.db.prepare(`
        INSERT INTO completions(
          completion_id, thread_id, turn_id, host, workspace, session_id,
          terminal_status, payload_json, delivery_state, delivery_id,
          delivery_started_at, delivered_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(thread_id, turn_id) DO NOTHING
      `).run(
        completionId,
        threadId,
        turnId,
        host,
        workspace,
        sessionId,
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
    const clauses = [];
    const values = [];
    if (options.host !== undefined) {
      clauses.push('host = ?');
      values.push(requiredString(options.host, 'host'));
    }
    if (options.workspace !== undefined) {
      clauses.push('workspace = ?');
      values.push(requiredString(options.workspace, 'workspace'));
    }
    if (options.sessionId !== undefined) {
      clauses.push('session_id = ?');
      values.push(requiredString(options.sessionId, 'sessionId'));
    }
    const state = options.deliveryState ?? options.delivery_state;
    if (state !== undefined) {
      if (!DELIVERY_STATES.includes(state)) throw new TypeError('Unknown delivery state.');
      clauses.push('delivery_state = ?');
      values.push(state);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM completions${where} ORDER BY created_at ASC`).all(...values);
    return rows.map(completionFromRow);
  }

  claimPendingHook(input = {}) {
    const options = optionsFrom(input);
    const host = requiredString(options.host, 'host');
    const workspace = requiredString(options.workspace, 'workspace');
    const sessionId = requiredString(options.sessionId, 'sessionId');
    const deliveryId = requiredString(options.deliveryId ?? randomUUID(), 'deliveryId');
    const timestamp = asTimestamp(options.now);
    const limit = positiveInteger(options.limit, 100);

    return this.#transaction(() => {
      const rows = this.db.prepare(`
        SELECT completion_id FROM completions
        WHERE host = ? AND workspace = ? AND session_id = ? AND delivery_state = 'pending'
        ORDER BY created_at ASC
        LIMIT ?
      `).all(host, workspace, sessionId, limit);
      const claimedIds = [];
      const update = this.db.prepare(`
        UPDATE completions
        SET delivery_state = 'claimed_hook', delivery_id = ?, delivery_started_at = ?, delivered_at = NULL
        WHERE completion_id = ? AND host = ? AND delivery_state = 'pending'
      `);
      for (const row of rows) {
        const result = update.run(deliveryId, timestamp, row.completion_id, host);
        if (changesCount(result) === 1) claimedIds.push(row.completion_id);
      }
      return claimedIds.map((completionId) => this.#findCompletion(completionId));
    });
  }

  ackDelivery(input = {}) {
    const options = optionsFrom(input);
    const host = requiredString(options.host, 'host');
    const deliveryId = requiredString(options.deliveryId, 'deliveryId');
    const deliveredAt = asTimestamp(options.now);

    return this.#transaction(() => {
      const rows = this.db.prepare(`
        SELECT completion_id FROM completions
        WHERE host = ? AND delivery_id = ? AND delivery_state IN ('claimed_direct', 'claimed_hook')
      `).all(host, deliveryId);
      if (rows.length === 0) return null;
      const result = this.db.prepare(`
        UPDATE completions
        SET delivery_state = 'delivered', delivered_at = ?
        WHERE host = ? AND delivery_id = ? AND delivery_state IN ('claimed_direct', 'claimed_hook')
      `).run(deliveredAt, host, deliveryId);
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

  nackDelivery(input = {}) {
    const options = optionsFrom(input);
    const host = requiredString(options.host, 'host');
    const deliveryId = requiredString(options.deliveryId, 'deliveryId');

    return this.#transaction(() => {
      const rows = this.db.prepare(`
        SELECT completion_id FROM completions
        WHERE host = ? AND delivery_id = ? AND delivery_state IN ('claimed_direct', 'claimed_hook')
      `).all(host, deliveryId);
      if (rows.length === 0) return null;
      const result = this.db.prepare(`
        UPDATE completions
        SET delivery_state = 'pending', delivery_id = NULL, delivery_started_at = NULL, delivered_at = NULL
        WHERE host = ? AND delivery_id = ? AND delivery_state IN ('claimed_direct', 'claimed_hook')
      `).run(host, deliveryId);
      const count = changesCount(result);
      if (count === 0) return null;
      const completions = rows.map((row) => this.#findCompletion(row.completion_id));
      return {
        ...completions[0],
        nacked: true,
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

  attachHostPresence(input = {}) {
    const host = requiredString(input.host, 'host');
    const workspace = requiredString(input.workspace, 'workspace');
    const instanceId = requiredString(input.instanceId, 'instanceId');
    const timestamp = asTimestamp(input.now);
    const leaseMs = presenceLeaseMs(input.leaseMs);
    const expiresAt = new Date(Date.parse(timestamp) + leaseMs).toISOString();

    return this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO host_presence(host, workspace, instance_id, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(host, workspace, instance_id) DO UPDATE SET
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at
      `).run(host, workspace, instanceId, timestamp, expiresAt);
      return { host, workspace, instanceId, heartbeatAt: timestamp, expiresAt, leaseMs };
    });
  }

  heartbeatHostPresence(input = {}) {
    const host = requiredString(input.host, 'host');
    const workspace = requiredString(input.workspace, 'workspace');
    const instanceId = requiredString(input.instanceId, 'instanceId');
    const timestamp = asTimestamp(input.now);
    const leaseMs = presenceLeaseMs(input.leaseMs);
    const expiresAt = new Date(Date.parse(timestamp) + leaseMs).toISOString();

    return this.#transaction(() => {
      const result = this.db.prepare(`
        UPDATE host_presence
        SET heartbeat_at = ?, expires_at = ?
        WHERE host = ? AND workspace = ? AND instance_id = ?
      `).run(timestamp, expiresAt, host, workspace, instanceId);
      return {
        host,
        workspace,
        instanceId,
        heartbeatAt: timestamp,
        expiresAt,
        leaseMs,
        refreshed: changesCount(result) === 1,
      };
    });
  }

  detachHostPresence(input = {}) {
    const host = requiredString(input.host, 'host');
    const workspace = requiredString(input.workspace, 'workspace');
    const instanceId = requiredString(input.instanceId, 'instanceId');

    return this.#transaction(() => {
      const result = this.db.prepare(`
        DELETE FROM host_presence
        WHERE host = ? AND workspace = ? AND instance_id = ?
      `).run(host, workspace, instanceId);
      return { host, workspace, instanceId, detached: changesCount(result) === 1 };
    });
  }

  isHostAlive(input = {}) {
    const host = requiredString(input.host, 'host');
    const workspace = requiredString(input.workspace, 'workspace');
    const timestamp = asTimestamp(input.now);

    return this.#transaction(() => {
      // 过期记录 lazy delete；过期行本身不得被解释为 Host alive（规格 §2.7）。
      this.db.prepare(`
        DELETE FROM host_presence
        WHERE host = ? AND workspace = ? AND expires_at <= ?
      `).run(host, workspace, timestamp);
      const row = this.db.prepare(`
        SELECT EXISTS (
          SELECT 1 FROM host_presence
          WHERE host = ? AND workspace = ? AND expires_at > ?
        ) AS alive
      `).get(host, workspace, timestamp);
      return row.alive === 1;
    });
  }

  getThreadHold(threadId) {
    const id = requiredString(threadId, 'threadId');
    return threadHoldFromRow(this.db.prepare('SELECT * FROM thread_holds WHERE thread_id = ?').get(id));
  }

  // 单调用语义（规格 §1.7 / §十）：active Execution 是 lifecycle truth，以 execution.host
  // 为权威修复或拒绝；无 active Execution 时按 Hold + 注入的 isHostAlive 裁决。
  // isHostAlive 允许 async，因此 alive 判定发生在两个短事务之间；写入一律在自己的
  // BEGIN IMMEDIATE 事务内以 compare-and-set（WHERE thread_id / hold_id）完成，
  // 保证两个并发 takeover 只有一个成功，竞争时循环重读收敛。
  async acquireOrTakeoverThreadHold(input = {}) {
    const threadId = requiredString(input.threadId, 'threadId');
    const workspace = requiredString(input.workspace, 'workspace');
    const holderHost = requiredString(input.holderHost, 'holderHost');
    const holdId = requiredString(input.holdId ?? randomUUID(), 'holdId');
    const timestamp = asTimestamp(input.now);
    if (typeof input.isHostAlive !== 'function') {
      throw new TypeError('isHostAlive must be a function.');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = this.#transaction(() => {
        const executions = this.db.prepare(`
          SELECT thread_id, turn_id, host, workspace, session_id FROM executions
          WHERE thread_id = ? ORDER BY started_at DESC
        `).all(threadId);
        const hold = threadHoldFromRow(
          this.db.prepare('SELECT * FROM thread_holds WHERE thread_id = ?').get(threadId),
        );
        return { executions, hold };
      });

      const hosts = [...new Set(snapshot.executions.map((row) => row.host))];
      if (hosts.length > 1) {
        // 同一 Thread 出现不同 Host 的冲突 active Execution：Thread fail closed（规格 §十）。
        return { status: 'rejected', reason: 'conflicting_executions', hosts, threadId };
      }

      if (hosts.length === 1) {
        const execution = executionFromRow(snapshot.executions[0]);
        if (execution.host !== holderHost) {
          return {
            status: 'rejected',
            reason: 'active_execution',
            holderHost: execution.host,
            execution,
            threadId,
          };
        }
        const repaired = this.#transaction(() => {
          const currentHosts = this.db.prepare(
            'SELECT DISTINCT host FROM executions WHERE thread_id = ?',
          ).all(threadId).map((row) => row.host);
          if (currentHosts.length !== 1 || currentHosts[0] !== holderHost) return null;
          this.#upsertThreadHold(threadId, execution.workspace ?? workspace, holderHost, holdId, timestamp);
          return this.getThreadHold(threadId);
        });
        if (repaired) {
          return { status: 'acquired', mode: 'repair', holdId, hold: repaired, threadId };
        }
        continue;
      }

      const hold = snapshot.hold;
      if (hold && hold.holderHost === holderHost) {
        // 情况 D：Hold 已属于当前 Host，直接继续，不重新生成。
        return { status: 'held', holdId: hold.holdId, hold, threadId };
      }
      if (hold) {
        const alive = await input.isHostAlive({ host: hold.holderHost, workspace: hold.workspace });
        if (alive === true) {
          return {
            status: 'rejected',
            reason: 'existing_holder',
            holderHost: hold.holderHost,
            hold,
            threadId,
          };
        }
        const taken = this.#transaction(() => {
          const result = this.db.prepare(`
            UPDATE thread_holds
            SET holder_host = ?, hold_id = ?, workspace = ?, acquired_at = ?, updated_at = ?
            WHERE thread_id = ? AND hold_id = ?
          `).run(holderHost, holdId, workspace, timestamp, timestamp, threadId, hold.holdId);
          if (changesCount(result) !== 1) return null;
          return this.getThreadHold(threadId);
        });
        if (taken) {
          return {
            status: 'acquired',
            mode: 'takeover',
            holdId,
            previousHolder: hold.holderHost,
            hold: taken,
            threadId,
          };
        }
        continue;
      }

      const acquired = this.#transaction(() => {
        const result = this.db.prepare(`
          INSERT INTO thread_holds(thread_id, workspace, holder_host, hold_id, acquired_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id) DO NOTHING
        `).run(threadId, workspace, holderHost, holdId, timestamp, timestamp);
        if (changesCount(result) !== 1) return null;
        return this.getThreadHold(threadId);
      });
      if (acquired) {
        return { status: 'acquired', mode: 'acquire', holdId, hold: acquired, threadId };
      }
      // 另一个并发调用先取得 Hold；循环重读后按 existing_holder / stale 重新裁决。
    }
    return { status: 'rejected', reason: 'contention', threadId };
  }

  releaseThreadHold(threadId, holdId) {
    const id = requiredString(threadId, 'threadId');
    const targetHoldId = requiredString(holdId, 'holdId');
    return this.#transaction(() => {
      const result = this.db.prepare(
        'DELETE FROM thread_holds WHERE thread_id = ? AND hold_id = ?',
      ).run(id, targetHoldId);
      return { released: changesCount(result) === 1, threadId: id, holdId: targetHoldId };
    });
  }

  getCurrentSession(input = {}) {
    const host = requiredString(input.host, 'host');
    const workspace = requiredString(input.workspace, 'workspace');
    const row = this.db.prepare(
      'SELECT session_id FROM current_sessions WHERE host = ? AND workspace = ?',
    ).get(host, workspace);
    return row?.session_id ?? null;
  }

  activeSessionSet(input = {}) {
    const host = requiredString(input.host, 'host');
    const workspace = requiredString(input.workspace, 'workspace');
    const rows = this.db.prepare(
      'SELECT DISTINCT session_id FROM executions WHERE host = ? AND workspace = ?',
    ).all(host, workspace);
    return new Set(rows.map((row) => row.session_id));
  }

  // 弱 Host Session Gate（架构设计 §四）：读 active executions + 读 current_session +
  // 判断 + 更新在同一个 BEGIN IMMEDIATE 事务内原子完成。
  sessionGateTransition(input = {}) {
    const host = requiredString(input.host, 'host');
    const workspace = requiredString(input.workspace, 'workspace');
    const sessionId = requiredString(input.sessionId, 'sessionId');
    const timestamp = asTimestamp(input.now);

    return this.#transaction(() => {
      const activeSessions = new Set(
        this.db.prepare(
          'SELECT DISTINCT session_id FROM executions WHERE host = ? AND workspace = ?',
        ).all(host, workspace).map((row) => row.session_id),
      );
      const currentRow = this.db.prepare(
        'SELECT session_id FROM current_sessions WHERE host = ? AND workspace = ?',
      ).get(host, workspace);
      const currentSession = currentRow?.session_id ?? null;

      if (activeSessions.has(sessionId)) {
        if (activeSessions.size === 1) {
          const repaired = currentSession !== sessionId;
          if (repaired) {
            this.#upsertCurrentSession(host, workspace, sessionId, timestamp);
          }
          return {
            decision: 'allow',
            reason: repaired ? 'current_session_repaired' : 'session_authorized',
            currentSession: sessionId,
            activeSessions: [...activeSessions],
          };
        }
        return {
          decision: 'veto',
          reason: 'multiple_active_sessions',
          conflict: true,
          activeSessions: [...activeSessions],
        };
      }

      if (activeSessions.size === 0) {
        // current_session 为 null/不存在视同"集合 0"分支：原子建立或懒切换 routing state。
        const reason = currentSession === null
          ? 'session_established'
          : currentSession === sessionId ? 'session_reconfirmed' : 'session_handoff';
        this.#upsertCurrentSession(host, workspace, sessionId, timestamp);
        return { decision: 'allow', reason, currentSession: sessionId, activeSessions: [] };
      }

      if (activeSessions.size === 1) {
        return {
          decision: 'veto',
          reason: 'other_session_active',
          activeSessions: [...activeSessions],
        };
      }
      return {
        decision: 'veto',
        reason: 'multiple_active_sessions',
        conflict: true,
        activeSessions: [...activeSessions],
      };
    });
  }

  // Runtime 崩溃恢复（规格 §2.10 / 架构设计 §六）：以 active Execution 为权威校验/修复
  // current_session；0 active 保留现状；>1 返回 conflict 标记且不写入。
  fixCurrentSessionFromExecutions(input = {}) {
    const host = requiredString(input.host, 'host');
    const workspace = requiredString(input.workspace, 'workspace');
    const timestamp = asTimestamp(input.now);

    return this.#transaction(() => {
      const activeSessions = [...new Set(
        this.db.prepare(
          'SELECT DISTINCT session_id FROM executions WHERE host = ? AND workspace = ?',
        ).all(host, workspace).map((row) => row.session_id),
      )];
      const currentRow = this.db.prepare(
        'SELECT session_id FROM current_sessions WHERE host = ? AND workspace = ?',
      ).get(host, workspace);
      const currentSession = currentRow?.session_id ?? null;

      if (activeSessions.length === 0) {
        return { fixed: false, reason: 'no_active_execution', currentSession, activeSessions };
      }
      if (activeSessions.length === 1) {
        const [session] = activeSessions;
        this.#upsertCurrentSession(host, workspace, session, timestamp);
        return {
          fixed: true,
          reason: currentSession === session ? 'already_consistent' : 'repaired',
          session,
          currentSession: session,
          activeSessions,
        };
      }
      return {
        fixed: false,
        conflict: true,
        reason: 'multiple_active_sessions',
        currentSession,
        activeSessions,
      };
    });
  }
}

export function openSqliteStore(dataDir = DEFAULT_DATA_DIR) {
  return SqliteStore.open(dataDir);
}
