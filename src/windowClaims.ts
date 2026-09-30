import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** One window's claim on a repository: the extension host process that holds it, and the window's name. */
interface WindowClaim {
  pid: number;
  repoRoot: string;
  window: string;
}

/** Whether a process is still running. A process owned by another user still counts. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Which other VS Code windows have the same repository open. Every window runs its own extension host
 * process, and each one writes a small claim file per open repository into a folder all windows share. A
 * claim whose process has exited is stale and gets removed when it is read.
 */
export class WindowClaims {
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  private readonly held = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly window: string,
    opts?: { pid?: number; alive?: (pid: number) => boolean },
  ) {
    this.pid = opts?.pid ?? process.pid;
    this.alive = opts?.alive ?? isAlive;
  }

  async claim(repoRoot: string): Promise<void> {
    const claim: WindowClaim = { pid: this.pid, repoRoot, window: this.window };
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.file(repoRoot, this.pid), JSON.stringify(claim));
    this.held.add(repoRoot);
  }

  async release(repoRoot: string): Promise<void> {
    this.held.delete(repoRoot);
    await fs.promises.rm(this.file(repoRoot, this.pid), { force: true });
  }

  /** Drop every claim this window holds. Synchronous, so it finishes while the extension host shuts down. */
  releaseAll(): void {
    for (const repoRoot of this.held) fs.rmSync(this.file(repoRoot, this.pid), { force: true });
    this.held.clear();
  }

  /** The names of the other running windows that have this repository open. */
  async others(repoRoot: string): Promise<string[]> {
    const prefix = `${repoKey(repoRoot)}-`;
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const windows: string[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const full = path.join(this.dir, name);
      const claim = await readClaim(full);
      if (!claim || claim.repoRoot !== repoRoot || claim.pid === this.pid) continue;
      if (this.alive(claim.pid)) windows.push(claim.window);
      else await fs.promises.rm(full, { force: true });
    }
    return windows;
  }

  private file(repoRoot: string, pid: number): string {
    return path.join(this.dir, `${repoKey(repoRoot)}-${pid}.json`);
  }
}

function repoKey(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
}

async function readClaim(file: string): Promise<WindowClaim | undefined> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Partial<WindowClaim>;
    if (typeof raw.pid !== 'number' || typeof raw.repoRoot !== 'string' || typeof raw.window !== 'string') {
      return undefined;
    }
    return { pid: raw.pid, repoRoot: raw.repoRoot, window: raw.window };
  } catch {
    return undefined;
  }
}
