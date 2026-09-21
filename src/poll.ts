const MAX_POLL_DELAY_SECS = 600; // 10 minutes

/** Compute the next poll delay in ms given the base interval (seconds) and consecutive failure count. */
export function nextPollDelay(baseSecs: number, failures: number): number {
  return Math.min(baseSecs * Math.pow(2, failures), MAX_POLL_DELAY_SECS) * 1000;
}
