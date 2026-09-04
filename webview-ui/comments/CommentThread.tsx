import { useEffect, useState } from 'react';
import { Markdown } from '../components/Markdown';
import type { CommentThread, ReactionEmoji } from '../../src/model/Comment';
import { AGENT_AUTHOR, canEditComment, REACTION_EMOJIS } from '../../src/model/Comment';
import { TokenText } from '../render/UnifiedRows';
import type { Tok } from '../render/highlight';
import { CommentForm, hasDraft } from './CommentForm';

export interface ThreadOps {
  onReply: (body: string, suggestion?: string) => void;
  onEdit: (commentId: string, body: string, suggestion: string | null | undefined) => void;
  onDelete: (commentId: string) => void;
  onResolve: (resolved: boolean) => void;
  onToggleReaction: (commentId: string, emoji: ReactionEmoji) => void;
}

/** Tokenize code in the anchored file's language (falls back to plain lines when unavailable). */
export type Tokenize = (text: string) => Tok[][];

/** The line(s) a thread corresponds to — a range for block comments, a single line otherwise. */
function lineLabel(t: CommentThread): string {
  const start = t.resolvedLine ?? t.anchor.lineNumber;
  const end = t.resolvedEndLine ?? t.anchor.endLineNumber ?? start;
  return end > start ? `Lines ${start}-${end}` : `Line ${start}`;
}

/**
 * The single badge saying where a thread's comments actually live, most specific first. These are competing
 * claims about the same thing, so one wins instead of stacking: "deleted on GitHub" already says the comment
 * is not there, and a thread can hold both a never-sent draft and a comment GitHub is holding back.
 */
function RemoteBadge({
  deletedUpstream,
  notOnRemote,
  draftOnRemote,
}: {
  deletedUpstream: number; // yours, posted then deleted on GitHub, kept here
  notOnRemote: boolean; // a local draft thread, never sent
  draftOnRemote: number; // on GitHub, inside a review you have not submitted there
}) {
  if (deletedUpstream > 0) {
    return (
      <span
        className="lr-badge lr-badge-localonly"
        title={
          deletedUpstream === 1
            ? 'Your comment was deleted on GitHub. It is kept here: Submit reposts it, or delete it to discard.'
            : `${deletedUpstream} of your comments were deleted on GitHub. They are kept here: Submit reposts them, or delete them to discard.`
        }
      >
        deleted on GitHub
      </span>
    );
  }
  if (notOnRemote) {
    return (
      <span className="lr-badge lr-badge-pending" title="A local draft, not posted to GitHub">
        not on GitHub
      </span>
    );
  }
  if (draftOnRemote > 0) {
    return (
      <span
        className="lr-badge lr-badge-draft-remote"
        title={
          draftOnRemote === 1
            ? 'Part of a review you have not submitted on GitHub. Only you can see it until you submit that review there.'
            : `${draftOnRemote} comments here are part of a review you have not submitted on GitHub. Only you can see them until you submit that review there.`
        }
      >
        draft on GitHub
      </span>
    );
  }
  return null;
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

function ReactionBar({
  reactions,
  viewer,
  onToggle,
}: {
  reactions: Partial<Record<ReactionEmoji, string[]>> | undefined;
  viewer: string | undefined;
  onToggle: (emoji: ReactionEmoji) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const chips = REACTION_EMOJIS.filter((e) => reactions?.[e]?.length);
  return (
    <div className="lr-reactions">
      {chips.map((emoji) => {
        const users = reactions![emoji]!;
        const active = viewer != null && users.includes(viewer);
        return (
          <button
            key={emoji}
            className={`lr-reaction${active ? ' lr-reaction-active' : ''}`}
            title={users.join(', ')}
            onClick={() => onToggle(emoji)}
          >
            <span className="lr-reaction-emoji">{emoji}</span>
            <span className="lr-reaction-count">{users.length}</span>
          </button>
        );
      })}
      {pickerOpen ? (
        <div className="lr-reaction-picker">
          {REACTION_EMOJIS.map((emoji) => {
            const active = viewer != null && (reactions?.[emoji]?.includes(viewer) ?? false);
            return (
              <button
                key={emoji}
                className={`lr-reaction-pick${active ? ' lr-reaction-pick-active' : ''}`}
                onClick={() => {
                  onToggle(emoji);
                  setPickerOpen(false);
                }}
              >
                {emoji}
              </button>
            );
          })}
          <button className="lr-reaction-pick lr-reaction-pick-close" onClick={() => setPickerOpen(false)}>
            ✕
          </button>
        </div>
      ) : (
        <button className="lr-reaction-add" title="Add reaction" onClick={() => setPickerOpen(true)}>
          +
        </button>
      )}
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
  viewer,
  prMode = false,
}: {
  thread: CommentThread;
  ops: ThreadOps;
  suggestBase: string;
  tokenize: Tokenize;
  pendingOnRemote?: boolean; // a local draft on a PR review, not yet posted to the remote
  viewer?: string; // the current user's identity; comments not by them (in a PR) are read-only
  prMode?: boolean; // a PR review, where others' comments exist and are read-only
}) {
  const replyDraftKey = `reply:${thread.id}`;
  // Reopen the composer if it holds text a remount would otherwise have hidden (a sync, a diff refresh).
  const [replying, setReplying] = useState(() => hasDraft(replyDraftKey));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!thread.resolved);
  useEffect(() => setExpanded(!thread.resolved), [thread.resolved]);

  const canSuggest = thread.anchor.side === 'new';
  // Where this thread's comments stand on the remote. Thread-level facts, so they belong in the header badges
  // rather than beside an author name: they stay visible when the thread is collapsed, and they keep the
  // comment rows to their content.
  const deletedUpstream = thread.comments.filter((c) => c.localOnly).length;
  // GitHub holds these inside a review you never submitted there, so nobody else can see them yet.
  const draftOnRemote = thread.comments.filter((c) => c.remotePending).length;

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
        <RemoteBadge deletedUpstream={deletedUpstream} notOnRemote={pendingOnRemote} draftOnRemote={draftOnRemote} />
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
          const canEdit = canEditComment(c, viewer, prMode);
          return editingId === c.id ? (
            <div className={`${cls} lr-comment-editing`} key={c.id}>
              <CommentForm
                initial={c.body}
                initialSuggestion={c.suggestion?.replacement}
                suggestBase={suggestBase}
                canSuggest={canSuggest}
                submitLabel="Save"
                draftKey={`edit:${c.id}`}
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
                  <div className={`lr-comment-author${c.author === AGENT_AUTHOR ? ' lr-author-agent' : ''}`}>
                    {c.author}
                    {c.conflict && (
                      <span
                        className="lr-badge lr-badge-conflict"
                        title="This comment also changed on GitHub after you edited it. Submitting replaces their version with yours. Edit it to merge the two, or discard your edit to take theirs."
                      >
                        edited on both sides
                      </span>
                    )}
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
                <ReactionBar
                  reactions={c.reactions}
                  viewer={viewer}
                  onToggle={(emoji) => ops.onToggleReaction(c.id, emoji)}
                />
              </div>
              <div className="lr-comment-tools">
                {canEdit ? (
                  <>
                    <button className="lr-ghost-btn" onClick={() => setEditingId(c.id)}>
                      Edit
                    </button>
                    <button className="lr-ghost-btn" onClick={() => ops.onDelete(c.id)}>
                      Delete
                    </button>
                  </>
                ) : (
                  <span className="lr-badge lr-badge-readonly" title="Authored by someone else">
                    read-only
                  </span>
                )}
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
            draftKey={replyDraftKey}
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
