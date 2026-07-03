// Pure parsers for git CLI output (no vscode dependency → unit-testable).

/** Parse `git for-each-ref --format=%(refname:short) refs/heads` output into branch names. */
export function parseBranches(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
