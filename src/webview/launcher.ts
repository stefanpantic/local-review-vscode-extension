import * as vscode from 'vscode';

/**
 * Minimal activity-bar launcher for Iteration 1: an empty TreeView so the `viewsWelcome`
 * "Start a Review" button shows. This grows into a rich WebviewView in Iteration 2 (file list,
 * source picker) and Iteration 5 (a "past reviews" list of saved reviews for this repo).
 * See docs/decisions/0005-ui-placement-editor-tab.md and 0009-review-sessions-vs-export.md.
 */
export class LauncherProvider implements vscode.TreeDataProvider<never> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }

  getChildren(): never[] {
    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
