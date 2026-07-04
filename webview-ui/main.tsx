import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './styles/diff.css';
import { request, on } from './rpcClient';
import type { ReviewStatePayload } from '../src/protocol/messages';
import type { ViewMode } from '../src/model/ReviewDiff';
import { DiffView } from './render/DiffView';

function revealFile(filePath: string): void {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(filePath) : filePath.replace(/"/g, '\\"');
  const el = document.querySelector(`[data-lr-path="${escaped}"]`);
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
            threads: [],
            config: { largeFileThreshold: 1000 },
          });
        }
      });

    const offState = on('stateChanged', (s) => setState(s));
    const offViewed = on('viewedUpdated', ({ viewed }) => setState((prev) => (prev ? { ...prev, viewed } : prev)));
    const offThreads = on('threadsUpdated', ({ threads }) => setState((prev) => (prev ? { ...prev, threads } : prev)));
    const offReveal = on('revealFile', ({ filePath }) => revealFile(filePath));
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
  const setViewPref = (patch: { viewMode?: ViewMode; whitespace?: boolean }): void => {
    void request('setViewPref', patch);
  };

  return <DiffView state={state} setViewed={setViewed} setViewPref={setViewPref} />;
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
