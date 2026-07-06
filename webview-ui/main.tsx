import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './styles/diff.css';
import { request, on } from './rpcClient';
import type { ReviewStatePayload } from '../src/protocol/messages';
import type { ViewMode } from '../src/model/ReviewDiff';
import { DiffView } from './render/DiffView';

function cssEscape(v: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"');
}

/**
 * Scroll to a specific comment thread when a threadId is given, else to the file section. If the target
 * thread isn't in the DOM (its "Outdated comments" section is collapsed), open that section, then scroll.
 */
function revealFile(filePath: string, threadId?: string): void {
  const find = (): Element | null =>
    (threadId ? document.querySelector(`[data-lr-thread="${cssEscape(threadId)}"]`) : null) ??
    document.querySelector(`[data-lr-path="${cssEscape(filePath)}"]`);
  const el = find();
  if (!el && threadId) {
    const head = document.querySelector<HTMLElement>('.lr-outdated-section.lr-collapsed .lr-outdated-head');
    if (head) {
      head.click(); // expand the outdated section, then scroll once it renders
      requestAnimationFrame(() => find()?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return;
    }
  }
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Scroll to the next/previous changed file (section) or comment (thread) relative to the viewport. */
function navigateTo(target: 'file' | 'comment', dir: 'next' | 'prev'): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>(target === 'file' ? '[data-lr-path]' : '.lr-thread'));
  if (els.length === 0) return;
  const margin = 40; // tolerance so the item at the top isn't re-picked
  const tops = els.map((e) => e.getBoundingClientRect().top);
  let i: number;
  if (dir === 'next') {
    i = tops.findIndex((t) => t > margin);
    if (i === -1) i = els.length - 1;
  } else {
    i = 0;
    for (let k = els.length - 1; k >= 0; k--) {
      if (tops[k] < -margin) {
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

    const offState = on('stateChanged', (s) => setState(s));
    const offViewed = on('viewedUpdated', ({ viewed }) => setState((prev) => (prev ? { ...prev, viewed } : prev)));
    const offThreads = on('threadsUpdated', ({ threads }) => setState((prev) => (prev ? { ...prev, threads } : prev)));
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
