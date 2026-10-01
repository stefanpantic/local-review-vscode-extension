// What the status bar shows for the GitHub rate-limit budgets. Pure, so it is unit-tested without VS Code.
import { clockTime, formatReset, resourceLabel, type RateLimitSnapshot } from './github/rateLimit';

/** Below this share of the limit left, the item warns. */
const LOW_SHARE = 0.1;

export type RateLimitSeverity = 'ok' | 'low' | 'exhausted';

export interface RateLimitView {
  text: string;
  tooltip: string; // Markdown
  severity: RateLimitSeverity;
}

/** A budget as it stands now. Once its reset time passes GitHub has refilled it, whatever was last read. */
function current(s: RateLimitSnapshot, now: Date): { remaining: number; used: number; refilled: boolean } {
  return s.resetAt.getTime() <= now.getTime()
    ? { remaining: s.limit, used: 0, refilled: true }
    : { remaining: s.remaining, used: s.used, refilled: false };
}

function severityOf(s: RateLimitSnapshot, now: Date): RateLimitSeverity {
  const { remaining } = current(s, now);
  if (remaining === 0) return 'exhausted';
  return remaining < s.limit * LOW_SHARE ? 'low' : 'ok';
}

/** The share of a budget left, rounded down so a nearly spent one never reads as more than it is. */
function percentLeft(s: RateLimitSnapshot, now: Date): string {
  const { remaining } = current(s, now);
  if (remaining === 0 || s.limit === 0) return '0%';
  const pct = Math.floor((remaining / s.limit) * 100);
  return pct === 0 ? '<1%' : `${pct}%`;
}

/** A count with thousands separators, "4,812". */
const count = (n: number): string => n.toLocaleString('en-US');

const RANK: Record<RateLimitSeverity, number> = { ok: 0, low: 1, exhausted: 2 };

/**
 * What the status bar shows for the tracked budgets, or undefined before any were seen. The text and its
 * color cover the host used last. The tooltip lists every host.
 */
export function rateLimitView(
  hosts: Array<{ host: string; limits: RateLimitSnapshot[] }>,
  now: Date,
): RateLimitView | undefined {
  const shown = hosts.find((h) => h.limits.length > 0);
  if (!shown) return undefined;

  const parts = shown.limits.map((s) => {
    const label = `${resourceLabel(s.resource)} ${percentLeft(s, now)}`;
    return current(s, now).remaining === 0 ? `${label}, resets ${clockTime(s.resetAt)}` : label;
  });
  const severity = shown.limits
    .map((s) => severityOf(s, now))
    .reduce<RateLimitSeverity>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ok');

  const lines = ['**GitHub API rate limits** (ReviewMate)'];
  for (const { host, limits } of hosts) {
    if (limits.length === 0) continue;
    lines.push('', '---', '', `**${host}**`, '');
    for (const s of limits) {
      const c = current(s, now);
      const left = `${count(c.remaining)} of ${count(s.limit)} left (${percentLeft(s, now)})`;
      const resets = c.refilled ? 'reset, not read since' : `resets ${formatReset(s.resetAt, now)}`;
      lines.push(`- **${resourceLabel(s.resource)}**: ${left}, ${resets}`);
    }
  }
  lines.push(
    '',
    '---',
    '',
    "_Hourly limits for your GitHub account, as of ReviewMate's last request. Other apps signed in as you use the same limits._",
  );
  return { text: `$(github) ReviewMate: ${parts.join(' · ')}`, tooltip: lines.join('\n'), severity };
}
