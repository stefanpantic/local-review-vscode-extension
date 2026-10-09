// One pull request's network mutations (open, sync, submit, discard) run one at a time, in the order they
// were asked for. A Submit can hold the lock for minutes while GitHub spaces out and rate-limits its writes,
// and anything that ran beside it would write a review built from what it read before Submit changed it. So
// a waiter that runs out of patience fails instead of going ahead.

/** Thrown to a waiter the lock was not handed to in time. Its work never ran. */
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

  /** Whether an operation holds the lock or is waiting for it. */
  get busy(): boolean {
    return this.held || this.queue.length > 0;
  }

  /** Run `fn` once the lock is free. Rejects with `PrLockBusyError`, without running `fn`, after `waitMs`. */
  async run<T>(fn: () => Promise<T>, opts: { waitMs: number }): Promise<T> {
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

  // The next waiter takes the lock over without it ever going free, so nothing can slip in between.
  private release(): void {
    const next = this.queue.shift();
    if (next) next.start();
    else this.held = false;
  }
}
