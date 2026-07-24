import { useEffect, useState } from 'react';
import { Markdown } from '../components/Markdown';
import type { CommentThread } from '../../src/model/Comment';
import { TokenText } from '../render/UnifiedRows';
import type { Tok } from '../render/highlight';
import { CommentForm } from './CommentForm';

export interface ThreadOps {
  onReply: (body: string, suggestion?: string) => void;
  onEdit: (commentId: string, body: string, suggestion: string | null | undefined) => void;
  onDelete: (commentId: string) => void;
  onResolve: (resolved: boolean) => void;
}

/** Tokenize code in the anchored file's language (falls back to plain lines when unavailable). */
export type Tokenize = (text: string) => Tok[][];

/** The line(s) a thread corresponds to — a range for block comments, a single line otherwise. */
function lineLabel(t: CommentThread): string {
  const start = t.resolvedLine ?? t.anchor.lineNumber;
  const end = t.resolvedEndLine ?? t.anchor.endLineNumber ?? start;
  return end > start ? `Lines ${start}–${end}` : `Line ${start}`;
}

/** A proposed change, rendered as a syntax-highlighted before→after diff (original removed, replacement added). */
function Suggestion({
  original,
  replacement,
  tokenize,
}: {
  original: string;
  replacement: string;
  tokenize: Tokenize;
}) {
  const oToks = tokenize(original);
  const rToks = tokenize(replacement);
  return (
    <div className="lr-suggestion">
      <div className="lr-suggestion-head">Suggested change</div>
      <div className="lr-suggestion-diff">
        {original.split('\n').map((l, i) => (
          <div key={`o${i}`} className="lr-sugg-line lr-sugg-del">
            <TokenText tokens={oToks[i]} text={l} />
          </div>
        ))}
        {replacement.split('\n').map((l, i) => (
          <div key={`r${i}`} className="lr-sugg-line lr-sugg-add">
            <TokenText tokens={rToks[i]} text={l} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One comment thread rendered as a card. A chevron collapses it to its header row (resolved starts collapsed). */
export function CommentThreadView({
  thread,
  ops,
  suggestBase,
  tokenize,
  pendingOnRemote = false,
}: {
  thread: CommentThread;
  ops: ThreadOps;
  suggestBase: string;
  tokenize: Tokenize;
  pendingOnRemote?: boolean; // a local draft on a PR review, not yet posted to the remote
}) {
  const [replying, setReplying] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!thread.resolved);
  useEffect(() => setExpanded(!thread.resolved), [thread.resolved]);

  const canSuggest = thread.anchor.side === 'new';

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
        {pendingOnRemote && (
          <span className="lr-badge lr-badge-pending" title="A local draft, not posted to GitHub">
            not on GitHub
          </span>
        )}
      </span>
    </div>
  );

  if (!expanded) {
    return (
      <div
        className={`lr-thread lr-thread-collapsed${thread.resolved ? ' lr-thread-resolved' : ''}`}
        data-lr-thread={thread.id}
      >
        {head}
      </div>
    );
  }

  return (
    <div className={`lr-thread${thread.resolved ? ' lr-thread-resolved' : ''}`} data-lr-thread={thread.id}>
      {head}

      <div className="lr-comments">
        {thread.comments.map((c, i) => {
          const cls = `lr-comment${i > 0 ? ' lr-reply' : ''}`;
          return editingId === c.id ? (
            <div className={`${cls} lr-comment-editing`} key={c.id}>
              <CommentForm
                initial={c.body}
                initialSuggestion={c.suggestion?.replacement}
                suggestBase={suggestBase}
                canSuggest={canSuggest}
                submitLabel="Save"
                onSubmit={(b, s) => {
                  ops.onEdit(c.id, b, s);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            </div>
          ) : (
            <div className={cls} key={c.id}>
              <div className="lr-comment-main">
                {c.author && (
                  <div className={`lr-comment-author${c.author === 'AI Agent' ? ' lr-author-agent' : ''}`}>
                    {c.author}
                  </div>
                )}
                {c.body && (
                  <div className="lr-comment-body lr-markdown">
                    <Markdown>{c.body}</Markdown>
                  </div>
                )}
                {c.suggestion && (
                  <Suggestion
                    original={c.suggestion.original}
                    replacement={c.suggestion.replacement}
                    tokenize={tokenize}
                  />
                )}
              </div>
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
            suggestBase={suggestBase}
            canSuggest={canSuggest}
            onSubmit={(b, s) => {
              ops.onReply(b, s ?? undefined);
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
