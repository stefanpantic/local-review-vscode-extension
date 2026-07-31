import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './styles/diff.css';
import { request, on } from './rpcClient';
import type { ReviewStatePayload } from '../src/protocol/messages';
import type { ViewMode } from '../src/model/ReviewDiff';
import { DiffView } from './render/DiffView';
import { carryDiff } from './carryDiff';

function cssEscape(v: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"');
}

/**
 * Scroll to a comment thread (or the file section when no threadId). A thread may not be in the DOM
 * because its file is collapsed (large files / viewed files render header-only) or it sits in a collapsed
 * "Outdated comments" section; in either case expand that first, then scroll. scroll-margin-top keeps the
 * target clear of the sticky summary + file headers.
 */
function revealFile(filePath: string, threadId?: string, attempt = 0, expanded = false): void {
  const fileEl = document.querySelector(`[data-lr-path="${cssEscape(filePath)}"]`);
  if (threadId) {
    const thread = document.querySelector(`[data-lr-thread="${cssEscape(threadId)}"]`);
    if (thread) {
      thread.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // The thread's file is collapsed, so its body (and the thread) isn't rendered — expand it, then retry.
    if (!expanded && fileEl?.classList.contains('lr-collapsed')) {
      fileEl.querySelector<HTMLElement>('.lr-file-header .lr-chevron')?.click();
      requestAnimationFrame(() => revealFile(filePath, threadId, attempt, true));
      return;
    }
    const head = document.querySelector<HTMLElement>('.lr-outdated-section.lr-collapsed .lr-outdated-head');
    if (head) {
      head.click(); // expand the outdated section, then try again once it renders
      requestAnimationFrame(() => revealFile(filePath, threadId, attempt, expanded));
      return;
    }
    // Still not on the diff yet (e.g. the PR is rendering) — wait a few frames for it.
    if (attempt < 120) {
      requestAnimationFrame(() => revealFile(filePath, threadId, attempt + 1, expanded));
      return;
    }
  }
  fileEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Breathing room above a revealed target. Mirrors --lr-reveal-gap, which sets the same gap in CSS. */
const REVEAL_GAP = 8;

/** Height of an element, or a fallback when it is not on the page. */
function heightOf(selector: string, fallback: number): number {
  return document.querySelector(selector)?.getBoundingClientRect().height ?? fallback;
}

/**
 * How much of the top of the viewport is hidden behind sticky headers. A file section is occluded by the top
 * bar alone; a thread is also occluded by its file header. Measured rather than assumed, because the top bar
 * carries an extra row in PR mode and wraps on a narrow panel — anything above this is not really visible,
 * so it must not count as the "next" item.
 */
function stickyOffset(target: 'file' | 'comment'): number {
  const bar = heightOf('.lr-topbar', 33);
  return target === 'file' ? bar : bar + heightOf('.lr-file-header', 40);
}

/**
 * Scroll to the next/previous changed file (section) or comment (thread).
 *
 * Both directions are measured from the reading line — where a revealed item comes to rest, just below the
 * sticky headers — not from the raw viewport top. Anything above that line is hidden behind the headers, so
 * treating it as visible would make "next" land on the item you are already looking at.
 */
function navigateTo(target: 'file' | 'comment', dir: 'next' | 'prev'): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>(target === 'file' ? '[data-lr-path]' : '.lr-thread'));
  if (els.length === 0) return;
  const line = stickyOffset(target) + REVEAL_GAP;
  const eps = 4; // don't re-pick the item already parked on the line
  const tops = els.map((e) => e.getBoundingClientRect().top);
  let i: number;
  if (dir === 'next') {
    i = tops.findIndex((t) => t > line + eps);
    if (i === -1) i = els.length - 1;
  } else {
    i = 0;
    for (let k = els.length - 1; k >= 0; k--) {
      if (tops[k] < line - eps) {
        i = k;
        break;
      }
    }
  }
  els[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function App() {
  const [state, setState] = useState<ReviewStatePayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    request('getState', {})
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            result: { state: 'error', message: e instanceof Error ? e.message : String(e) },
            source: 'worktree-vs-head',
            repos: [],
            viewed: {},
            viewMode: 'unified',
            whitespace: false,
            wrap: false,
            threads: [],
            config: { largeFileThreshold: 1000 },
          });
        }
      });

    const offState = on('stateChanged', (s) => setState((prev) => carryDiff(prev, s)));
    const offViewed = on('viewedUpdated', ({ viewed }) => setState((prev) => (prev ? { ...prev, viewed } : prev)));
    const offThreads = on('threadsUpdated', ({ threads, pending }) =>
      setState((prev) => (prev ? { ...prev, threads, pending } : prev)),
    );
    const offReveal = on('revealFile', ({ filePath, threadId }) => revealFile(filePath, threadId));
    const offNav = on('navigate', ({ target, dir }) => navigateTo(target, dir));
    return () => {
      cancelled = true;
      offState();
      offViewed();
      offThreads();
      offReveal();
      offNav();
    };
  }, []);

  // Tell the host once the current diff has painted (threads are in the DOM), so the sidebar can flip its
  // comments from a loading spinner to clickable. Double rAF waits for layout + paint after the render.
  useEffect(() => {
    if (!state) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => void request('panelRendered', {}));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [state]);

  const setViewed = (filePath: string, viewed: boolean): void => {
    void request('setViewed', { filePath, viewed });
  };
  const setViewPref = (patch: { viewMode?: ViewMode; whitespace?: boolean; wrap?: boolean }): void => {
    void request('setViewPref', patch);
  };

  return <DiffView state={state} setViewed={setViewed} setViewPref={setViewPref} />;
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
