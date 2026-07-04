import * as vscode from 'vscode';
import { ReviewState } from './reviewState';
import { ReviewStore } from './comments/ReviewStore';
import { ReviewController } from './reviewController';
import { FilesView } from './webview/filesView';
import { CommentsView } from './webview/commentsView';
import { ReviewsView } from './webview/reviewsView';
import { ReviewPanel } from './webview/ReviewPanel';
import { listBranches } from './git/git';
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

  tree.onDidChangeCheckboxState(
    (e) => {
      for (const [node, cbState] of e.items) {
        if (node.kind === 'file') {
          void controller.setViewed(node.file.path, cbState === vscode.TreeItemCheckboxState.Checked);
        }
      }
    },
    null,
    context.subscriptions
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
      renameReview(controller, asReview(r) ?? asReview(reviewsTree.selection[0]))
    ),
    vscode.commands.registerCommand('localReview.deleteReview', (r) =>
      deleteReview(controller, asReview(r) ?? asReview(reviewsTree.selection[0]))
    ),
    vscode.commands.registerCommand('localReview.moveReviewToCurrentBranch', (r) => {
      const rev = asReview(r) ?? asReview(reviewsTree.selection[0]);
      if (rev) void controller.moveReviewToCurrentBranch(rev.id);
    }),
    vscode.commands.registerCommand('localReview.startReview', async () => {
      await controller.refresh();
      ReviewPanel.show(context.extensionUri, controller);
    }),
    vscode.commands.registerCommand('localReview.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('localReview.revealFile', (filePath?: string) => {
      if (!ReviewPanel.isOpen) ReviewPanel.show(context.extensionUri, controller);
      if (typeof filePath === 'string') controller.reveal(filePath);
    }),
    vscode.commands.registerCommand('localReview.selectSource', () => pickSource(controller)),
    vscode.commands.registerCommand('localReview.selectRepo', () => pickRepo(controller)),
    vscode.commands.registerCommand('localReview.toggleViewMode', () =>
      controller.setViewPref({ viewMode: controller.viewMode === 'split' ? 'unified' : 'split' })
    ),
    vscode.commands.registerCommand('localReview.toggleWhitespace', () =>
      controller.setViewPref({ whitespace: !controller.whitespace })
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localReview')) void controller.refresh();
    })
  );

  await controller.refresh();
}

export function deactivate(): void {
  // context.subscriptions handles cleanup
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
    { placeHolder: 'Select the diff source to review' }
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
    { placeHolder: 'Repository' }
  );
  if (picked) await controller.setRepo(picked.repoRoot);
}
