import { useState } from 'react';
import { Markdown } from './Markdown';
import type { PrDisplay } from '../../src/protocol/messages';

// Longer descriptions start clamped with a Show more/less toggle; short ones render in full.
const CLAMP_CHARS = 280;
const CLAMP_LINES = 8;

/**
 * A card with the pull request's title, state, author, link, and description. A header chevron collapses
 * the whole card to its title row (like a comment thread); within an expanded card, a long description is
 * further clamped with Show more/less.
 */
export function PrDescription({ pr }: { pr: PrDisplay }) {
  const body = pr.body?.trim() ?? '';
  const clampable = body.length > CLAMP_CHARS || body.split('\n').length > CLAMP_LINES;
  const [collapsed, setCollapsed] = useState(false);
  const [showFull, setShowFull] = useState(false);
  return (
    <div className="lr-pr-card">
      <div className="lr-pr-card-head">
        <button
          className="lr-thread-toggle"
          aria-label={collapsed ? 'Expand description' : 'Collapse description'}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="lr-pr-card-title">{pr.title || 'Pull request'}</span>
        {pr.number != null && <span className="lr-pr-card-num">#{pr.number}</span>}
        {pr.state && <span className={`lr-pr-state lr-pr-state-${pr.state}`}>{pr.state}</span>}
        {pr.author && <span className="lr-pr-card-author">by {pr.author}</span>}
        {pr.url && (
          <a className="lr-link lr-pr-card-link" href={pr.url}>
            View on GitHub
          </a>
        )}
      </div>
      {!collapsed &&
        (body ? (
          <div className={`lr-pr-card-body lr-markdown${clampable && !showFull ? ' lr-pr-card-clamp' : ''}`}>
            <Markdown>{body}</Markdown>
          </div>
        ) : (
          <div className="lr-pr-card-empty">No description provided.</div>
        ))}
      {!collapsed && clampable && (
        <button className="lr-link lr-pr-card-toggle" onClick={() => setShowFull((e) => !e)}>
          {showFull ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
