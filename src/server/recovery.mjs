import { TerminalResult } from '../core/terminal-result.mjs';

function terminalStatus(value) {
  const status = value?.status;
  if (status === 'completed' || status === 'failed' || status === 'interrupted') return status;
  return null;
}

function terminalFromTurn(execution, turn) {
  const status = terminalStatus(turn);
  if (!status) return null;
  return new TerminalResult({
    threadId: execution.threadId,
    status,
    finalAssistantMessage: turn.finalAssistantMessage,
    lastAssistantMessage: turn.lastAssistantMessage,
    changes: turn.changes,
    error: turn.error,
  });
}

// current_session 恢复（规格 §2.10 / 架构设计 §六）：对账完成后按 (host, workspace)
// 分组校验/修复 current_session。0 active → 保留现状；唯一 → 修复；>1 → conflict
// 记日志且不写入。不得删除 thread_holds、不得重置 host_presence。
function fixCurrentSessions({ store, clock, logger }) {
  if (!store || typeof store.fixCurrentSessionFromExecutions !== 'function') return [];
  const executions = store.listExecutions();
  const scopes = [...new Set(executions.map((execution) => `${execution.host}\u0000${execution.workspace}`))]
    .map((key) => {
      const [host, workspace] = key.split('\u0000');
      return { host, workspace };
    });
  const conflicts = [];
  for (const { host, workspace } of scopes) {
    const result = store.fixCurrentSessionFromExecutions({ host, workspace, now: clock() });
    if (result?.conflict) {
      conflicts.push({ host, workspace, ...result });
      logger?.warn?.('recovery.session_conflict', {
        host,
        workspace,
        activeSessions: result.activeSessions,
        currentSession: result.currentSession,
      });
    }
  }
  return conflicts;
}

export async function recoverState({
  executionStore,
  historyAdapter,
  completionRouter,
  ownerInstanceId = undefined,
  logger = null,
  clock = () => new Date(),
} = {}) {
  if (!executionStore || !historyAdapter || !completionRouter) throw new TypeError('recoverState requires stores, history adapter and router.');
  const executions = executionStore.listExecutions();
  const recovered = [];
  for (const execution of executions) {
    if (ownerInstanceId !== undefined && execution.ownerInstanceId !== ownerInstanceId) continue;
    let result = null;
    try {
      const history = await historyAdapter.readRecentTurns(execution.threadId, { turnId: execution.turnId });
      const turn = history?.turns?.find((entry) => entry.id === execution.turnId || entry.turnId === execution.turnId);
      result = terminalFromTurn(execution, turn);
    } catch {
      result = null;
    }
    const terminalResult = result ?? new TerminalResult({
      threadId: execution.threadId,
      status: 'failed',
      lastAssistantMessage: 'Runtime Server stopped before the turn could be reconciled.',
      error: { type: 'supervisor_crash', message: 'The previous Runtime Server exited before terminal state was persisted.' },
    });
    const status = terminalResult.toJSON().status;
    const routed = completionRouter.onTerminal({
      type: 'recovery.terminal',
      provenance: 'recovery',
      verified: true,
      threadId: execution.threadId,
      turnId: execution.turnId,
      status,
      // synthetic failed 路径同样携带 Execution 的 (host, workspace, session) provenance；
      // execution 行存在时 insertCompletionFirst 以行为权威并校验一致性。
      host: execution.host,
      workspace: execution.workspace,
      sessionId: execution.sessionId,
      terminalResult,
    });
    if (routed) recovered.push(routed);
  }
  fixCurrentSessions({
    store: executionStore.store ?? executionStore,
    clock,
    logger,
  });
  return recovered;
}

export function canReapOrphanProcess(record, expected) {
  return Boolean(record && expected
    && Number.isInteger(record.pid) && record.pid === expected.pid
    && record.instanceId && record.instanceId === expected.instanceId
    && record.startedAt && record.startedAt === expected.startedAt
    && (!record.command || !expected.command || record.command === expected.command));
}
