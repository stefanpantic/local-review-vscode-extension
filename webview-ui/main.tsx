import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './styles/diff.css';
import { request, on } from './rpcClient';
import type { ReviewStatePayload } from '../src/protocol/messages';
import { DiffView } from './render/DiffView';

function revealFile(filePath: string): void {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(filePath) : filePath.replace(/"/g, '\\"');
  const el = document.querySelector(`[data-lr-path="${escaped}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
            config: { largeFileThreshold: 1000 },
          });
        }
      });

    const offState = on('stateChanged', (s) => setState(s));
    const offViewed = on('viewedUpdated', ({ viewed }) => setState((prev) => (prev ? { ...prev, viewed } : prev)));
    const offReveal = on('revealFile', ({ filePath }) => revealFile(filePath));
    return () => {
      cancelled = true;
      offState();
      offViewed();
      offReveal();
    };
  }, []);

  const setViewed = (filePath: string, viewed: boolean): void => {
    void request('setViewed', { filePath, viewed });
  };

  return <DiffView state={state} setViewed={setViewed} />;
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
