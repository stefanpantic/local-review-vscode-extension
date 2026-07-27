import * as vscode from 'vscode';
import { ReviewState } from './reviewState';
import { ReviewStore } from './comments/ReviewStore';
import { ReviewController, type SubmitPreview } from './reviewController';
import { FilesView } from './webview/filesView';
import { CommentsView } from './webview/commentsView';
import { ReviewsView } from './webview/reviewsView';
import { ReviewPanel } from './webview/ReviewPanel';
import { listBranches } from './git/git';
import { watchRepoChanges } from './git/watch';
import { startMcpServer, type McpServerHandle } from './mcp/server';
import { exportReviewMarkdown, type ExportMeta } from './export/exportMarkdown';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { DiffSource } from './model/ReviewDiff';
import type { Review } from './model/Comment';
import { parsePrReference, type GithubProviderId } from './github/remote';
import { githubTokenSource } from './github/auth';
import { githubErrorText } from './github/errors';
import type { SubmitEvent, SubmitCounts } from './review/submit';
import type { OrphanReport } from './review/reconcile';
import { PullRequestsView } from './webview/pullRequestsView';
import type { ReviewProvider, RemoteRepoRef } from './review/provider';

/** Narrow a command argument (tree node or selection) to a Review. */
function asReview(x: unknown): Review | undefined {
  return x && typeof x === 'object' && 'id' in x && 'threads' in x ? (x as Review) : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const state = new ReviewState(context);
  const reviewStore = new ReviewStore(context.workspaceState);
  const controller = new ReviewController(state, reviewStore);
  const filesView = new FilesView(controller);
  const tree = vscode.window.createTreeView('agenticReview.files', {
    treeDataProvider: filesView,
    showCollapseAll: true,
  });

  const commentsView = new CommentsView(controller);
  const commentsTree = vscode.window.createTreeView('agenticReview.comments', {
    treeDataProvider: commentsView,
    showCollapseAll: true,
  });

  const reviewsView = new ReviewsView(controller);
  const reviewsTree = vscode.window.createTreeView('agenticReview.reviews', { treeDataProvider: reviewsView });

  const pullRequestsView = new PullRequestsView(controller);
  const pullRequestsTree = vscode.window.createTreeView('agenticReview.pullRequests', {
    treeDataProvider: pullRequestsView,
  });

  // Badge the activity-bar icon with the number of changed files still to review; the count drops as
  // files are marked viewed and rises when unmarked (like the SCM count).
  const updateBadge = (): void => {
    const n = controller.files().filter((f) => !controller.isViewed(f.path)).length;
    tree.badge = n > 0 ? { value: n, tooltip: `${n} file${n === 1 ? '' : 's'} left to review` } : undefined;
  };

  // Name the current source in the Changes view header (e.g. "Pull request #117"); the compare icon in
  // that title bar switches it.
  const updateSourceHeader = (): void => {
    tree.description = controller.repoRoot ? controller.sourceLabel() : undefined;
  };

  // Show the Pull Requests section only when the current repo's origin is a supported review host.
  const updateHasRemote = async (): Promise<void> => {
    const remote = await controller.currentRemote();
    await vscode.commands.executeCommand('setContext', 'agenticReview.hasRemote', remote != null);
  };

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
        mcpHandle = await startMcpServer(controller.mcpApi(), { ...opts, port: wantPort });
      } catch {
        mcpHandle = await startMcpServer(controller.mcpApi(), { ...opts, port: 0 }); // slot taken by another process — take any free one
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
        if (node.kind === 'file') {
          void controller.setViewed(node.file.path, cbState === vscode.TreeItemCheckboxState.Checked);
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
    controller.onDidChange(updateBadge),
    controller.onDidChange(updateSourceHeader),
    controller.onDidChange(() => void updateHasRemote()),
    vscode.commands.registerCommand('agenticReview.newReview', () => controller.newReview()),
    vscode.commands.registerCommand('agenticReview.switchReview', (r) => {
      const rev = asReview(r);
      if (rev) void controller.switchReview(rev.id);
    }),
    vscode.commands.registerCommand('agenticReview.renameReview', (r) =>
      renameReview(controller, asReview(r) ?? asReview(reviewsTree.selection[0])),
    ),
    vscode.commands.registerCommand('agenticReview.deleteReview', (r) =>
      deleteReview(controller, asReview(r) ?? asReview(reviewsTree.selection[0])),
    ),
    vscode.commands.registerCommand('agenticReview.moveReviewToCurrentBranch', (r) => {
      const rev = asReview(r) ?? asReview(reviewsTree.selection[0]);
      if (rev) void controller.moveReviewToCurrentBranch(rev.id);
    }),
    vscode.commands.registerCommand('agenticReview.exportReview', (r) => exportReview(controller, asReview(r))),
    vscode.commands.registerCommand('agenticReview.nextChange', () => controller.navigate('file', 'next')),
    vscode.commands.registerCommand('agenticReview.prevChange', () => controller.navigate('file', 'prev')),
    vscode.commands.registerCommand('agenticReview.nextComment', () => controller.navigate('comment', 'next')),
    vscode.commands.registerCommand('agenticReview.prevComment', () => controller.navigate('comment', 'prev')),
    // A PR diff is pinned to fetched refs, so working-tree / git-state changes (including our own fetch)
    // must not re-diff it — that would reset the "loading" state mid-review. Local sources still live-refresh.
    watchRepoChanges(() => {
      if (controller.source !== 'pr') void controller.refresh();
    }),
    vscode.commands.registerCommand('agenticReview.startReview', async () => {
      await controller.refresh();
      ReviewPanel.show(context.extensionUri, controller);
    }),
    vscode.commands.registerCommand('agenticReview.refresh', () =>
      // In PR mode, Refresh is a full sync: re-fetch the head + re-import threads (this is where an upstream
      // deletion is reflected). For local sources it just re-diffs.
      controller.source === 'pr' ? refreshOpenPullRequest(controller) : controller.refresh(),
    ),
    vscode.commands.registerCommand('agenticReview.revealFile', (filePath?: string, threadId?: string) => {
      ReviewPanel.show(context.extensionUri, controller); // create or reveal (focuses the tab)
      if (typeof filePath === 'string') controller.reveal(filePath, threadId);
    }),
    vscode.commands.registerCommand('agenticReview.selectSource', () => pickSource(controller)),
    vscode.commands.registerCommand('agenticReview.selectRepo', () => pickRepo(controller)),
    vscode.commands.registerCommand('agenticReview.reviewPullRequest', () =>
      reviewPullRequest(controller, context.extensionUri),
    ),
    vscode.commands.registerCommand('agenticReview.refreshPullRequests', () => pullRequestsView.refresh()),
    vscode.commands.registerCommand('agenticReview.openPullRequestFromList', (n: number) =>
      openPullRequestFromList(controller, context.extensionUri, n),
    ),
    vscode.commands.registerCommand('agenticReview.github.submitReview', () => submitPullRequest(controller)),
    vscode.commands.registerCommand('agenticReview.github.refreshPullRequest', () =>
      refreshOpenPullRequest(controller),
    ),
    vscode.commands.registerCommand('agenticReview.github.syncPullRequest', () => syncOpenPullRequest(controller)),
    vscode.commands.registerCommand('agenticReview.github.discardPending', () => discardPendingReview(controller)),
    vscode.commands.registerCommand('agenticReview.toggleViewMode', () =>
      controller.setViewPref({ viewMode: controller.viewMode === 'split' ? 'unified' : 'split' }),
    ),
    vscode.commands.registerCommand('agenticReview.toggleWhitespace', () =>
      controller.setViewPref({ whitespace: !controller.whitespace }),
    ),
    vscode.commands.registerCommand('agenticReview.toggleWrap', () =>
      controller.setViewPref({ wrap: !controller.wrap }),
    ),
    vscode.commands.registerCommand('agenticReview.setupMcp', () => setupMcp()),
    vscode.commands.registerCommand('agenticReview.startMcp', () => startMcp()),
    vscode.commands.registerCommand('agenticReview.stopMcp', () => stopMcp()),
    vscode.commands.registerCommand('agenticReview.openMcpConfig', () => openMcpConfig()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agenticReview.mcp.port')) void syncMcp(); // a port change restarts a running server
      if (e.affectsConfiguration('agenticReview')) void controller.refresh();
    }),
    new vscode.Disposable(() => mcpHandle?.dispose()),
  );

  // Background poll while a PR is open: pick up upstream comment changes live and flag an advanced head.
  // Runs only in PR mode, skips if a tick is still in flight, and is disabled when the interval is 0.
  let polling = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const pollTick = async (): Promise<void> => {
    if (polling || controller.source !== 'pr') return;
    polling = true;
    try {
      const { orphans, incoming } = await controller.pollPullRequest();
      if (orphans)
        void vscode.window.showInformationMessage(`ReviewMate: synced upstream changes.${orphanNote(orphans)}`);
      // A discussion landing while you read is easy to miss, so say so once rather than only badging the panel.
      if (incoming)
        void vscode.window.showInformationMessage(
          `ReviewMate: ${incoming} new comment${incoming === 1 ? '' : 's'} on this pull request.`,
        );
    } catch {
      /* transient (offline, rate limit); the next tick retries */
    } finally {
      polling = false;
    }
  };
  const restartPoll = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    const secs = vscode.workspace.getConfiguration('agenticReview').get<number>('github.pollInterval', 60);
    if (secs > 0) pollTimer = setInterval(() => void pollTick(), secs * 1000);
  };
  restartPoll();
  context.subscriptions.push(
    new vscode.Disposable(() => pollTimer && clearInterval(pollTimer)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agenticReview.github.pollInterval')) restartPoll();
    }),
  );

  await controller.refresh();
  updateSourceHeader();
  void updateHasRemote();
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

function mcpWorkspaceKey(context: vscode.ExtensionContext): string {
  return context.storageUri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
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

async function pickSource(controller: ReviewController): Promise<void> {
  const current = controller.source;
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
    await vscode.commands.executeCommand('agenticReview.reviewPullRequest');
  } else if (picked.source === 'vs-base') {
    const branches = controller.repoRoot ? await listBranches(controller.repoRoot) : [];
    if (branches.length === 0) {
      void vscode.window.showWarningMessage('ReviewMate: no local branches to compare against.');
      return;
    }
    const base = await vscode.window.showQuickPick(branches, { placeHolder: 'Select the base branch' });
    if (!base) return;
    await controller.setSource('vs-base', base);
  } else {
    await controller.setSource(picked.source);
  }
}

/**
 * Detect the repo's review host, sign in via VS Code if needed, let the user pick an open PR (or type a
 * URL/number), then fetch and open it. Errors surface as clear messages; an unsupported host is skipped.
 */
async function reviewPullRequest(controller: ReviewController, extensionUri: vscode.Uri): Promise<void> {
  const remote = await controller.currentRemote();
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
  const number = await pickPullRequest(remote.provider, remote.repo);
  if (number == null) return;
  await openPr(controller, extensionUri, remote.provider, remote.repo, number);
}

/** Open a PR chosen from the Pull Requests sidebar list (already detected + signed in). */
async function openPullRequestFromList(
  controller: ReviewController,
  extensionUri: vscode.Uri,
  number: number,
): Promise<void> {
  const remote = await controller.currentRemote();
  if (remote) await openPr(controller, extensionUri, remote.provider, remote.repo, number);
}

/** Fetch + open a PR with progress, then reveal the panel; surface any failure as a clear message. */
async function openPr(
  controller: ReviewController,
  extensionUri: vscode.Uri,
  provider: ReviewProvider,
  repo: RemoteRepoRef,
  number: number,
): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading pull request #${number}…` },
      () => controller.openPullRequest({ provider, repo, number, remote: 'origin' }),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not open PR #${number}. ${errorText(err)}`);
    return;
  }
  ReviewPanel.show(extensionUri, controller);
}

/**
 * Submit the open PR's staged change set: pick the review event, confirm the counts, then post it as one
 * review and reconcile. All UI (picker, confirmation, result) lives here; errors surface as messages.
 */
async function submitPullRequest(controller: ReviewController): Promise<void> {
  const preview = controller.submitPreview();
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
      () => controller.submitPullRequest(event, body),
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

/** Apply the "new commits" banner: re-fetch the open PR's advanced head, re-diff, and re-import in place. */
async function refreshOpenPullRequest(controller: ReviewController): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Refreshing pull request…' },
      () => controller.reloadPullRequest(),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not refresh the pull request. ${errorText(err)}`);
  }
}

/** Pull the latest upstream comments on demand. Unlike the poll, this is where an upstream deletion lands. */
async function syncOpenPullRequest(controller: ReviewController): Promise<void> {
  try {
    const orphans = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Syncing pull request comments…' },
      () => controller.syncPullRequest(),
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
async function discardPendingReview(controller: ReviewController): Promise<void> {
  const preview = controller.submitPreview();
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
      () => controller.discardPendingReview(),
    );
    void vscode.window.showInformationMessage('ReviewMate: pending review changes discarded.');
  } catch (err) {
    void vscode.window.showErrorMessage(`ReviewMate: could not discard the pending changes. ${errorText(err)}`);
  }
}

/** A trailing sentence describing content whose upstream target vanished during a re-fetch, or empty. */
function orphanNote(o: OrphanReport): string {
  const parts: string[] = [];
  if (o.localOnly > 0)
    parts.push(
      `${o.localOnly} of your comment${o.localOnly === 1 ? ' was' : 's were'} deleted on GitHub and kept here, badged "deleted on GitHub" (Submit reposts, or delete to discard)`,
    );
  if (o.deletes > 0) parts.push(`${o.deletes} staged delete${o.deletes === 1 ? '' : 's'} already gone upstream`);
  return parts.length ? ` (${parts.join('; ')}.)` : '';
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
  return parts.length ? parts.join(', ') : 'no changes';
}

/** A QuickPick of open PRs that also accepts a typed number or full PR URL. */
async function pickPullRequest(provider: ReviewProvider, repo: RemoteRepoRef): Promise<number | undefined> {
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
      const picked = qp.selectedItems[0]?.number ?? parsePrReference(qp.value)?.number;
      resolve(picked);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
  });
}

function errorText(err: unknown): string {
  return githubErrorText(err) ?? (err instanceof Error ? err.message : String(err));
}

async function exportReview(controller: ReviewController, arg?: Review): Promise<void> {
  const review = arg ?? controller.reviewToExport();
  if (!review) {
    void vscode.window.showInformationMessage('ReviewMate: no review to export.');
    return;
  }

  const scopePick = await vscode.window.showQuickPick(
    [
      { label: 'All comments', scope: 'all' as const },
      { label: 'Unresolved only', scope: 'unresolved' as const },
      { label: 'One file…', scope: 'file' as const },
    ],
    { placeHolder: 'Export scope' },
  );
  if (!scopePick) return;

  let file: string | undefined;
  if (scopePick.scope === 'file') {
    const files = [...new Set(review.threads.map((t) => t.anchor.filePath))].sort();
    if (files.length === 0) {
      void vscode.window.showInformationMessage('ReviewMate: this review has no comments.');
      return;
    }
    file = await vscode.window.showQuickPick(files, { placeHolder: 'File to export' });
    if (!file) return;
  }

  let live = false;
  if (controller.canExportLive(review)) {
    const modePick = await vscode.window.showQuickPick(
      [
        { label: 'Current positions', description: 're-anchored to the working tree (recommended)', live: true },
        { label: 'As reviewed', description: 'line numbers as captured when commented', live: false },
      ],
      { placeHolder: 'Line references' },
    );
    if (!modePick) return;
    live = modePick.live;
  }

  const meta: ExportMeta = {
    name: review.name,
    branch: review.branch,
    source: sourceLabel(controller.source, controller.baseRef),
    repoName: controller.repoName(),
    generatedAt: new Date().toISOString(),
  };
  const md = exportReviewMarkdown(meta, controller.exportThreads(review, live), { scope: scopePick.scope, file });
  if (!md) {
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
  await deliverExport(target.action, md, review.name);
}

function sourceLabel(source: DiffSource, baseRef?: string): string {
  if (source === 'vs-base') return `Compared with ${baseRef ?? 'base branch'}`;
  return SOURCES.find((s) => s.source === source)?.label ?? source;
}

async function deliverExport(action: 'clipboard' | 'editor' | 'file', md: string, name: string): Promise<void> {
  if (action === 'clipboard') {
    await vscode.env.clipboard.writeText(md);
    void vscode.window.showInformationMessage('ReviewMate: export copied to clipboard.');
  } else if (action === 'editor') {
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
  } else {
    const safe = name.replace(/[^\w.-]+/g, '-') || 'review';
    const folder = vscode.workspace.workspaceFolders?.[0];
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Export review',
      filters: { Markdown: ['md'] },
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, `${safe}.md`) : undefined,
    });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
  }
}

async function renameReview(controller: ReviewController, review?: Review): Promise<void> {
  if (!review) return;
  const name = await vscode.window.showInputBox({ prompt: 'Rename review', value: review.name });
  if (name?.trim()) await controller.renameReview(review.id, name.trim());
}

async function deleteReview(controller: ReviewController, review?: Review): Promise<void> {
  if (!review) return;
  const ok = await vscode.window.showWarningMessage(`Delete review "${review.name}"?`, { modal: true }, 'Delete');
  if (ok === 'Delete') await controller.deleteReview(review.id);
}

async function pickRepo(controller: ReviewController): Promise<void> {
  const repos = controller.repositories;
  if (repos.length <= 1) {
    void vscode.window.showInformationMessage('ReviewMate: only one repository in this workspace.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: r.name, description: r.repoRoot, repoRoot: r.repoRoot })),
    { placeHolder: 'Repository' },
  );
  if (picked) await controller.setRepo(picked.repoRoot);
}
