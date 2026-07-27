// Syntax highlighting via Shiki (fine-grained core: curated languages + JS regex engine — no WASM,
// so no CSP relaxation). Uses the bundled `one-dark-pro` theme for dark, `light-plus` for light.
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { FileDiff, DiffRow } from '../../src/model/ReviewDiff';
import { LANGS, langForPath } from './lang';

export { langForPath };

export interface Tok {
  content: string;
  color?: string;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('shiki/themes/one-dark-pro.mjs'), import('shiki/themes/light-plus.mjs')],
      langs: LANGS.map((l) => l.load()),
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

export function activeTheme(): string {
  const c = document.body.classList;
  return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light-plus' : 'one-dark-pro';
}

/** Tokenize free text (e.g. a suggestion body) into per-line tokens. */
export function highlightLines(hl: HighlighterCore, lang: string, theme: string, text: string): Tok[][] {
  return toksFor(hl, lang, theme, text.split('\n'));
}

function toksFor(hl: HighlighterCore, lang: string, theme: string, lines: string[]): Tok[][] {
  if (lines.length === 0) return [];
  try {
    const { tokens } = hl.codeToTokens(lines.join('\n'), { lang, theme });
    return tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color })));
  } catch {
    return lines.map((l) => [{ content: l }]);
  }
}

/**
 * Whole-file highlighting: tokenize the full old/new file text, then clip to the diff by line number.
 * This gives every row the *file's* context (multi-line comments, template strings, enclosing scope) —
 * unlike `tokenizeFile`, which only sees the hunk. Falls back to per-line plain when a line is absent.
 */
export function tokenizeFullFiles(
  hl: HighlighterCore,
  theme: string,
  file: FileDiff,
  texts: { old: string; new: string },
): Map<DiffRow, Tok[] | null> {
  const map = new Map<DiffRow, Tok[] | null>();
  const lang = langForPath(file.path);
  if (!lang) return map;
  const newLines = texts.new ? toksFor(hl, lang, theme, texts.new.split('\n')) : [];
  const oldLines = texts.old ? toksFor(hl, lang, theme, texts.old.split('\n')) : [];
  for (const hunk of file.hunks) {
    for (const row of hunk.rows) {
      // context + add live on the new side; del lives on the old side.
      if (row.newLineNo != null) map.set(row, newLines[row.newLineNo - 1] ?? null);
      else if (row.oldLineNo != null) map.set(row, oldLines[row.oldLineNo - 1] ?? null);
      else map.set(row, null);
    }
  }
  return map;
}

/** Tokens for every diff row, keyed by row. Each hunk's old/new sides are tokenized as a block. */
export function tokenizeFile(hl: HighlighterCore, theme: string, file: FileDiff): Map<DiffRow, Tok[] | null> {
  const map = new Map<DiffRow, Tok[] | null>();
  const lang = langForPath(file.path);
  if (!lang) return map;
  for (const hunk of file.hunks) {
    const newToks = toksFor(
      hl,
      lang,
      theme,
      hunk.rows.filter((r) => r.type !== 'del').map((r) => r.text),
    );
    const oldToks = toksFor(
      hl,
      lang,
      theme,
      hunk.rows.filter((r) => r.type !== 'add').map((r) => r.text),
    );
    let ni = 0;
    let oi = 0;
    for (const row of hunk.rows) {
      if (row.type === 'add') map.set(row, newToks[ni++] ?? null);
      else if (row.type === 'del') map.set(row, oldToks[oi++] ?? null);
      else {
        map.set(row, newToks[ni] ?? oldToks[oi] ?? null);
        ni++;
        oi++;
      }
    }
  }
  return map;
}
