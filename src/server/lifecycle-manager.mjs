export class LifecycleManager {
  constructor({
    idleShutdownMs = 3_000,
    onShutdown = async () => {},
    getActiveExecutionCount = () => 0,
    getUnackedDirectCount = () => 0,
    getInFlightRequestCount = () => this.inFlightRequests,
  } = {}) {
    this.idleShutdownMs = idleShutdownMs;
    this.onShutdown = onShutdown;
    this.getActiveExecutionCount = getActiveExecutionCount;
    this.getUnackedDirectCount = getUnackedDirectCount;
    this.getInFlightRequestCount = getInFlightRequestCount;
    this.inFlightRequests = 0;
    this.timer = null;
    this.closed = false;
  }

  noteRequestStart() {
    this.inFlightRequests += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  noteRequestEnd() {
    this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
    return this.maybeShutdown();
  }

  noteStateChange() {
    return this.maybeShutdown();
  }

  isIdle() {
    return !this.closed
      && this.getActiveExecutionCount() === 0
      && this.getInFlightRequestCount() === 0
      && this.getUnackedDirectCount() === 0;
  }

  maybeShutdown() {
    if (!this.isIdle() || this.timer) return false;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.isIdle()) return;
      await this.onShutdown();
    }, this.idleShutdownMs);
    this.timer.unref?.();
    return true;
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
