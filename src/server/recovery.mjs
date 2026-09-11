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

export async function recoverState({ executionStore, historyAdapter, completionRouter, ownerInstanceId = undefined } = {}) {
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
      terminalResult,
    });
    if (routed) recovered.push(routed);
  }
  return recovered;
}

export function canReapOrphanProcess(record, expected) {
  return Boolean(record && expected
    && Number.isInteger(record.pid) && record.pid === expected.pid
    && record.instanceId && record.instanceId === expected.instanceId
    && record.startedAt && record.startedAt === expected.startedAt
    && (!record.command || !expected.command || record.command === expected.command));
}
