import * as vscode from 'vscode';
import { ReviewState } from './reviewState';
import { ReviewController } from './reviewController';
import { FilesView } from './webview/filesView';
import { ReviewPanel } from './webview/ReviewPanel';
import { listBranches } from './git/git';
import type { DiffSource } from './model/ReviewDiff';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const state = new ReviewState(context);
  const controller = new ReviewController(state);
  const filesView = new FilesView(controller);
  const tree = vscode.window.createTreeView('localReview.files', {
    treeDataProvider: filesView,
    showCollapseAll: true,
  });

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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localReview')) void controller.refresh();
    })
  );

  await controller.refresh();
}

export function deactivate(): void {
  // context.subscriptions handles cleanup
}

const SOURCES: { label: string; source: DiffSource }[] = [
  { label: 'Working tree vs HEAD', source: 'worktree-vs-head' },
  { label: 'Unstaged', source: 'unstaged' },
  { label: 'Staged', source: 'staged' },
  { label: 'vs base branch…', source: 'vs-base' },
];

async function pickSource(controller: ReviewController): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    SOURCES.map((s) => ({ label: s.label, source: s.source })),
    { placeHolder: 'Diff source' }
  );
  if (!picked) return;
  if (picked.source === 'vs-base') {
    const branches = controller.repoRoot ? await listBranches(controller.repoRoot) : [];
    if (branches.length === 0) {
      void vscode.window.showWarningMessage('Local Review: no local branches to compare against.');
      return;
    }
    const base = await vscode.window.showQuickPick(branches, { placeHolder: 'Base branch' });
    if (!base) return;
    await controller.setSource('vs-base', base);
  } else {
    await controller.setSource(picked.source);
  }
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
