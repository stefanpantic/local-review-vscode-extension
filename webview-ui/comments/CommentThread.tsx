import { useEffect, useState } from 'react';
import type { CommentThread } from '../../src/model/Comment';
import { CommentForm } from './CommentForm';

export interface ThreadOps {
  onReply: (body: string) => void;
  onEdit: (commentId: string, body: string) => void;
  onDelete: (commentId: string) => void;
  onResolve: (resolved: boolean) => void;
}

/** The line a thread corresponds to — its current (resolved) line, or the remembered one when outdated. */
function lineLabel(t: CommentThread): string {
  return `Line ${t.resolvedLine ?? t.anchor.lineNumber}`;
}

/** One comment thread rendered as a card. A chevron collapses it to its header row (resolved starts collapsed). */
export function CommentThreadView({ thread, ops }: { thread: CommentThread; ops: ThreadOps }) {
  const [replying, setReplying] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!thread.resolved);
  // Resolving collapses the thread, reopening expands it; manual toggles persist until resolved next flips.
  useEffect(() => setExpanded(!thread.resolved), [thread.resolved]);

  // Header layout is IDENTICAL collapsed vs expanded (chevron · line · badges), so nothing shifts.
  const head = (
    <div
      className={`lr-thread-head${expanded ? '' : ' lr-thread-head-clickable'}`}
      onClick={expanded ? undefined : () => setExpanded(true)}
    >
      <button
        className="lr-thread-toggle"
        aria-label={expanded ? 'Collapse' : 'Expand'}
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
      >
        {expanded ? '▾' : '▸'}
      </button>
      <span className="lr-thread-loc">{lineLabel(thread)}</span>
      <span className="lr-thread-badges">
        {thread.status === 'moved' && <span className="lr-badge lr-badge-moved">moved</span>}
        {thread.status === 'outdated' && <span className="lr-badge lr-badge-outdated">outdated</span>}
        {thread.resolved && <span className="lr-badge lr-badge-resolved">resolved</span>}
      </span>
    </div>
  );

  if (!expanded) {
    return <div className={`lr-thread lr-thread-collapsed${thread.resolved ? ' lr-thread-resolved' : ''}`}>{head}</div>;
  }

  return (
    <div className={`lr-thread${thread.resolved ? ' lr-thread-resolved' : ''}`}>
      {head}

      <div className="lr-comments">
        {thread.comments.map((c, i) => {
          const cls = `lr-comment${i > 0 ? ' lr-reply' : ''}`;
          return editingId === c.id ? (
            <div className={`${cls} lr-comment-editing`} key={c.id}>
              <CommentForm
                initial={c.body}
                submitLabel="Save"
                onSubmit={(b) => {
                  ops.onEdit(c.id, b);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            </div>
          ) : (
            <div className={cls} key={c.id}>
              <div className="lr-comment-body">{c.body}</div>
              <div className="lr-comment-tools">
                <button className="lr-ghost-btn" onClick={() => setEditingId(c.id)}>
                  Edit
                </button>
                <button className="lr-ghost-btn" onClick={() => ops.onDelete(c.id)}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="lr-thread-foot">
        {replying ? (
          <CommentForm
            submitLabel="Reply"
            onSubmit={(b) => {
              ops.onReply(b);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <>
            <button className="lr-btn lr-btn-sm" onClick={() => setReplying(true)}>
              Reply
            </button>
            <button className="lr-btn lr-btn-sm" onClick={() => ops.onResolve(!thread.resolved)}>
              {thread.resolved ? 'Reopen' : 'Resolve'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
