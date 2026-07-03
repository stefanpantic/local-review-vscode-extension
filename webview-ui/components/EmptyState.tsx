const MESSAGES: Record<string, { title: string; detail: string }> = {
  loading: { title: 'Loading…', detail: 'Reading the working tree.' },
  'no-repo': {
    title: 'No Git repository',
    detail: 'Open a folder that is a git repository to review its local changes.',
  },
  'unborn-head': {
    title: 'No commits yet',
    detail: 'This repository has no commits, and there are no staged or tracked changes to review.',
  },
  'no-changes': { title: 'No changes to review', detail: 'The working tree matches HEAD.' },
  error: { title: 'Something went wrong', detail: '' },
};

export function EmptyState({ state, message }: { state: string; message?: string }) {
  const m = MESSAGES[state] ?? { title: state, detail: '' };
  return (
    <div className="lr-empty">
      <div className="lr-empty-title">{m.title}</div>
      <div className="lr-empty-detail">{message || m.detail}</div>
    </div>
  );
}
