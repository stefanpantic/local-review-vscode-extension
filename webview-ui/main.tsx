import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './styles/diff.css';
import { request, on } from './rpcClient';
import type { DiffResult } from '../src/model/ReviewDiff';
import { DiffView } from './render/DiffView';

function App() {
  const [result, setResult] = useState<DiffResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const repos = await request('listRepositories', {});
        if (cancelled) return;
        if (repos.length === 0) {
          setResult({ state: 'no-repo' });
          return;
        }
        const r = await request('getDiff', { repoRoot: repos[0].repoRoot, source: 'worktree-vs-head' });
        if (!cancelled) setResult(r);
      } catch (e) {
        if (!cancelled) setResult({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }

    void load();
    const off = on('diffUpdated', (p) => setResult(p.result));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return <DiffView result={result} />;
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
