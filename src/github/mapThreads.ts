// Map GitHub review threads into the neutral comment model. Pure & synchronous — unit-tested with fixtures.
// Anchors are derived from the loaded diff exactly like locally created comments, so the existing
// content-match engine decides anchored/moved/outdated for imported threads too.
import type { Anchor, Comment, CommentThread, FileAnchor, LineAnchor, ReactionEmoji } from '../model/Comment';
import { UNKNOWN_AUTHOR, REACTION_EMOJIS } from '../model/Comment';
import type { ReviewDiff, Side } from '../model/ReviewDiff';
import { createAnchor, rangeText } from '../comments/anchoring';
import type { GhReviewComment, GhReviewThread } from './types';

const GITHUB_TO_EMOJI: Record<string, ReactionEmoji> = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  EYES: '👀',
  HEART: '❤️',
  HOORAY: '🎉',
};

export const EMOJI_TO_GITHUB: Record<ReactionEmoji, string> = Object.fromEntries(
  REACTION_EMOJIS.map((e) => [e, Object.entries(GITHUB_TO_EMOJI).find(([, v]) => v === e)![0]]),
) as Record<ReactionEmoji, string>;

function groupReactions(
  raw: Array<{ content: string; login: string }>,
): Partial<Record<ReactionEmoji, string[]>> | undefined {
  const out: Partial<Record<ReactionEmoji, string[]>> = {};
  for (const r of raw) {
    const emoji = GITHUB_TO_EMOJI[r.content];
    if (!emoji) continue;
    (out[emoji] ??= []).push(r.login);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Turn GitHub review threads into comment threads anchored against `diff`. */
export function mapThreads(threads: GhReviewThread[], diff: ReviewDiff): CommentThread[] {
  const out: CommentThread[] = [];
  for (const t of threads) {
    const root = t.comments[0];
    if (!root) continue;
    const side: Side = t.diffSide === 'LEFT' ? 'old' : 'new';
    const lastLine = t.line ?? t.originalLine;
    if (lastLine == null && t.subjectType !== 'FILE') continue; // no line to anchor on and not file-level
    let anchor: Anchor;
    let comments: Comment[];
    if (lastLine == null) {
      // File-level thread: anchor to the file, not a line.
      const fileAnchor: FileAnchor = { kind: 'file', filePath: t.path, source: diff.source };
      anchor = fileAnchor;
      comments = t.comments.map((c) => mapFileComment(c));
    } else {
      const firstLine = t.startLine ?? t.originalStartLine ?? lastLine;
      anchor = importAnchor(diff, t.path, root.diffHunk, t.line != null, side, firstLine, lastLine);
      comments = t.comments.map((c) => mapComment(c, diff, t.path, side, firstLine, lastLine));
    }
    const thread: CommentThread = {
      id: t.id,
      anchor,
      comments,
      resolved: t.isResolved,
      remoteThreadId: t.id,
      remoteResolved: t.isResolved,
    };
    if (root.databaseId != null) thread.remoteRootId = String(root.databaseId);
    out.push(thread);
  }
  return out;
}

/**
 * Build the durable anchor. For a comment GitHub still maps onto the head we diffed, reuse `createAnchor`
 * so the line text and hunk come from the loaded diff (identical to a locally created comment). When the
 * position is not in our diff, or GitHub marks the comment outdated, key on the content GitHub captured in
 * its diff hunk instead of whatever line now occupies that number — the match engine then decides
 * moved-vs-outdated, so a stale comment can never latch onto an unrelated current line.
 */
function importAnchor(
  diff: ReviewDiff,
  path: string,
  diffHunk: string,
  current: boolean,
  side: Side,
  firstLine: number,
  lastLine: number,
): LineAnchor {
  const anchor = createAnchor(diff, {
    kind: 'line',
    filePath: path,
    side,
    startLine: firstLine,
    endLine: lastLine !== firstLine ? lastLine : undefined,
  }) as LineAnchor;
  if (!current || anchor.line === '') {
    const text = hunkLineText(diffHunk, side, firstLine);
    if (text != null) {
      anchor.line = text;
      anchor.originalDiffHunk = diffHunk;
    } else if (diffHunk) {
      anchor.originalDiffHunk = diffHunk;
    }
  }
  return anchor;
}

function mapFileComment(c: GhReviewComment): Comment {
  const comment: Comment = {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    author: c.author ?? UNKNOWN_AUTHOR,
  };
  if (c.databaseId != null) comment.remoteId = String(c.databaseId);
  if (c.url) comment.remoteUrl = c.url;
  if (c.isPending) comment.remotePending = true;
  comment.remoteBody = comment.body;
  const reactions = groupReactions(c.reactions);
  if (reactions) {
    comment.reactions = reactions;
    comment.remoteReactions = structuredClone(reactions);
  }
  return comment;
}

function mapComment(
  c: GhReviewComment,
  diff: ReviewDiff,
  path: string,
  side: Side,
  firstLine: number,
  lastLine: number,
): Comment {
  const parsed = parseSuggestion(c.body);
  const comment: Comment = {
    id: c.id,
    body: parsed ? parsed.body : c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    author: c.author ?? UNKNOWN_AUTHOR,
  };
  if (c.databaseId != null) comment.remoteId = String(c.databaseId);
  if (c.url) comment.remoteUrl = c.url;
  if (c.isPending) comment.remotePending = true;
  comment.remoteBody = comment.body; // baseline: a later change to `body` is a pending edit
  const reactions = groupReactions(c.reactions);
  if (reactions) {
    comment.reactions = reactions;
    comment.remoteReactions = structuredClone(reactions);
  }
  if (parsed) {
    const original = rangeText(diff, path, side, firstLine, lastLine);
    comment.suggestion = { original, replacement: parsed.replacement };
  }
  return comment;
}

/**
 * Extract the first fenced ```suggestion block: the block becomes the structured replacement and is
 * stripped from the prose body, mirroring how locally authored suggestions are stored (body + suggestion
 * kept apart). Any further suggestion blocks are left inline in the body.
 */
export function parseSuggestion(body: string): { body: string; replacement: string } | null {
  const m = /```suggestion[^\n]*\n([\s\S]*?)\n?```/.exec(body);
  if (!m) return null;
  const stripped = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim();
  return { body: stripped, replacement: m[1] };
}

/** Text of the line at `lineNo` on `side` within a single unified-diff hunk, or null if the hunk lacks it. */
function hunkLineText(hunk: string, side: Side, lineNo: number): string | null {
  const lines = hunk.split('\n');
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[0] ?? '');
  if (!m) return null;
  let oldNo = parseInt(m[1], 10);
  let newNo = parseInt(m[2], 10);
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === '') continue;
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '+') {
      if (side === 'new' && newNo === lineNo) return text;
      newNo++;
    } else if (sign === '-') {
      if (side === 'old' && oldNo === lineNo) return text;
      oldNo++;
    } else {
      if ((side === 'new' && newNo === lineNo) || (side === 'old' && oldNo === lineNo)) return text;
      oldNo++;
      newNo++;
    }
  }
  return null;
}
