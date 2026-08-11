// The commits a fetched pull request contributes, read from the local object store. Pure git CLI, no
// vscode, so this is exercised against a real repository in the tests.
import type { PrCommit } from '../model/ReviewDiff';
import { git } from './run';

/** How many commits are returned before the caller is told how many more there are. */
export const COMMIT_LIMIT = 50;

// Field and record separators git will never emit inside a name, date, or subject, so a subject full of
// punctuation still parses. `%aI` is the author date in strict ISO 8601.
const FIELD = '\x1f';
const RECORD = '\x1e';
const LOG_FORMAT = `%H${FIELD}%an${FIELD}%aI${FIELD}%s${RECORD}`;

/** Parse the record stream `prCommits` asks git for. Records git separates with a newline of its own. */
export function parseCommitLog(raw: string): PrCommit[] {
  const out: PrCommit[] = [];
  for (const record of raw.split(RECORD)) {
    const fields = record.replace(/^\n+/, '').split(FIELD);
    if (fields.length < 4 || !fields[0]) continue;
    const [sha, author, date, ...subject] = fields;
    out.push({ sha, author, date, subject: subject.join(FIELD) });
  }
  return out;
}

/**
 * The commits reachable from the request's head but not from its base, newest first, which is the set of
 * commits the request adds. Both ends are pinned locally when the request is fetched, so this needs no
 * network. At most `limit` are returned and `total` says how many there were, so a long-running request
 * does not bury its caller.
 *
 * A base that no longer resolves (pruned by a `gc`) yields no commits rather than an error: a missing
 * commit list is worth far less than the diff it accompanies.
 */
export async function prCommits(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  limit?: number,
): Promise<{ commits: PrCommit[]; total: number }> {
  let raw: string;
  try {
    raw = await git(repoRoot, ['log', `--format=${LOG_FORMAT}`, `${baseSha}..${headSha}`]);
  } catch {
    return { commits: [], total: 0 };
  }
  const all = parseCommitLog(raw);
  return { commits: all.slice(0, limit ?? COMMIT_LIMIT), total: all.length };
}
