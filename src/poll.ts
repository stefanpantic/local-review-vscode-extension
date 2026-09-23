const MAX_POLL_DELAY_SECS = 600; // 10 minutes

/** Compute the next poll delay in ms given the base interval (seconds) and consecutive failure count. */
export function nextPollDelay(baseSecs: number, failures: number): number {
  return Math.min(baseSecs * Math.pow(2, failures), MAX_POLL_DELAY_SECS) * 1000;
}

/** Advance the consecutive-failure count by one tick's outcome. A success clears the run. */
export function nextFailureCount(current: number, failed: boolean): number {
  return failed ? current + 1 : 0;
}
