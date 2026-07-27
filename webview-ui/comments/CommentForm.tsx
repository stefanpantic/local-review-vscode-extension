import { useState } from 'react';

/**
 * Text typed but not yet submitted, held outside React. A background sync or a diff refresh can re-render
 * the thread list and unmount an open composer, and losing what someone was midway through writing is the
 * worst thing a sync can do. Keyed per composer, restored when it comes back, dropped once it is sent.
 */
const drafts = new Map<string, { body: string; suggestion?: string }>();

/** Whether a composer has unsent text, so its container can reopen it after a remount. */
export function hasDraft(key: string): boolean {
  const d = drafts.get(key);
  return !!d && (d.body.length > 0 || (d.suggestion?.length ?? 0) > 0);
}

/**
 * Comment editor: a body textarea plus an optional "Suggest change" code editor (pre-filled with the
 * target range's current code). Returns `suggestion` as a string (set), null (cleared), or undefined (untouched).
 * ⌘/Ctrl+Enter submits, Esc cancels. Passing `draftKey` preserves unsent text across a remount.
 */
export function CommentForm({
  initial = '',
  initialSuggestion,
  suggestBase,
  canSuggest = false,
  submitLabel,
  draftKey,
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initial?: string;
  initialSuggestion?: string;
  suggestBase?: string;
  canSuggest?: boolean;
  submitLabel: string;
  draftKey?: string;
  onSubmit: (body: string, suggestion: string | null | undefined) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const saved = draftKey ? drafts.get(draftKey) : undefined;
  const [body, setBody] = useState(saved?.body ?? initial);
  const [showSuggest, setShowSuggest] = useState(saved?.suggestion != null || initialSuggestion != null);
  const [suggestText, setSuggestText] = useState(saved?.suggestion ?? initialSuggestion ?? '');
  const hadSuggestion = initialSuggestion != null;

  /** Mirror the current text into the draft store on every keystroke, so an unmount cannot take it. */
  const remember = (next: { body?: string; suggestion?: string }): void => {
    if (!draftKey) return;
    const cur = drafts.get(draftKey) ?? { body, suggestion: showSuggest ? suggestText : undefined };
    drafts.set(draftKey, { ...cur, ...next });
  };
  const forget = (): void => {
    if (draftKey) drafts.delete(draftKey);
  };

  const suggestionUnchanged = showSuggest && suggestText === (suggestBase ?? '');
  const canSubmit = (body.trim().length > 0 || showSuggest) && !suggestionUnchanged;
  const submit = () => {
    if (!canSubmit) return;
    forget();
    onSubmit(body.trim(), showSuggest ? suggestText : hadSuggestion ? null : undefined);
  };
  const cancel = () => {
    forget();
    onCancel?.();
  };
  const toggleSuggest = () =>
    setShowSuggest((on) => {
      if (!on && !suggestText) setSuggestText(suggestBase ?? '');
      return !on;
    });

  return (
    <div className="lr-comment-form">
      <textarea
        className="lr-comment-input"
        value={body}
        autoFocus={autoFocus}
        placeholder="Leave a comment"
        onChange={(e) => {
          setBody(e.target.value);
          remember({ body: e.target.value });
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
          else if (e.key === 'Escape') cancel();
        }}
      />
      {showSuggest && (
        <textarea
          className="lr-suggest-input"
          value={suggestText}
          spellCheck={false}
          placeholder="Suggested replacement"
          onChange={(e) => {
            setSuggestText(e.target.value);
            remember({ suggestion: e.target.value });
          }}
        />
      )}
      {suggestionUnchanged && <div className="lr-form-hint">Suggestion matches the original. Edit it to post.</div>}
      <div className="lr-comment-actions">
        <button className="lr-btn lr-btn-primary" disabled={!canSubmit} onClick={submit}>
          {submitLabel}
        </button>
        {canSuggest && (
          <button className="lr-btn" onClick={toggleSuggest}>
            {showSuggest ? 'Remove suggestion' : 'Suggest change'}
          </button>
        )}
        {onCancel && (
          <button className="lr-btn" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
