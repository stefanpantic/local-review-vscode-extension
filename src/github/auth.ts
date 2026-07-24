// The single caller of vscode.authentication. Tokens are used transiently to build one Authorization
// header and are NEVER persisted to workspaceState, disk, or logs. VS Code owns the credential store.
import * as vscode from 'vscode';
import type { GithubProviderId } from './remote';

// 'repo' grants access to private repositories and their pull-request review comments. It is exercised
// read-only in iteration 11; the same scope covers write-back in iteration 12, so we request it once.
const SCOPES = ['repo'];

/** How a token is obtained on demand: interactive shows the sign-in prompt, otherwise reuse an existing session. */
export type TokenSource = (interactive: boolean) => Promise<string | undefined>;

/** A token source bound to a provider (github.com or a configured GHE host). */
export function githubTokenSource(providerId: GithubProviderId): TokenSource {
  return async (interactive: boolean) => {
    const options: vscode.AuthenticationGetSessionOptions = interactive ? { createIfNone: true } : { silent: true };
    const session = await vscode.authentication.getSession(providerId, SCOPES, options);
    return session?.accessToken;
  };
}

/** Whether a session already exists for the provider, without prompting — for gating sign-in affordances. */
export async function hasGithubSession(providerId: GithubProviderId): Promise<boolean> {
  const session = await vscode.authentication.getSession(providerId, SCOPES, { silent: true });
  return session != null;
}
