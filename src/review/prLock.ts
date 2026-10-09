// One pull request's network mutations (open, sync, submit, discard) run one at a time, in the order callers
// requested them. A Submit can hold the lock for minutes while GitHub spaces out and rate-limits its writes. An
// operation running beside the Submit would save a review built from a read that the Submit has since changed,
// so a waiter that reaches its time limit fails and does not run.

/** Thrown to a waiter that did not get the lock in time. The waiter's work did not run. */
export class PrLockBusyError extends Error {
  constructor() {
    super('Another GitHub operation on this pull request is still running. Try again when it finishes.');
    this.name = 'PrLockBusyError';
  }
}

interface Waiter {
  start: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class PrLock {
  private held = false;
  private readonly queue: Waiter[] = [];
  private requests = 0;

  /** Whether an operation holds the lock or is waiting for it. */
  get busy(): boolean {
    return this.held || this.queue.length > 0;
  }

  /**
   * How many operations have requested the lock so far. A reader that compares this before and after its own
   * network call knows whether an operation started in between, even one that has already finished.
   */
  get requested(): number {
    return this.requests;
  }

  /** Run `fn` once the lock is free. Rejects with `PrLockBusyError`, without running `fn`, after `waitMs`. */
  async run<T>(fn: () => Promise<T>, opts: { waitMs: number }): Promise<T> {
    this.requests++;
    if (this.held) await this.wait(opts.waitMs);
    this.held = true;
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private wait(waitMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { start: resolve };
      waiter.timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new PrLockBusyError());
      }, waitMs);
      waiter.start = () => {
        clearTimeout(waiter.timer);
        resolve();
      };
      this.queue.push(waiter);
    });
  }

  // The lock passes straight to the next waiter and stays held, so another caller cannot acquire it in between.
  private release(): void {
    const next = this.queue.shift();
    if (next) next.start();
    else this.held = false;
  }
}
