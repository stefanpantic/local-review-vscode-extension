// The Claude Code connect command for a running server. Pure: no vscode, so it is unit-tested.

/** Quote a path for a POSIX shell: single quotes, with any single quote inside closed, escaped, and reopened. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The Claude Code command that registers this window's server. Claude Code keeps a local-scope server under
 * the directory it was added from, and in a VS Code window it starts in the first workspace folder, so the
 * command changes into that folder first. The removes clear this name and the one earlier versions registered
 * under, so an upgrade or a new port leaves one entry. Without a folder the command runs where it is pasted.
 */
export function claudeRegisterCommand(url: string, token: string, folder?: string): string {
  const register = [
    'claude mcp remove agentic-review 2>/dev/null',
    'claude mcp remove reviewmate 2>/dev/null',
    `claude mcp add --transport http reviewmate ${url} --header "Authorization: Bearer ${token}"`,
  ].join('; ');
  return folder ? `cd ${shellQuote(folder)} && { ${register}; }` : register;
}
