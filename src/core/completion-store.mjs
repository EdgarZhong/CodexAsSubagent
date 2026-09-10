import { TerminalResult } from './terminal-result.mjs';

function asStore(value) {
  if (value && typeof value.insertCompletionFirst === 'function' && typeof value.claimPendingHook === 'function') {
    return value;
  }
  if (value?.store && typeof value.store.insertCompletionFirst === 'function') return value.store;
  throw new TypeError('CompletionStore requires a SqliteStore.');
}

function terminalInput(first, second = {}) {
  if (first instanceof TerminalResult || typeof first?.toJSON === 'function') {
    return { ...second, terminalResult: first };
  }
  if (first?.terminalResult !== undefined || first?.result !== undefined) {
    return { ...first, ...second };
  }
  if (first?.payload !== undefined && first?.status === undefined) {
    return { ...first, ...second };
  }
  return {
    ...first,
    ...second,
    terminalResult: TerminalResult.fromTerminal(first),
  };
}

export class CompletionStore {
  constructor(store) {
    this.store = asStore(store);
  }

  insertCompletionFirst(first, second = {}) {
    return this.store.insertCompletionFirst(terminalInput(first, second));
  }

  claimPendingHook(first, second = {}) {
    return this.store.claimPendingHook(first, second);
  }

  ackDelivery(first, second) {
    return this.store.ackDelivery(first, second);
  }

  requeueExpiredLeases(options = {}) {
    return this.store.requeueExpiredLeases(options);
  }

  getCompletion(completionOrOptions) {
    return this.store.getCompletion(completionOrOptions);
  }

  listCompletions(options = {}) {
    return this.store.listCompletions(options);
  }
}

export function createCompletionStore(store) {
  return new CompletionStore(store);
}
