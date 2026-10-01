import * as vscode from 'vscode';
import { log } from './log';
import { nextPollDelay } from './poll';
import type { OrphanReport } from './review/reconcile';
import type { RepoSession } from './repoSession';

/**
 * The background poll for one repository's open pull request: pick up upstream comment changes live and flag
 * an advanced head. A tick does nothing outside PR mode, skips if the previous one is still in flight, and the
 * poll is off when the interval is 0. The poller schedules each tick with setTimeout, so the delay can grow on
 * consecutive failures and reset on success.
 *
 * The poll pauses while the repository's review panel is closed or the window is in the background, since
 * every tick spends the user's GitHub API budget. A tick that finds it paused arms nothing. Opening the panel
 * or focusing the window wakes it with one tick right away.
 */
export class PrPoller implements vscode.Disposable {
  private polling = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private idle = false; // a tick found the poll paused and armed no timer
  private readonly focus: vscode.Disposable;

  constructor(private readonly session: RepoSession) {
    this.focus = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) this.wake();
    });
    this.schedule();
  }

  /** Run a tick now if the poll paused and has a reason to run again. A poll with a timer armed is left alone. */
  wake(): void {
    if (!this.idle || this.disposed || !this.active()) return;
    this.idle = false;
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = undefined;
    void this.tick();
  }

  /** Arm the next tick from the current interval setting and the session's failure run. */
  schedule(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    const baseSecs = vscode.workspace.getConfiguration('agenticReview').get<number>('github.pollInterval', 60);
    if (baseSecs <= 0) return;
    // The session stores the failure count, because the session counts the errors the tick catches.
    // A second counter in this class would stay at zero, so every retry would wait the base interval.
    const failures = this.session.pollFailures;
    const ms = nextPollDelay(baseSecs, failures);
    log('[poll]', this.session.repoName(), 'next tick in', ms / 1000, 'secs; consecutive failures:', failures);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  dispose(): void {
    this.disposed = true;
    this.focus.dispose();
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private active(): boolean {
    const baseSecs = vscode.workspace.getConfiguration('agenticReview').get<number>('github.pollInterval', 60);
    return baseSecs > 0 && this.session.source === 'pr' && this.session.hasPanel() && vscode.window.state.focused;
  }

  private async tick(): Promise<void> {
    if (this.polling || this.session.source !== 'pr') {
      this.schedule();
      return;
    }
    if (!this.active()) {
      log('[poll]', this.session.repoName(), 'paused until the review panel is open and the window has focus');
      this.idle = true;
      return;
    }
    this.polling = true;
    try {
      const { orphans, incoming } = await this.session.pollPullRequest();
      const where = this.session.multiRepo() ? ` in ${this.session.repoName()}` : '';
      if (orphans) {
        void vscode.window.showInformationMessage(`ReviewMate: synced upstream changes${where}.${orphanNote(orphans)}`);
      }
      if (incoming) {
        void vscode.window.showInformationMessage(
          `ReviewMate: ${incoming} new comment${incoming === 1 ? '' : 's'} on the pull request${where}.`,
        );
      }
    } catch {
      this.session.recordPollFailure();
    } finally {
      this.polling = false;
      this.schedule();
    }
  }
}

/** A trailing sentence describing content whose upstream target vanished during a re-fetch, or empty. */
export function orphanNote(o: OrphanReport): string {
  const parts: string[] = [];
  if (o.localOnly > 0)
    parts.push(
      `${o.localOnly} of your comment${o.localOnly === 1 ? ' was' : 's were'} deleted on GitHub and kept here, badged "deleted on GitHub" (Submit reposts, or delete to discard)`,
    );
  if (o.deletes > 0) parts.push(`${o.deletes} staged delete${o.deletes === 1 ? '' : 's'} already gone upstream`);
  return parts.length ? ` (${parts.join('; ')}.)` : '';
}
