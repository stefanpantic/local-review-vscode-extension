import * as vscode from 'vscode';
import { ReviewState } from './reviewState';
import { ReviewStore } from './comments/ReviewStore';
import { ReviewController } from './reviewController';
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
import * as path from 'node:path';
import type { DiffSource } from './model/ReviewDiff';
import type { Review } from './model/Comment';

/** Narrow a command argument (tree node or selection) to a Review. */
function asReview(x: unknown): Review | undefined {
  return x && typeof x === 'object' && 'id' in x && 'threads' in x ? (x as Review) : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const state = new ReviewState(context);
  const reviewStore = new ReviewStore(context.workspaceState);
  const controller = new ReviewController(state, reviewStore);
  const filesView = new FilesView(controller);
  const tree = vscode.window.createTreeView('localReview.files', {
    treeDataProvider: filesView,
    showCollapseAll: true,
  });

  const commentsView = new CommentsView(controller);
  const commentsTree = vscode.window.createTreeView('localReview.comments', {
    treeDataProvider: commentsView,
    showCollapseAll: true,
  });

  const reviewsView = new ReviewsView(controller);
  const reviewsTree = vscode.window.createTreeView('localReview.reviews', { treeDataProvider: reviewsView });

  // --- MCP server lifecycle (binds to 127.0.0.1 only). Runs on launch when localReview.mcp.autoStart,
  //     or on demand via Start/Stop; `mcpDesired` is the session's running intent. ---
  let mcpHandle: McpServerHandle | undefined;
  let mcpDesired = vscode.workspace.getConfiguration('localReview').get<boolean>('mcp.autoStart', false);
  let mcpOp: Promise<void> = Promise.resolve(); // serializes start/stop so bursts can't race
  const mcpToken = (): string => {
    let t = context.workspaceState.get<string>('localReview.mcp.token');
    if (!t) {
      t = randomUUID();
      void context.workspaceState.update('localReview.mcp.token', t);
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
      const cfg = vscode.workspace.getConfiguration('localReview');
      const opts = { version: context.extension.packageJSON.version as string, token: mcpToken() };
      const cfgPort = cfg.get<number>('mcp.port', 0);
      // A fixed port wins; otherwise reuse the last auto-assigned one so the URL survives restarts.
      const wantPort =
        cfgPort > 0 ? cfgPort : (context.workspaceState.get<number>('localReview.mcp.resolvedPort') ?? 0);
      try {
        mcpHandle = await startMcpServer(controller.mcpApi(), { ...opts, port: wantPort });
      } catch {
        mcpHandle = await startMcpServer(controller.mcpApi(), { ...opts, port: 0 }); // requested port busy — take any free one
      }
      if (cfgPort === 0) void context.workspaceState.update('localReview.mcp.resolvedPort', mcpHandle.port);
    });
    return mcpOp;
  };
  const setupMcp = async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('localReview');
    const input = await vscode.window.showInputBox({
      title: 'Local Review MCP server port',
      prompt: 'Port for the MCP server (0 = pick a free port; it is then reused across restarts)',
      value: String(cfg.get<number>('mcp.port', 0)),
      validateInput: (v) =>
        /^\d+$/.test(v.trim()) && Number(v) <= 65535 ? undefined : 'Enter a port number between 0 and 65535.',
    });
    if (input === undefined) return; // cancelled
    const auto = await vscode.window.showQuickPick(
      [
        { label: 'Autostart on launch', description: 'run the MCP server every time VS Code opens', value: true },
        { label: 'Start manually', description: 'start it with "Local Review: Start MCP Server"', value: false },
      ],
      { title: 'Local Review MCP autostart', placeHolder: 'Start the MCP server automatically on launch?' },
    );
    if (!auto) return; // cancelled
    await cfg.update('mcp.port', Number(input.trim()), vscode.ConfigurationTarget.Workspace);
    await cfg.update('mcp.autoStart', auto.value, vscode.ConfigurationTarget.Workspace);
    await context.workspaceState.update('localReview.mcp.configured', true);
    mcpDesired = true;
    await syncMcp();
    if (!mcpHandle) {
      void vscode.window.showErrorMessage('Local Review: could not start the MCP server.');
      return;
    }
    const { url, token } = mcpHandle;
    const jsonUri = await writeMcpArtifacts(url, token);
    const choice = await vscode.window.showInformationMessage(
      'Local Review MCP server is running.',
      {
        modal: true,
        detail: `URL: ${url}\n\nConnect your MCP client using .local-review/mcp.json. It has the URL, token, and ready-to-run connect commands for Claude Code and other clients.`,
      },
      'Open mcp.json',
      'Copy URL',
    );
    if (choice === 'Open mcp.json' && jsonUri) await vscode.window.showTextDocument(jsonUri);
    else if (choice === 'Copy URL') await vscode.env.clipboard.writeText(url);
  };
  // Start on demand. First time (never configured) runs setup so the user gets the connect details.
  const startMcp = async (): Promise<void> => {
    if (!context.workspaceState.get<boolean>('localReview.mcp.configured')) {
      await setupMcp();
      return;
    }
    mcpDesired = true;
    await syncMcp();
    if (!mcpHandle) return;
    const jsonUri = await writeMcpArtifacts(mcpHandle.url, mcpHandle.token);
    const choice = await vscode.window.showInformationMessage(
      `Local Review MCP server is running at ${mcpHandle.url}.`,
      'Open mcp.json',
    );
    if (choice === 'Open mcp.json' && jsonUri) await vscode.window.showTextDocument(jsonUri);
  };
  const stopMcp = async (): Promise<void> => {
    mcpDesired = false;
    await syncMcp();
    void vscode.window.showInformationMessage('Local Review MCP server stopped.');
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
    vscode.commands.registerCommand('localReview.newReview', () => controller.newReview()),
    vscode.commands.registerCommand('localReview.switchReview', (r) => {
      const rev = asReview(r);
      if (rev) void controller.switchReview(rev.id);
    }),
    vscode.commands.registerCommand('localReview.renameReview', (r) =>
      renameReview(controller, asReview(r) ?? asReview(reviewsTree.selection[0])),
    ),
    vscode.commands.registerCommand('localReview.deleteReview', (r) =>
      deleteReview(controller, asReview(r) ?? asReview(reviewsTree.selection[0])),
    ),
    vscode.commands.registerCommand('localReview.moveReviewToCurrentBranch', (r) => {
      const rev = asReview(r) ?? asReview(reviewsTree.selection[0]);
      if (rev) void controller.moveReviewToCurrentBranch(rev.id);
    }),
    vscode.commands.registerCommand('localReview.exportReview', (r) => exportReview(controller, asReview(r))),
    vscode.commands.registerCommand('localReview.nextChange', () => controller.navigate('file', 'next')),
    vscode.commands.registerCommand('localReview.prevChange', () => controller.navigate('file', 'prev')),
    vscode.commands.registerCommand('localReview.nextComment', () => controller.navigate('comment', 'next')),
    vscode.commands.registerCommand('localReview.prevComment', () => controller.navigate('comment', 'prev')),
    watchRepoChanges(() => void controller.refresh()),
    vscode.commands.registerCommand('localReview.startReview', async () => {
      await controller.refresh();
      ReviewPanel.show(context.extensionUri, controller);
    }),
    vscode.commands.registerCommand('localReview.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('localReview.revealFile', (filePath?: string) => {
      ReviewPanel.show(context.extensionUri, controller); // create or reveal (focuses the tab)
      if (typeof filePath === 'string') controller.reveal(filePath);
    }),
    vscode.commands.registerCommand('localReview.selectSource', () => pickSource(controller)),
    vscode.commands.registerCommand('localReview.selectRepo', () => pickRepo(controller)),
    vscode.commands.registerCommand('localReview.toggleViewMode', () =>
      controller.setViewPref({ viewMode: controller.viewMode === 'split' ? 'unified' : 'split' }),
    ),
    vscode.commands.registerCommand('localReview.toggleWhitespace', () =>
      controller.setViewPref({ whitespace: !controller.whitespace }),
    ),
    vscode.commands.registerCommand('localReview.setupMcp', () => setupMcp()),
    vscode.commands.registerCommand('localReview.startMcp', () => startMcp()),
    vscode.commands.registerCommand('localReview.stopMcp', () => stopMcp()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localReview.mcp.port')) void syncMcp(); // a port change restarts a running server
      if (e.affectsConfiguration('localReview')) void controller.refresh();
    }),
    new vscode.Disposable(() => mcpHandle?.dispose()),
  );

  await controller.refresh();
  void syncMcp();
}

export function deactivate(): void {
  // context.subscriptions handles cleanup
}

/**
 * Write the client-agnostic connect file (`.local-review/mcp.json`) and gitignore `.local-review/`; returns its Uri.
 * It's a standard MCP server, so connect commands for common clients live as comments and the connection
 * details are the JSON body. Nothing parses this file — it's a reference the user opens.
 */
async function writeMcpArtifacts(url: string, token: string): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const root = folder.uri.fsPath;
  await fs.mkdir(path.join(root, '.local-review'), { recursive: true });

  const content = `// Local Review MCP server. A standard, local (127.0.0.1), token-guarded MCP server over Streamable HTTP.
// Connect any MCP client with the url + token below. Ready-to-use options:
//
// Claude Code (CLI):
//   claude mcp remove local-review 2>/dev/null; claude mcp add --transport http local-review ${url} --header "Authorization: Bearer ${token}"
//
// mcpServers config for Claude Desktop, Cursor, Windsurf, VS Code, and other clients. Add under "mcpServers":
//   "local-review": {
//     "type": "http",
//     "url": "${url}",
//     "headers": { "Authorization": "Bearer ${token}" }
//   }
//
// Regenerated by "Set up MCP" / "Start MCP Server". The port + token persist across restarts.
${JSON.stringify({ url, token, transport: 'http' }, null, 2)}
`;
  const jsonUri = vscode.Uri.file(path.join(root, '.local-review', 'mcp.json'));
  await fs.writeFile(jsonUri.fsPath, content, 'utf8');

  const gitignore = path.join(root, '.gitignore');
  let text = '';
  try {
    text = await fs.readFile(gitignore, 'utf8');
  } catch {
    // no .gitignore yet — we'll create it
  }
  if (!text.split(/\r?\n/).some((line) => line.trim().replace(/\/$/, '') === '.local-review')) {
    await fs.writeFile(gitignore, text + (text && !text.endsWith('\n') ? '\n' : '') + '.local-review/\n', 'utf8');
  }
  return jsonUri;
}

const SOURCES: { label: string; description: string; source: DiffSource }[] = [
  { label: 'Uncommitted changes', description: 'everything not yet committed', source: 'worktree-vs-head' },
  { label: 'Unstaged changes', description: 'not yet staged', source: 'unstaged' },
  { label: 'Staged changes', description: 'staged for commit', source: 'staged' },
  { label: 'Compare with a branch…', description: 'diff against another branch', source: 'vs-base' },
];

async function pickSource(controller: ReviewController): Promise<void> {
  const current = controller.source;
  const picked = await vscode.window.showQuickPick(
    SOURCES.map((s) => ({
      label: s.label,
      description: s.source === current ? `${s.description} · current` : s.description,
      source: s.source,
    })),
    { placeHolder: 'Select the diff source to review' },
  );
  if (!picked) return;
  if (picked.source === 'vs-base') {
    const branches = controller.repoRoot ? await listBranches(controller.repoRoot) : [];
    if (branches.length === 0) {
      void vscode.window.showWarningMessage('Local Review: no local branches to compare against.');
      return;
    }
    const base = await vscode.window.showQuickPick(branches, { placeHolder: 'Select the base branch' });
    if (!base) return;
    await controller.setSource('vs-base', base);
  } else {
    await controller.setSource(picked.source);
  }
}

async function exportReview(controller: ReviewController, arg?: Review): Promise<void> {
  const review = arg ?? controller.reviewToExport();
  if (!review) {
    void vscode.window.showInformationMessage('Local Review: no review to export.');
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
      void vscode.window.showInformationMessage('Local Review: this review has no comments.');
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
    void vscode.window.showInformationMessage('Local Review: no comments match that scope.');
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
    void vscode.window.showInformationMessage('Local Review: export copied to clipboard.');
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
    void vscode.window.showInformationMessage('Local Review: only one repository in this workspace.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: r.name, description: r.repoRoot, repoRoot: r.repoRoot })),
    { placeHolder: 'Repository' },
  );
  if (picked) await controller.setRepo(picked.repoRoot);
}
