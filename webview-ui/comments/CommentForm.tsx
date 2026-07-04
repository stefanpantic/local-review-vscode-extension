import { useState } from 'react';

/** A textarea + submit/cancel. ⌘/Ctrl+Enter submits, Esc cancels. Used for new comments, replies, and edits. */
export function CommentForm({
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initial?: string;
  submitLabel: string;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState(initial);
  const submit = () => {
    const b = body.trim();
    if (b) onSubmit(b);
  };
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
      <div className="lr-comment-actions">
        <button className="lr-btn lr-btn-primary" disabled={!body.trim()} onClick={submit}>
          {submitLabel}
        </button>
        {onCancel && (
          <button className="lr-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
