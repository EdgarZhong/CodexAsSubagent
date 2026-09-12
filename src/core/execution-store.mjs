function asStore(value) {
  if (value && typeof value.createExecution === 'function' && typeof value.reserveWaiter === 'function') {
    return value;
  }
  if (value?.store && typeof value.store.createExecution === 'function') return value.store;
  throw new TypeError('ExecutionStore requires a SqliteStore.');
}

export class ExecutionStore {
  constructor(store) {
    this.store = asStore(store);
  }

  createExecution(input = {}) {
    return this.store.createExecution(input);
  }

  reserveWaiter(input = {}) {
    return this.store.reserveWaiter(input);
  }

  releaseReservation(input = {}) {
    return this.store.releaseReservation(input);
  }

  // Trusted supervisor event path 专用（规格 §2.8），不得用于 Host request 投影。
  getExecutionByPhysicalThreadId(threadId, turnId) {
    return this.store.getExecutionByPhysicalThreadId(threadId, turnId);
  }

  listExecutions(options = {}) {
    return this.store.listExecutions(options);
  }
}

export function createExecutionStore(store) {
  return new ExecutionStore(store);
}
