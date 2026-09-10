function asStore(value) {
  if (value && typeof value.createExecution === 'function' && typeof value.reserveDirect === 'function') {
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

  reserveDirect(input, reservationId, now) {
    return this.store.reserveDirect(input, reservationId, now);
  }

  releaseReservation(input, reservationId) {
    return this.store.releaseReservation(input, reservationId);
  }

  getExecution(threadOrOptions, turnId) {
    return this.store.getExecution(threadOrOptions, turnId);
  }

  listExecutions(options = {}) {
    return this.store.listExecutions(options);
  }
}

export function createExecutionStore(store) {
  return new ExecutionStore(store);
}
