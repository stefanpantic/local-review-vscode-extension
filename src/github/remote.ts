// Parsing of git remote URLs and PR references, plus host/provider detection. No vscode, no network.
// Structured parsing is done by the built-in URL parser; the only bespoke step is normalizing git's
// scp-like short form into a URL, since that form is not a URL and no parser accepts it.
// github.com and a configured GitHub Enterprise host are both first-class; the API base URLs derive here.

export interface RemoteRepoRef {
  host: string; // lowercased host, with port if the URL had one
  owner: string;
  repo: string;
}

export type GithubProviderId = 'github' | 'github-enterprise';

/**
 * Turn any git remote form into a parseable URL string. A scheme URL (`https://`, `ssh://`, `git://`)
 * is returned as-is; git's scp-like `user@host:owner/repo` is rewritten to `ssh://user@host/owner/repo`.
 * git recognizes the scp form only when no slash precedes the first colon — the same rule applied here.
 */
function toUrlString(remote: string): string | undefined {
  if (remote.includes('://')) return remote;
  const colon = remote.indexOf(':');
  const slash = remote.indexOf('/');
  if (colon > 0 && (slash === -1 || colon < slash)) {
    return `ssh://${remote.slice(0, colon)}/${remote.slice(colon + 1)}`;
  }
  return undefined; // a bare local path or an unrecognized form — not a supported remote
}

/** Parse a git remote URL (https, ssh, or scp-like `git@host:owner/repo`) into its host/owner/repo. */
export function parseRemoteUrl(url: string): RemoteRepoRef | undefined {
  const trimmed = url.trim();
  const bare = trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  const asUrl = bare && toUrlString(bare);
  if (!asUrl) return undefined;
  let u: URL;
  try {
    u = new URL(asUrl);
  } catch {
    return undefined;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  return { host: u.host.toLowerCase(), owner: parts[0], repo: parts[1] };
}

/** A PR reference the user typed: a bare number/`#n`, or a full `.../owner/repo/pull/<n>` URL. */
export interface PrReference {
  number: number;
  repo?: RemoteRepoRef; // present only when a full URL was given
}

export function parsePrReference(input: string): PrReference | undefined {
  const s = input.trim();
  const digits = s.startsWith('#') ? s.slice(1) : s;
  if (/^\d+$/.test(digits)) return { number: Number(digits) };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  const parts = u.pathname.split('/').filter(Boolean); // [owner, repo, 'pull', '<n>', ...]
  const i = parts.indexOf('pull');
  const number = i > 1 ? Number(parts[i + 1]) : NaN;
  if (!Number.isInteger(number)) return undefined;
  return { number, repo: { host: u.host.toLowerCase(), owner: parts[i - 2], repo: parts[i - 1] } };
}

/** The host of a configured GitHub Enterprise base URL (e.g. `https://ghe.example.com`), lowercased. */
function enterpriseHost(enterpriseUri?: string): string | undefined {
  if (!enterpriseUri?.trim()) return undefined;
  try {
    return new URL(enterpriseUri).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Which GitHub provider a host belongs to: github.com, the configured GHE host, or unsupported. */
export function providerIdForHost(host: string, enterpriseUri?: string): GithubProviderId | undefined {
  const h = host.toLowerCase();
  if (h === 'github.com' || h === 'www.github.com') return 'github';
  return h === enterpriseHost(enterpriseUri) ? 'github-enterprise' : undefined;
}

/** REST + GraphQL API base URLs for a provider. github.com uses api.github.com; GHE uses `<host>/api/v3` and `/api/graphql`. */
export function apiBaseUrls(providerId: GithubProviderId, enterpriseUri?: string): { rest: string; graphql: string } {
  if (providerId === 'github') {
    return { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql' };
  }
  const base = (enterpriseUri ?? '').trim().replace(/\/+$/, '');
  return { rest: `${base}/api/v3`, graphql: `${base}/api/graphql` };
}
