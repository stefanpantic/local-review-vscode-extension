import { useState } from 'react';

/**
 * Comment editor: a body textarea plus an optional "Suggest change" code editor (pre-filled with the
 * target range's current code). Returns `suggestion` as a string (set), null (cleared), or undefined (untouched).
 * ⌘/Ctrl+Enter submits, Esc cancels.
 */
export function CommentForm({
  initial = '',
  initialSuggestion,
  suggestBase,
  canSuggest = false,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initial?: string;
  initialSuggestion?: string;
  suggestBase?: string;
  canSuggest?: boolean;
  submitLabel: string;
  onSubmit: (body: string, suggestion: string | null | undefined) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState(initial);
  const [showSuggest, setShowSuggest] = useState(initialSuggestion != null);
  const [suggestText, setSuggestText] = useState(initialSuggestion ?? '');
  const hadSuggestion = initialSuggestion != null;

  const suggestionUnchanged = showSuggest && suggestText === (suggestBase ?? '');
  const canSubmit = (body.trim().length > 0 || showSuggest) && !suggestionUnchanged;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(body.trim(), showSuggest ? suggestText : hadSuggestion ? null : undefined);
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
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
          else if (e.key === 'Escape') onCancel?.();
        }}
      />
      {showSuggest && (
        <textarea
          className="lr-suggest-input"
          value={suggestText}
          spellCheck={false}
          placeholder="Suggested replacement"
          onChange={(e) => setSuggestText(e.target.value)}
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
          <button className="lr-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
