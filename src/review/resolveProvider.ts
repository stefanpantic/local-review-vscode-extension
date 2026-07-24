// Dispatch a repo host to its review provider. The single place that knows which hosts map to which
// implementation; a future GitLab/Bitbucket provider is added here without touching the controller,
// storage, renderer, or MCP. github.com and the configured GHE host both resolve to the GitHub provider.
import { githubTokenSource } from '../github/auth';
import { createGithubProvider } from '../github/provider';
import { providerIdForHost } from '../github/remote';
import type { RemoteRepoRef, ReviewProvider } from './provider';

/** The provider for a repo's host, or undefined when the host is not a supported review host. */
export function resolveProvider(repo: RemoteRepoRef, enterpriseUri?: string): ReviewProvider | undefined {
  const providerId = providerIdForHost(repo.host, enterpriseUri);
  if (!providerId) return undefined;
  return createGithubProvider({ providerId, enterpriseUri, getToken: githubTokenSource(providerId) });
}
