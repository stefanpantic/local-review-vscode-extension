import * as vscode from 'vscode';
import { ReviewState } from './reviewState';
import { ReviewStore } from './comments/ReviewStore';
import type { RepoSession, SubmitPreview } from './repoSession';
import { WorkspaceReviews, repoRootOf } from './workspaceReviews';
import { orphanNote } from './prPoller';
import { FilesView } from './webview/filesView';
import { CommentsView } from './webview/commentsView';
import { ReviewsView } from './webview/reviewsView';
import { ReviewPanel } from './webview/ReviewPanel';
import { hasRelevantChange, listBranches } from './git/git';
import { watchRepoChanges } from './git/watch';
import { startMcpServer, type McpServerHandle } from './mcp/server';
import { exportReviewMarkdown } from './export/exportMarkdown';
import { exportReviewJson } from './export/exportJson';
import type { ExportMeta, ExportOpts } from './export/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { DiffSource } from './model/ReviewDiff';
import type { CommentThread, Review } from './model/Comment';
import { AGENT_AUTHOR } from './model/Comment';
import { parsePrReference, type GithubProviderId } from './github/remote';
import { githubTokenSource } from './github/auth';
import { githubErrorText } from './github/errors';
import type { SubmitEvent, SubmitCounts } from './review/submit';
import { PullRequestsView } from './webview/pullRequestsView';
import type { ReviewProvider, RemoteRepoRef, PullRequestSummary } from './review/provider';
import type { ThreadSet } from './webview/commentsView';
import { formatPrFilter, parsePrFilter } from './review/prFilter';
import { groupPullRequests, groupTotals, type PrSection } from './review/prGroups';
import { reposForRemote } from './review/repoResolve';
import { applyCommentFilter, formatCommentFilter, parseCommentFilter } from './review/commentFilter';
import type { CommentGroupBy, CommentSortBy } from './review/commentGroups';

/** Narrow a command argument (tree node or selection) to a Review. */
function asReview(x: unknown): Review | undefined {
  return x && typeof x === 'object' && 'id' in x && 'threads' in x ? (x as Review) : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const state = new ReviewState(context);
  await state.migrate();
  const reviewStore = new ReviewStore(context.workspaceState);
  const workspace = new WorkspaceReviews(state, reviewStore);
  const filesView = new FilesView(workspace);
  const tree = vscode.window.createTreeView('agenticReview.files', {
    treeDataProvider: filesView,
    showCollapseAll: true,
  });

  const commentsView = new CommentsView(workspace, state);
  const commentsTree = vscode.window.createTreeView('agenticReview.comments', {
    treeDataProvider: commentsView,
    showCollapseAll: true,
  });
  commentsView.bind(commentsTree);

  const reviewsView = new ReviewsView(workspace);
  const reviewsTree = vscode.window.createTreeView('agenticReview.reviews', { treeDataProvider: reviewsView });

  const pullRequestsView = new PullRequestsView(workspace, state);
  const pullRequestsTree = vscode.window.createTreeView('agenticReview.pullRequests', {
    treeDataProvider: pullRequestsView,
  });
  pullRequestsView.bind(pullRequestsTree);

  // Badge the activity-bar icon with the number of changed files still to review across every repository.
  // The count falls as the reviewer marks files viewed and rises when the reviewer unmarks them (like the SCM count).
  const updateBadge = (): void => {
    let n = 0;
    for (const s of workspace.list()) n += s.files().filter((f) => !s.isViewed(f.path)).length;
    tree.badge = n > 0 ? { value: n, tooltip: `${n} file${n === 1 ? '' : 's'} left to review` } : undefined;
  };

  // Name the diff source in the Changes view header (e.g. "Pull request #117") when there is one repository.
  // With several, each repository's section names its own.
  const updateSourceHeader = (): void => {
    tree.description = workspace.sole()?.sourceLabel();
  };

  const showPanel = (session: RepoSession): void => workspace.showPanel(context.extensionUri, session);

  // The repository a PR command acts on: one with a pull request open.
  const pickPrSession = (arg: unknown): Promise<RepoSession | undefined> =>
    workspace.pickSession(arg, {
      eligible: (s) => s.source === 'pr',
      placeHolder: 'Repository with the pull request',
      none: 'open a pull request first.',
    });

  // The session to navigate in: the focused panel's, else the one focused last while it is still open.
  const navigate = (target: 'file' | 'comment', dir: 'next' | 'prev'): void =>
    workspace.session(workspace.focusedRepo())?.navigate(target, dir);

  // --- MCP server lifecycle (binds to 127.0.0.1 only). Runs on launch when agenticReview.mcp.autoStart,
  //     or on demand via Start/Stop; `mcpDesired` is the session's running intent. ---
  let mcpHandle: McpServerHandle | undefined;
  let mcpDesired = vscode.workspace.getConfiguration('agenticReview').get<boolean>('mcp.autoStart', false);
  let mcpOp: Promise<void> = Promise.resolve(); // serializes start/stop so bursts can't race
  const mcpToken = (): string => {
    let t = context.workspaceState.get<string>('agenticReview.mcp.token');
    if (!t) {
      t = randomUUID();
      void context.workspaceState.update('agenticReview.mcp.token', t);
    }
    return t;
  };
  // Make the running server match `mcpDesired`: tear down, then (re)start if wanted (also applies a port change).
  const syncMcp = (): Promise<void> => {
    mcpOp = mcpOp.then(async () => {
      if (mcpHandle) {
        mcpHandle.dispose();
        mcpHandle = undefined;
      }
      if (!mcpDesired) return;
      const cfg = vscode.workspace.getConfiguration('agenticReview');
      const opts = { version: context.extension.packageJSON.version as string, token: mcpToken() };
      const cfgPort = cfg.get<number>('mcp.port', 0);
      // A fixed port wins; otherwise take this workspace's stable slot from the cross-window registry.
      const wantPort = cfgPort > 0 ? cfgPort : assignedPort(context);
      try {
        mcpHandle = await startMcpServer(workspace.mcpWorkspace(), { ...opts, port: wantPort });
      } catch {
        mcpHandle = await startMcpServer(workspace.mcpWorkspace(), { ...opts, port: 0 }); // another process holds the slot, so bind any free port
      }
      if (cfgPort === 0) rememberPort(context, mcpHandle.port);
    });
    return mcpOp;
  };
  const setupMcp = async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('agenticReview');
    const input = await vscode.window.showInputBox({
      title: 'ReviewMate MCP server port',
      prompt: 'Port for the MCP server (0 = pick a free port; it is then reused across restarts)',
      value: String(cfg.get<number>('mcp.port', 0)),
      validateInput: (v) =>
        /^\d+$/.test(v.trim()) && Number(v) <= 65535 ? undefined : 'Enter a port number between 0 and 65535.',
    });
    if (input === undefined) return; // cancelled
    const auto = await vscode.window.showQuickPick(
      [
        { label: 'Autostart on launch', description: 'run the MCP server every time VS Code opens', value: true },
        { label: 'Start manually', description: 'start it with "ReviewMate: Start MCP Server"', value: false },
      ],
      { title: 'ReviewMate MCP autostart', placeHolder: 'Start the MCP server automatically on launch?' },
    );
    if (!auto) return; // cancelled
    await cfg.update('mcp.port', Number(input.trim()), vscode.ConfigurationTarget.Workspace);
    await cfg.update('mcp.autoStart', auto.value, vscode.ConfigurationTarget.Workspace);
    await context.workspaceState.update('agenticReview.mcp.configured', true);
    mcpDesired = true;
    await syncMcp();
    if (!mcpHandle) {
      void vscode.window.showErrorMessage('ReviewMate: could not start the MCP server.');
      return;
    }
    const { url, token } = mcpHandle;
    const jsonUri = await writeMcpArtifacts(context, url, token);
    const choice = await vscode.window.showInformationMessage(
      'ReviewMate MCP server is running.',
      {
        modal: true,
        detail: `URL: ${url}\n\nConnect your MCP client using the mcp.json this opens (or the "Open MCP Config" command anytime). It has the URL, token, and ready-to-run connect commands for Claude Code and other clients.`,
      },
      'Open mcp.json',
      'Copy URL',
    );
    if (choice === 'Open mcp.json' && jsonUri) await vscode.window.showTextDocument(jsonUri);
    else if (choice === 'Copy URL') await vscode.env.clipboard.writeText(url);
  };
  // Start on demand. First time (never configured) runs setup so the user gets the connect details.
  const startMcp = async (): Promise<void> => {
    if (!context.workspaceState.get<boolean>('agenticReview.mcp.configured')) {
      await setupMcp();
      return;
    }
    mcpDesired = true;
    await syncMcp();
    if (!mcpHandle) return;
    const jsonUri = await writeMcpArtifacts(context, mcpHandle.url, mcpHandle.token);
    const choice = await vscode.window.showInformationMessage(
      `ReviewMate MCP server is running at ${mcpHandle.url}.`,
      'Open mcp.json',
    );
    if (choice === 'Open mcp.json' && jsonUri) await vscode.window.showTextDocument(jsonUri);
  };
  const stopMcp = async (): Promise<void> => {
    mcpDesired = false;
    await syncMcp();
    void vscode.window.showInformationMessage('ReviewMate MCP server stopped.');
  };
  // Open the connect file (regenerating it with the live url + token). Starts the server first if needed.
  const openMcpConfig = async (): Promise<void> => {
    if (!mcpHandle) {
      const choice = await vscode.window.showInformationMessage(
        'The ReviewMate MCP server is not running.',
        'Start MCP Server',
      );
      if (choice === 'Start MCP Server') await startMcp();
      return;
    }
    const jsonUri = await writeMcpArtifacts(context, mcpHandle.url, mcpHandle.token);
    if (jsonUri) await vscode.window.showTextDocument(jsonUri);
    else void vscode.window.showErrorMessage('ReviewMate: no workspace storage available to write the MCP config.');
  };

  tree.onDidChangeCheckboxState(
    (e) => {
      for (const [node, cbState] of e.items) {
        if (node.kind === 'tree' && node.node.kind === 'file') {
          const checked = cbState === vscode.TreeItemCheckboxState.Checked;
          void workspace.session(node.repoRoot)?.setViewed(node.node.file.path, checked);
        }
      }
    },
    null,
    context.subscriptions,
  );

  context.subscriptions.push(
    tree,
    commentsTree,
    reviewsTree,
    pullRequestsTree,
    workspace,
    workspace.onDidChange(updateBadge),
    workspace.onDidChange(updateSourceHeader),
    vscode.commands.registerCommand('agenticReview.newReview', async (arg?: unknown) => {
      const session = await workspace.pickSession(arg, { placeHolder: 'Repository to start a review in' });
      if (session) await newReview(session);
    }),
    vscode.commands.registerCommand('agenticReview.switchReview', (r) => {
      const rev = asReview(r);
      if (rev) void workspace.session(rev.repoRoot)?.switchReview(rev.id);
    }),
    vscode.commands.registerCommand('agenticReview.renameReview', (r) => {
      const rev = asReview(r) ?? asReview(reviewsTree.selection[0]);
      return renameReview(workspace.session(rev?.repoRoot), rev);
    }),
    vscode.commands.registerCommand('agenticReview.deleteReview', (r) => {
      const rev = asReview(r) ?? asReview(reviewsTree.selection[0]);
      return deleteReview(workspace.session(rev?.repoRoot), rev);
    }),
    vscode.commands.registerCommand('agenticReview.moveReviewToCurrentBranch', (r) => {
      const rev = asReview(r) ?? asReview(reviewsTree.selection[0]);
      if (rev) void workspace.session(rev.repoRoot)?.moveReviewToCurrentBranch(rev.id);
    }),
    vscode.commands.registerCommand('agenticReview.exportReview', async (arg?: unknown) => {
      const review = asReview(arg);
      const session = review
        ? workspace.session(review.repoRoot)
        : await workspace.pickSession(arg, { placeHolder: 'Repository to export a review from' });
      if (session) await exportReview(session, review);
    }),
    vscode.commands.registerCommand('agenticReview.nextChange', () => navigate('file', 'next')),
    vscode.commands.registerCommand('agenticReview.prevChange', () => navigate('file', 'prev')),
    vscode.commands.registerCommand('agenticReview.nextComment', () => navigate('comment', 'next')),
    vscode.commands.registerCommand('agenticReview.prevComment', () => navigate('comment', 'prev')),
    // A PR diff is pinned to fetched refs, so working-tree / git-state changes (including our own fetch)
    // must not re-diff it — that would reset the "loading" state mid-review. Local sources still live-refresh.
    watchRepoChanges(
      (repos) => {
        const touched = repos === 'all' ? workspace.list() : [...repos].map((r) => workspace.session(r));
        for (const s of touched) if (s && s.source !== 'pr') void s.refresh();
      },
      {
        route: (fsPath) => workspace.routePath(fsPath),
        // Ignored paths (build output, logs) cannot change the diff, so a build must not refresh the review.
        // The PR test only avoids asking git a question whose answer is already moot — the guard above is
        // what actually holds in PR mode, because pathless git events never reach this filter.
        relevant: async (repoRoot, paths) =>
          workspace.session(repoRoot)?.source !== 'pr' && (await hasRelevantChange(repoRoot, paths)),
        onRepositoriesChanged: () => workspace.rediscover(),
      },
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => workspace.rediscover()),
    vscode.commands.registerCommand('agenticReview.startReview', async (arg?: unknown) => {
      const session = await workspace.pickSession(arg, {
        placeHolder: 'Repository to review',
        none: 'no Git repository in this workspace.',
      });
      if (!session) return;
      await session.refresh();
      showPanel(session);
    }),
    // With an item, refresh that repository. Without one, refresh every repository. In PR mode Refresh is a
    // full sync: it re-fetches the head and re-imports threads, which picks up upstream deletions. For local
    // sources it re-diffs.
    vscode.commands.registerCommand('agenticReview.refresh', async (arg?: unknown) => {
      const one = workspace.session(repoRootOf(arg));
      await Promise.all((one ? [one] : workspace.list()).map(refreshSession));
    }),
    // The review panel's own Refresh button acts on the panel's repository.
    vscode.commands.registerCommand('agenticReview.refreshPanel', async () => {
      const session = workspace.session(ReviewPanel.activeRepo());
      if (session) await refreshSession(session);
    }),
    vscode.commands.registerCommand(
      'agenticReview.revealFile',
      async (filePath?: string, threadId?: string, repoRoot?: string) => {
        const session = repoRoot
          ? workspace.session(repoRoot)
          : await workspace.pickSession(undefined, { placeHolder: 'Repository to reveal the file in' });
        if (!session) return;
        showPanel(session); // create or reveal (focuses the tab)
        if (typeof filePath === 'string') session.reveal(filePath, threadId);
      },
    ),
    vscode.commands.registerCommand('agenticReview.selectSource', async (arg?: unknown) => {
      const session = await workspace.pickSession(arg, { placeHolder: 'Repository to change the diff source of' });
      if (session) await pickSource(session);
    }),
    vscode.commands.registerCommand('agenticReview.reviewPullRequest', (arg?: unknown) =>
      reviewPullRequest(workspace, arg, showPanel),
    ),
    vscode.commands.registerCommand('agenticReview.refreshPullRequests', (arg?: unknown) =>
      pullRequestsView.refresh(repoRootOf(arg)),
    ),
    // Two commands, one handler: the title bar shows a filled funnel once a filter is on, and either icon
    // opens the box. Clearing is a row inside the box, so the visible affordance never destroys state.
    vscode.commands.registerCommand('agenticReview.filterPullRequests', () =>
      filterPullRequests(pullRequestsView, workspace.multiRepo),
    ),
    vscode.commands.registerCommand('agenticReview.changePullRequestFilter', () =>
      filterPullRequests(pullRequestsView, workspace.multiRepo),
    ),
    vscode.commands.registerCommand('agenticReview.clearPullRequestFilter', () => pullRequestsView.setFilter('')),
    // Same two-commands-one-handler shape as the pull request filter above, for the Current Review list.
    vscode.commands.registerCommand('agenticReview.filterComments', () => filterComments(commentsView)),
    vscode.commands.registerCommand('agenticReview.changeCommentFilter', () => filterComments(commentsView)),
    vscode.commands.registerCommand('agenticReview.clearCommentFilter', () => commentsView.setFilter('')),
    vscode.commands.registerCommand('agenticReview.groupComments', () => groupComments(commentsView)),
    vscode.commands.registerCommand('agenticReview.sortComments', () => sortComments(commentsView)),
    vscode.commands.registerCommand('agenticReview.openPullRequestFromList', async (repoRoot: string, n: number) => {
      const session = workspace.session(repoRoot);
      const remote = await session?.currentRemote();
      if (session && remote) await openPr(session, remote.provider, remote.repo, n, showPanel);
    }),
    vscode.commands.registerCommand('agenticReview.github.submitReview', async (arg?: unknown) => {
      const session = await pickPrSession(arg);
      if (session) await submitPullRequest(session);
    }),
    vscode.commands.registerCommand('agenticReview.github.refreshPullRequest', async (arg?: unknown) => {
      const session = await pickPrSession(arg);
      if (session) await refreshOpenPullRequest(session);
    }),
    vscode.commands.registerCommand('agenticReview.github.syncPullRequest', async (arg?: unknown) => {
      const session = await pickPrSession(arg);
      if (session) await syncOpenPullRequest(session);
    }),
    vscode.commands.registerCommand('agenticReview.github.discardPending', async (arg?: unknown) => {
      const session = await pickPrSession(arg);
      if (session) await discardPendingReview(session);
    }),
    vscode.commands.registerCommand('agenticReview.toggleViewMode', () =>
      workspace.setViewPref({ viewMode: state.view().viewMode === 'split' ? 'unified' : 'split' }),
    ),
    vscode.commands.registerCommand('agenticReview.toggleWhitespace', () =>
      workspace.setViewPref({ whitespace: !state.view().whitespace }),
    ),
    vscode.commands.registerCommand('agenticReview.toggleWrap', () =>
      workspace.setViewPref({ wrap: !state.view().wrap }),
    ),
    vscode.commands.registerCommand('agenticReview.setupMcp', () => setupMcp()),
    vscode.commands.registerCommand('agenticReview.startMcp', () => startMcp()),
    vscode.commands.registerCommand('agenticReview.stopMcp', () => stopMcp()),
    vscode.commands.registerCommand('agenticReview.openMcpConfig', () => openMcpConfig()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agenticReview.mcp.port')) void syncMcp(); // a port change restarts a running server
      // Re-arm on a new interval. A failure run is not cleared here: changing a setting says nothing about
      // whether the remote is reachable again, and that run is also what drives the paused indicator.
      if (e.affectsConfiguration('agenticReview.github.pollInterval')) {
        for (const s of workspace.list()) s.rearmPoll();
      }
      if (e.affectsConfiguration('agenticReview')) void workspace.refreshAll();
    }),
    new vscode.Disposable(() => mcpHandle?.dispose()),
  );

  await workspace.discover();
  updateSourceHeader();
  void syncMcp();
}

export function deactivate(): void {
  // context.subscriptions handles cleanup
}

/**
 * Write the client-agnostic connect file to the extension's per-workspace storage (outside the repo); returns its Uri.
 * It's a standard MCP server, so connect commands for common clients live as comments and the connection
 * details are the JSON body. Nothing parses this file — it's a reference the user opens.
 */
async function writeMcpArtifacts(
  context: vscode.ExtensionContext,
  url: string,
  token: string,
): Promise<vscode.Uri | undefined> {
  const dir = context.storageUri;
  if (!dir) return undefined; // no workspace storage (no folder open)
  await fs.mkdir(dir.fsPath, { recursive: true });

  const content = `// ReviewMate MCP server. A standard, local (127.0.0.1), token-guarded MCP server over Streamable HTTP.
// Connect any MCP client with the url + token below. Ready-to-use options:
//
// Claude Code (CLI). The first remove clears the old name this server used to register under, so an
// upgrade does not leave two entries pointing at the same port:
//   claude mcp remove agentic-review 2>/dev/null; claude mcp remove reviewmate 2>/dev/null; claude mcp add --transport http reviewmate ${url} --header "Authorization: Bearer ${token}"
//
// mcpServers config for Claude Desktop, Cursor, Windsurf, VS Code, and other clients. Add under "mcpServers"
// (and drop any earlier "agentic-review" entry):
//   "reviewmate": {
//     "type": "http",
//     "url": "${url}",
//     "headers": { "Authorization": "Bearer ${token}" }
//   }
//
// Regenerated by "Set up MCP", "Start MCP Server", or "Open MCP Config". The port + token persist across restarts.
${JSON.stringify({ url, token, transport: 'http' }, null, 2)}
`;
  const jsonUri = vscode.Uri.joinPath(dir, 'mcp.json');
  await fs.writeFile(jsonUri.fsPath, content, 'utf8');
  return jsonUri;
}

// MCP ports come from a registry in globalState (shared across every window), so each workspace keeps a
// stable, unique port: register the server in your agent once and its URL survives restarts and never
// collides with another window. The range sits above common dev-server ports to reduce external clashes.
const PORT_REGISTRY_KEY = 'agenticReview.mcp.ports';
const PORT_BASE = 39217;
const PORT_SPAN = 20000;

/**
 * What identifies this workspace in the port registry: VS Code's per-workspace storage folder, which stays the
 * same when folders are added, removed, or reordered. VS Code omits it only when no folder is open, and then
 * there is no repository to serve.
 */
function mcpWorkspaceKey(context: vscode.ExtensionContext): string {
  return context.storageUri?.fsPath ?? 'default';
}
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/**
 * This workspace's assigned port, taken once and kept in the cross-window registry so every workspace gets
 * a distinct, stable port. Seeded from a hash of the path, then bumped to the first slot no other workspace
 * has claimed. Returns the same port on every later launch.
 */
function assignedPort(context: vscode.ExtensionContext): number {
  const key = mcpWorkspaceKey(context);
  const map = { ...(context.globalState.get<Record<string, number>>(PORT_REGISTRY_KEY) ?? {}) };
  if (map[key]) return map[key];
  const used = new Set(Object.values(map));
  let port = PORT_BASE + (hashString(key) % PORT_SPAN);
  while (used.has(port)) port = PORT_BASE + ((port - PORT_BASE + 1) % PORT_SPAN);
  map[key] = port;
  void context.globalState.update(PORT_REGISTRY_KEY, map);
  return port;
}
/** Record the actually-bound port; it differs from the assignment only if that slot was externally taken. */
function rememberPort(context: vscode.ExtensionContext, port: number): void {
  const key = mcpWorkspaceKey(context);
  const map = { ...(context.globalState.get<Record<string, number>>(PORT_REGISTRY_KEY) ?? {}) };
  if (map[key] !== port) {
    map[key] = port;
    void context.globalState.update(PORT_REGISTRY_KEY, map);
  }
}

const SOURCES: { label: string; icon: string; description: string; source: DiffSource }[] = [
  {
    label: 'Uncommitted changes',
    icon: 'git-commit',
    description: 'everything not yet committed',
    source: 'worktree-vs-head',
  },
  { label: 'Unstaged changes', icon: 'diff-modified', description: 'not yet staged', source: 'unstaged' },
  { label: 'Staged changes', icon: 'diff-added', description: 'staged for commit', source: 'staged' },
  {
    label: 'Compare with a branch',
    icon: 'git-compare',
    description: 'diff against another branch',
    source: 'vs-base',
  },
];

async function pickSource(session: RepoSession): Promise<void> {
  const current = session.source;
  const pr = {
    label: '$(git-pull-request) Review a GitHub pull request',
    description: 'fetch a PR and review it here',
    source: 'open-pr' as const,
  };
  const picked = await vscode.window.showQuickPick(
    [
      ...SOURCES.map((s) => ({
        label: `$(${s.icon}) ${s.label}`,
        description: s.source === current ? `${s.description} · current` : s.description,
        source: s.source as DiffSource | 'open-pr',
      })),
      pr,
    ],
    { placeHolder: 'Select the diff source to review' },
  );
  if (!picked) return;
  if (picked.source === 'open-pr') {
    await vscode.commands.executeCommand('agenticReview.reviewPullRequest', { repoRoot: session.repoRoot });
  } else if (picked.source === 'vs-base') {
    const branches = await listBranches(session.repoRoot);
    if (branches.length === 0) {
      void vscode.window.showWarningMessage('ReviewMate: no local branches to compare against.');
      return;
    }
    const base = await vscode.window.showQuickPick(branches, { placeHolder: 'Select the base branch' });
    if (!base) return;
    await session.setSource('vs-base', base);
  } else {
    await session.setSource(picked.source);
  }
}

/**
 * Pick the repository, sign in via VS Code if needed, let the user pick an open PR (or type a URL/number), then
 * fetch and open it. A pasted URL names its repository, so it opens in the workspace repository on that remote,
 * whichever one the command started from. The command shows errors as messages and skips an unsupported host.
 */
async function reviewPullRequest(
  workspace: WorkspaceReviews,
  arg: unknown,
  show: (session: RepoSession) => void,
): Promise<void> {
  const session = await workspace.pickSession(arg, {
    eligible: async (s) => (await s.currentRemote()) !== undefined,
    placeHolder: 'Repository to review a pull request in',
  });
  if (!session) return; // the picker was dismissed
  const remote = await session.currentRemote();
  if (!remote) {
    void vscode.window.showWarningMessage(
      'ReviewMate: this repo\'s origin isn\'t a supported review host. Use github.com, or set "agenticReview.github.enterpriseUri" for GitHub Enterprise.',
    );
    return;
  }
  // Sign in once (interactive); later reads reuse the session silently.
  const token = await githubTokenSource(remote.provider.id as GithubProviderId)(true);
  if (!token) {
    void vscode.window.showInformationMessage('ReviewMate: sign in to GitHub to review a pull request.');
    return;
  }
  const picked = await pickPullRequest(remote.provider, remote.repo);
  if (!picked) return;
  const target = picked.repo ? await sessionForRemote(workspace, session, remote.repo, picked.repo) : session;
  if (!target) return;
  const targetRemote = target === session ? remote : await target.currentRemote();
  if (targetRemote) await openPr(target, targetRemote.provider, targetRemote.repo, picked.number, show);
}

/**
 * The session a pasted pull request URL belongs in. The one the command started from when it is on that
 * remote, else the workspace repository on it, asking when several checkouts share it. When no open
 * repository is on that remote, the function tells the user and returns undefined.
 */
async function sessionForRemote(
  workspace: WorkspaceReviews,
  from: RepoSession,
  fromRemote: RemoteRepoRef,
  ref: { host: string; owner: string; repo: string },
): Promise<RepoSession | undefined> {
  const same = (a: { host: string; owner: string; repo: string }): boolean =>
    reposForRemote([{ remote: a }], ref).length > 0;
  if (same(fromRemote)) return from;
  const candidates = await Promise.all(
    workspace.list().map(async (s) => ({ session: s, remote: (await s.currentRemote())?.repo })),
  );
  const matches = reposForRemote(candidates, ref);
  if (matches.length === 1) return matches[0].session;
  if (matches.length > 1) {
    const picked = await vscode.window.showQuickPick(
      matches.map((m) => ({ label: m.session.repoName(), description: m.session.repoRoot, session: m.session })),
      { placeHolder: `Checkout of ${ref.owner}/${ref.repo} to review in` },
    );
    return picked?.session;
  }
  void vscode.window.showWarningMessage(
    `ReviewMate: that pull request belongs to ${ref.owner}/${ref.repo}, which isn't open in this workspace.`,
  );
  return undefined;
}

/** Fetch + open a PR with progress, then reveal the panel; surface any failure as a clear message. */
async function openPr(
  session: RepoSession,
  provider: ReviewProvider,
  repo: RemoteRepoRef,
  number: number,
  show: (session: RepoSession) => void,
): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading pull request #${number}…` },
      () => session.openPullRequest({ provider, repo, number, remote: 'origin' }),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not open PR #${number}. ${errorText(err)}`);
    return;
  }
  show(session);
}

/**
 * Submit the open PR's staged change set: pick the review event, confirm the counts, then post it as one
 * review and reconcile. All UI (picker, confirmation, result) lives here; errors surface as messages.
 */
async function submitPullRequest(session: RepoSession): Promise<void> {
  const preview = session.submitPreview();
  if (!preview) {
    void vscode.window.showInformationMessage('ReviewMate: open a pull request to submit a review.');
    return;
  }
  if (preview.counts.total === 0) {
    void vscode.window.showInformationMessage(
      'ReviewMate: nothing to submit yet. Add a comment, reply, resolve, or edit first.',
    );
    return;
  }
  const event = await pickReviewEvent(preview);
  if (!event) return;
  const body = await askReviewSummary();
  if (body === undefined) return; // dismissed the summary box: treat as cancelling the whole submit
  if (!(await confirmSubmit(preview, event))) return;
  try {
    const { counts, orphans } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Submitting review to GitHub…' },
      () => session.submitPullRequest(event, body),
    );
    const note = orphanNote(orphans);
    void vscode.window.showInformationMessage(`ReviewMate: submitted ${summarizeCounts(counts)}.${note}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not submit the review. ${errorText(err)}`);
  }
}

/**
 * Choose the GitHub review event for a Submit. GitHub rejects Approve and Request changes on a closed or
 * merged pull request, and on one you authored yourself, so those are omitted with a note explaining why
 * rather than failing with a 422 after the fact.
 */
async function pickReviewEvent(preview: SubmitPreview): Promise<SubmitEvent | undefined> {
  const closed = preview.state === 'closed' || preview.state === 'merged';
  const commentOnly = closed || preview.ownPr;
  const items: (vscode.QuickPickItem & { event: SubmitEvent })[] = [
    { label: 'Comment', description: 'Submit comments without explicit approval', event: 'comment' },
  ];
  if (!commentOnly) {
    items.push(
      { label: 'Approve', description: 'Approve the pull request', event: 'approve' },
      { label: 'Request changes', description: 'Submit feedback that must be addressed', event: 'request-changes' },
    );
  }
  const placeHolder = closed
    ? `This pull request is ${preview.state}; only Comment can be submitted`
    : preview.ownPr
      ? 'You opened this pull request, so only Comment can be submitted'
      : 'Choose the review event to submit';
  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  return picked?.event;
}

/**
 * The optional review summary, GitHub's "Finish your review" box. Returns the text (empty when skipped), or
 * undefined when the box is dismissed, which cancels the submit.
 */
async function askReviewSummary(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Review summary (optional)',
    prompt: 'Posted as the body of the review. Leave empty to submit the comments on their own.',
    placeHolder: 'Summarize your review…',
  });
}

/**
 * Start a review. On a pull request this forks a second pass over the same request, which is rarely what
 * someone reaching for a generic "new review" button intends, so there it is confirmed and spelled out.
 * Everything else in the PR flow continues the review you already have.
 */
async function newReview(session: RepoSession): Promise<void> {
  const onPr = session.source === 'pr';
  if (onPr) {
    const start = 'Start a second review';
    const choice = await vscode.window.showWarningMessage(
      'Start a second review of this pull request?',
      {
        modal: true,
        detail:
          "The review you are on now is kept and stays where it is. A new one starts alongside it, with this pull request's comments imported fresh from GitHub. Cancel to carry on with the review you already have.",
      },
      start,
    );
    if (choice !== start) return;
  }
  try {
    if (!onPr) return await session.newReview();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting a second review…' },
      () => session.newReview(),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not start the review. ${errorText(err)}`);
  }
}

/** Refresh one repository: a full sync for an open pull request, a re-diff for a local source. */
function refreshSession(session: RepoSession): Promise<void> {
  return session.source === 'pr' ? refreshOpenPullRequest(session) : session.refresh();
}

/** Apply the "new commits" banner: re-fetch the open PR's advanced head, re-diff, and re-import in place. */
async function refreshOpenPullRequest(session: RepoSession): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Refreshing pull request…' },
      () => session.reloadPullRequest(),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not refresh the pull request. ${errorText(err)}`);
  }
}

/** Pull the latest upstream comments on demand. Unlike the poll, this is where an upstream deletion lands. */
async function syncOpenPullRequest(session: RepoSession): Promise<void> {
  try {
    const orphans = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Syncing pull request comments…' },
      () => session.syncPullRequest(),
    );
    void vscode.window.showInformationMessage(`ReviewMate: comments are up to date.${orphanNote(orphans)}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not sync the pull request. ${errorText(err)}`);
  }
}

/**
 * Throw away everything staged on the open PR and take current upstream as it stands. Confirmed modally and
 * spelled out, because drafts, edits, resolve toggles, and queued deletes all go and none of it comes back.
 */
async function discardPendingReview(session: RepoSession): Promise<void> {
  const preview = session.submitPreview();
  if (!preview) {
    void vscode.window.showInformationMessage('ReviewMate: open a pull request first.');
    return;
  }
  if (preview.counts.total === 0) {
    void vscode.window.showInformationMessage('ReviewMate: nothing is staged, so there is nothing to discard.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    'Discard pending review changes?',
    {
      modal: true,
      detail: `${summarizeCounts(preview.counts)} will be thrown away and the review reset to what is on GitHub now. This cannot be undone.`,
    },
    'Discard',
  );
  if (choice !== 'Discard') return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Discarding pending changes…' },
      () => session.discardPendingReview(),
    );
    void vscode.window.showInformationMessage('ReviewMate: pending review changes discarded.');
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not discard the pending changes. ${errorText(err)}`);
  }
}

/** Modal confirmation showing what the Submit will post, including how many comments are AI-authored. */
async function confirmSubmit(preview: SubmitPreview, event: SubmitEvent): Promise<boolean> {
  const { counts } = preview;
  const eventLabel = event === 'approve' ? 'Approve' : event === 'request-changes' ? 'Request changes' : 'Comment';
  const lines = [`${summarizeCounts(counts)} will be posted to GitHub as "${eventLabel}".`];
  if (counts.agentComments > 0) {
    const n = counts.agentComments;
    lines.push(
      `${n} of them ${n === 1 ? 'was' : 'were'} written by the AI Agent and will be posted under your account.`,
    );
  }
  if (preview.headStale) {
    lines.push(
      'This pull request has new commits. Your comments attach to the commit you reviewed, so GitHub will show them as outdated. Refresh first to review the new head.',
    );
  }
  const choice = await vscode.window.showWarningMessage(
    'Submit this review to GitHub?',
    { modal: true, detail: lines.join('\n\n') },
    'Submit',
  );
  return choice === 'Submit';
}

/** A human-readable tally of a submit's counts, e.g. "2 comments, 1 reply, 1 resolution". */
function summarizeCounts(c: SubmitCounts): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(c.newComments, 'comment', 'comments');
  add(c.replies, 'reply', 'replies');
  add(c.edits, 'edit', 'edits');
  add(c.deletes, 'deletion', 'deletions');
  add(c.resolves, 'resolution', 'resolutions');
  add(c.reactions, 'reaction', 'reactions');
  return parts.length ? parts.join(', ') : 'no changes';
}

/**
 * A QuickPick of open PRs that also accepts a typed number or full PR URL. A URL also names its repository,
 * which is returned so the caller can open it in the right one.
 */
async function pickPullRequest(
  provider: ReviewProvider,
  repo: RemoteRepoRef,
): Promise<{ number: number; repo?: { host: string; owner: string; repo: string } } | undefined> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { number?: number }>();
  qp.title = 'Review a pull request';
  qp.placeholder = 'Pick an open pull request, or type a number or URL';
  qp.busy = true;
  qp.show();

  let open: (vscode.QuickPickItem & { number?: number })[] = [];
  const render = (): void => {
    const typed = parsePrReference(qp.value);
    const head =
      typed != null ? [{ label: `$(arrow-right) Open #${typed.number}`, alwaysShow: true, number: typed.number }] : [];
    qp.items = [...head, ...open];
  };
  qp.onDidChangeValue(render);

  provider
    .listRequests(repo)
    .then((prs) => {
      open = prs.map((p) => ({
        label: `#${p.number} ${p.title}`,
        description: `${p.author} · ${p.state}${p.isDraft ? ' · draft' : ''}`,
        number: p.number,
      }));
      render();
    })
    .catch(() => {
      /* listing may fail (permissions); the user can still type a number or URL */
    })
    .finally(() => {
      qp.busy = false;
    });

  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      const typed = parsePrReference(qp.value);
      const chosen = qp.selectedItems[0]?.number;
      if (chosen != null && chosen !== typed?.number) resolve({ number: chosen });
      else if (typed) resolve({ number: typed.number, repo: typed.repo });
      else resolve(undefined);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
  });
}

/** Open the filter box for the Pull Requests list, then apply whatever it returns. */
async function filterPullRequests(view: PullRequestsView, multiRepo: boolean): Promise<void> {
  const tokens = await pickPrFilter(formatPrFilter(view.filter()), await view.sections(), multiRepo);
  if (tokens !== undefined) await view.setFilter(tokens);
}

type FilterItem = vscode.QuickPickItem & { tokens?: string };

/**
 * The filter box: presets for the common questions, the authors actually present in the list, and free-text
 * tokens. It filters as you type and reports how many pull requests the typed filter would leave, so the
 * effect is visible before you commit to it. Runs against the already-fetched lists, each counted
 * with the identity its own host resolves `@me` to. With several repositories it offers each one as well.
 */
function pickPrFilter(current: string, sections: PrSection[], multiRepo: boolean): Promise<string | undefined> {
  const qp = vscode.window.createQuickPick<FilterItem>();
  qp.title = 'Filter pull requests';
  qp.placeholder = multiRepo
    ? 'repo:<name> · author:@me · review-requested:@me · is:draft · or any text'
    : 'author:@me · review-requested:@me · is:draft · is:ready · or any text';
  qp.value = current;
  qp.matchOnDescription = true;

  const prs = sections.flatMap((sec) => sec.prs);
  const matches = (tokens: string): string => {
    const { shown, total } = groupTotals(groupPullRequests(sections, parsePrFilter(tokens)));
    return `${shown} of ${total}`;
  };
  // Without a signed-in login there is nothing for `@me` to mean, so say that instead of reporting zero.
  const signedIn = sections.some((sec) => sec.viewer.login);
  const meNote = (tokens: string): string => (signedIn ? matches(tokens) : 'sign in to use');
  const myTeams = sections.flatMap((sec) => sec.viewer.teams ?? []);

  // The box is also where a filter gets cleared, so the title-bar funnel can stay non-destructive.
  const clearRow: FilterItem = current
    ? { label: 'Clear filter', description: `show all ${prs.length} open pull requests`, tokens: '' }
    : { label: 'All open', description: `no filter · ${prs.length}`, tokens: '' };

  const presets: FilterItem[] = [
    clearRow,
    {
      label: 'Review requested',
      description: `review-requested:@me · you or your teams · ${meNote('review-requested:@me')}`,
      tokens: 'review-requested:@me',
    },
    {
      label: 'Review requested from me directly',
      description: `user-review-requested:@me · not via a team · ${meNote('user-review-requested:@me')}`,
      tokens: 'user-review-requested:@me',
    },
    { label: 'Created by me', description: `author:@me · ${meNote('author:@me')}`, tokens: 'author:@me' },
    { label: 'Drafts only', description: `is:draft · ${matches('is:draft')}`, tokens: 'is:draft' },
    { label: 'Ready for review', description: `is:ready · ${matches('is:ready')}`, tokens: 'is:ready' },
  ].map((p) => ({ ...p, alwaysShow: true }));

  // Tally a facet across the list, most-used first, so each row can show how much it would leave.
  const tally = (pick: (pr: PullRequestSummary) => string[]): [string, number][] => {
    const counted = new Map<string, number>();
    for (const pr of prs) for (const key of pick(pr)) counted.set(key, (counted.get(key) ?? 0) + 1);
    return [...counted.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };

  const authors: FilterItem[] = tally((pr) => [pr.author]).map(([login, n]) => ({
    label: login,
    description: `${n}`,
    tokens: `author:${login}`,
  }));

  // Teams that some pull request in the list is waiting on. Picking one works whether or not membership
  // could be resolved, so this is also the way through when the teams lookup is unavailable.
  const teams: FilterItem[] = tally((pr) => pr.reviewerTeams ?? []).map(([slug, n]) => ({
    label: slug,
    description: myTeams.some((t) => t.toLowerCase() === slug.toLowerCase()) ? `${n} · your team` : `${n}`,
    tokens: `team-review-requested:${slug}`,
  }));

  const repos: FilterItem[] = multiRepo
    ? sections.map((sec) => ({
        label: sec.repo.name,
        description: `${sec.prs.length}${sec.repo.owner ? ` · ${sec.repo.owner}/${sec.repo.repo}` : ''}`,
        tokens: `repo:${sec.repo.name}`,
      }))
    : [];

  const render = (): void => {
    // Whatever is typed leads the list, so Enter always applies what the box shows. Without this, opening
    // the box on an existing filter and accepting it would pick the first preset and clear that filter.
    const typed = qp.value.trim();
    const head: FilterItem[] = typed
      ? [{ label: `Filter by "${typed}"`, description: matches(typed), tokens: typed, alwaysShow: true }]
      : [];
    const section = (title: string, rows: FilterItem[]): FilterItem[] =>
      rows.length ? [{ label: title, kind: vscode.QuickPickItemKind.Separator }, ...rows] : [];
    qp.items = [
      ...head,
      ...section('Presets', presets),
      ...section('Repositories', repos),
      ...section('Teams awaiting review', teams),
      ...section('Authors in this list', authors),
    ];
  };
  render();
  qp.onDidChangeValue(render);
  qp.show();

  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      resolve(picked?.tokens ?? qp.value.trim());
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
  });
}

/** Open the filter box for the Current Review list, then apply whatever it returns. */
async function filterComments(view: CommentsView): Promise<void> {
  const tokens = await pickCommentFilter(formatCommentFilter(view.filter()), view.threadSets());
  if (tokens !== undefined) await view.setFilter(tokens);
}

/**
 * The comment filter box: presets for the states a thread can be in, the authors actually present in the
 * review, and free-typed tokens. Every row reports how many threads it would leave, so the effect is visible
 * before it is applied. Runs against the threads already loaded, in every repository, each counted
 * with the identity `@me` means there.
 */
function pickCommentFilter(current: string, sets: ThreadSet[]): Promise<string | undefined> {
  const qp = vscode.window.createQuickPick<FilterItem>();
  qp.title = 'Filter comments';
  qp.placeholder = 'is:unresolved · is:outdated · author:@me · author:@agent';
  qp.value = current;
  qp.matchOnDescription = true;

  const threads = sets.flatMap((set) => set.threads);
  const matches = (tokens: string): string => {
    const filter = parseCommentFilter(tokens);
    const shown = sets.reduce((n, set) => n + applyCommentFilter(set.threads, filter, set.viewer).length, 0);
    return `${shown} of ${threads.length}`;
  };
  const viewer = [...new Set(sets.map((set) => set.viewer))].join(', ');

  // The box is also where a filter gets cleared, so the title-bar funnel can stay non-destructive.
  const clearRow: FilterItem = current
    ? { label: 'Clear filter', description: `show all ${threads.length} comments`, tokens: '' }
    : { label: 'All comments', description: `no filter · ${threads.length}`, tokens: '' };

  const presets: FilterItem[] = [
    clearRow,
    { label: 'Unresolved', description: `is:unresolved · ${matches('is:unresolved')}`, tokens: 'is:unresolved' },
    { label: 'Resolved', description: `is:resolved · ${matches('is:resolved')}`, tokens: 'is:resolved' },
    { label: 'Outdated', description: `is:outdated · ${matches('is:outdated')}`, tokens: 'is:outdated' },
    { label: 'Moved', description: `is:moved · ${matches('is:moved')}`, tokens: 'is:moved' },
    { label: 'Mine', description: `author:@me · ${viewer} · ${matches('author:@me')}`, tokens: 'author:@me' },
    { label: AGENT_AUTHOR, description: `author:@agent · ${matches('author:@agent')}`, tokens: 'author:@agent' },
  ].map((p) => ({ ...p, alwaysShow: true }));

  // Everyone who wrote anything in the review, most-prolific first. Counted per thread, not per comment, so
  // the number matches what picking the row would actually leave in the list.
  const counted = new Map<string, number>();
  for (const t of threads) {
    for (const name of new Set(t.comments.map((c) => c.author).filter(Boolean))) {
      counted.set(name, (counted.get(name) ?? 0) + 1);
    }
  }
  const authors: FilterItem[] = [...counted.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => ({ label: name, description: `${n}`, tokens: `author:${name}` }));

  const render = (): void => {
    // Whatever is typed leads the list, so Enter always applies what the box shows.
    const typed = qp.value.trim();
    const head: FilterItem[] = typed
      ? [{ label: `Filter by "${typed}"`, description: matches(typed), tokens: typed, alwaysShow: true }]
      : [];
    const section = (title: string, rows: FilterItem[]): FilterItem[] =>
      rows.length ? [{ label: title, kind: vscode.QuickPickItemKind.Separator }, ...rows] : [];
    qp.items = [...head, ...section('Presets', presets), ...section('Authors in this review', authors)];
  };
  render();
  qp.onDidChangeValue(render);
  qp.show();

  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      resolve(picked?.tokens ?? qp.value.trim());
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
  });
}

/** Mark the option currently in force, so the box shows where you are before you change it. */
function currentMark<T>(value: T, current: T): string | undefined {
  return value === current ? 'current' : undefined;
}

async function groupComments(view: CommentsView): Promise<void> {
  const current = view.groupBy();
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'By file', description: currentMark<CommentGroupBy>('file', current), value: 'file' as const },
      { label: 'By author', description: currentMark<CommentGroupBy>('author', current), value: 'author' as const },
      { label: 'Ungrouped', description: currentMark<CommentGroupBy>('none', current), value: 'none' as const },
    ],
    { title: 'Group comments' },
  );
  if (pick) await view.setArrangement({ groupBy: pick.value });
}

async function sortComments(view: CommentsView): Promise<void> {
  const current = view.sortBy();
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'By position',
        description: currentMark<CommentSortBy>('position', current),
        detail: 'File, then line',
        value: 'position' as const,
      },
      { label: 'Newest first', description: currentMark<CommentSortBy>('newest', current), value: 'newest' as const },
      { label: 'Oldest first', description: currentMark<CommentSortBy>('oldest', current), value: 'oldest' as const },
    ],
    { title: 'Sort comments' },
  );
  if (pick) await view.setArrangement({ sortBy: pick.value });
}

function errorText(err: unknown): string {
  return githubErrorText(err) ?? (err instanceof Error ? err.message : String(err));
}

interface ExportFormat {
  label: string;
  description: string;
  language: string; // editor language for "Open in editor"
  ext: string; // save-dialog filter and default file extension
  render: (meta: ExportMeta, threads: CommentThread[], opts: ExportOpts) => string;
}

const EXPORT_FORMATS: ExportFormat[] = [
  {
    label: 'Markdown',
    description: 'For pasting into a coding agent',
    language: 'markdown',
    ext: 'md',
    render: exportReviewMarkdown,
  },
  { label: 'JSON', description: 'For scripts and tools', language: 'json', ext: 'json', render: exportReviewJson },
];

async function exportReview(session: RepoSession, arg?: Review): Promise<void> {
  const review = arg ?? session.reviewToExport();
  if (!review) {
    void vscode.window.showInformationMessage('ReviewMate: no review to export.');
    return;
  }

  const format = await vscode.window.showQuickPick(EXPORT_FORMATS, { placeHolder: 'Export format' });
  if (!format) return;

  const scopePick = await vscode.window.showQuickPick(
    [
      { label: 'All comments', scope: 'all' as const },
      { label: 'Unresolved only', scope: 'unresolved' as const },
      { label: 'One file…', scope: 'file' as const },
    ],
    { placeHolder: 'Export scope' },
  );
  if (!scopePick) return;

  let opts: ExportOpts;
  if (scopePick.scope === 'file') {
    const files = [...new Set(review.threads.map((t) => t.anchor.filePath))].sort();
    if (files.length === 0) {
      void vscode.window.showInformationMessage('ReviewMate: this review has no comments.');
      return;
    }
    const file = await vscode.window.showQuickPick(files, { placeHolder: 'File to export' });
    if (!file) return;
    opts = { scope: 'file', file };
  } else {
    opts = { scope: scopePick.scope };
  }

  let live = false;
  if (session.canExportLive(review)) {
    const modePick = await vscode.window.showQuickPick(
      [
        { label: 'Current positions', description: 'Re-anchored to the working tree (recommended)', live: true },
        { label: 'As reviewed', description: 'Line numbers as captured when commented', live: false },
      ],
      { placeHolder: 'Line references' },
    );
    if (!modePick) return;
    live = modePick.live;
  }

  // The diff can unload while a pick is open, so the controller reports which line references it used.
  const { threads, lineReferences } = session.exportThreads(review, live);
  const meta: ExportMeta = {
    name: review.name,
    branch: review.branch,
    source: sourceLabel(session.source, session.baseRef),
    repoName: session.repoName(),
    generatedAt: new Date().toISOString(),
    lineReferences,
  };
  const text = format.render(meta, threads, opts);
  if (!text) {
    void vscode.window.showInformationMessage('ReviewMate: no comments match that scope.');
    return;
  }

  const target = await vscode.window.showQuickPick(
    [
      { label: 'Copy to clipboard', action: 'clipboard' as const },
      { label: 'Open in editor', action: 'editor' as const },
      { label: 'Save to file…', action: 'file' as const },
    ],
    { placeHolder: 'Export to' },
  );
  if (!target) return;
  await deliverExport(target.action, text, review.name, format, session.repoRoot);
}

function sourceLabel(source: DiffSource, baseRef?: string): string {
  if (source === 'vs-base') return `Compared with ${baseRef ?? 'base branch'}`;
  return SOURCES.find((s) => s.source === source)?.label ?? source;
}

async function deliverExport(
  action: 'clipboard' | 'editor' | 'file',
  text: string,
  name: string,
  format: ExportFormat,
  repoRoot: string,
): Promise<void> {
  if (action === 'clipboard') {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('ReviewMate: export copied to clipboard.');
  } else if (action === 'editor') {
    const doc = await vscode.workspace.openTextDocument({ content: text, language: format.language });
    await vscode.window.showTextDocument(doc);
  } else {
    const safe = name.replace(/[^\w.-]+/g, '-') || 'review';
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Export review',
      filters: { [format.label]: [format.ext] },
      defaultUri: vscode.Uri.joinPath(vscode.Uri.file(repoRoot), `${safe}.${format.ext}`),
    });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }
}

async function renameReview(session: RepoSession | undefined, review?: Review): Promise<void> {
  if (!session || !review) return;
  const name = await vscode.window.showInputBox({ prompt: 'Rename review', value: review.name });
  if (name?.trim()) await session.renameReview(review.id, name.trim());
}

async function deleteReview(session: RepoSession | undefined, review?: Review): Promise<void> {
  if (!session || !review) return;
  const ok = await vscode.window.showWarningMessage(`Delete review "${review.name}"?`, { modal: true }, 'Delete');
  if (ok === 'Delete') await session.deleteReview(review.id);
}
