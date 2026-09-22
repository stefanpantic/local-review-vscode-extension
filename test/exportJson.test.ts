import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportReviewJson, type ReviewExportJson } from '../src/export/exportJson';
import { exportReviewMarkdown } from '../src/export/exportMarkdown';
import type { ExportMeta, ExportOpts } from '../src/export/common';
import type { Comment, CommentThread, FileAnchor, LineAnchor } from '../src/model/Comment';

const META: ExportMeta = {
  name: 'Review 1',
  branch: 'feature/x',
  source: 'Uncommitted changes',
  repoName: 'myrepo',
  generatedAt: '2026-07-04T12:00:00.000Z',
  lineReferences: 'as-reviewed',
};

const CURRENT: ExportMeta = { ...META, lineReferences: 'current' };

const HUNK = '@@ -40,3 +40,4 @@\n const a = 1;\n+const b = 2;';

function comment(body: string, over?: Partial<Comment>): Comment {
  return {
    id: `c${body}`,
    body,
    createdAt: '2026-07-04T11:00:00.000Z',
    updatedAt: '2026-07-04T11:00:00.000Z',
    author: 'tester',
    ...over,
  };
}

function thread(over?: Partial<CommentThread>): CommentThread {
  return {
    id: 't1',
    anchor: {
      kind: 'line',
      filePath: 'src/a.ts',
      side: 'new',
      lineNumber: 42,
      line: 'const a = 1;',
      source: 'worktree-vs-head',
      originalDiffHunk: HUNK,
    },
    comments: [comment('Looks off')],
    resolved: false,
    ...over,
  };
}

const lineAnchor = (over: Partial<LineAnchor>): LineAnchor => ({ ...(thread().anchor as LineAnchor), ...over });
const fileAnchor = (filePath: string): FileAnchor => ({ kind: 'file', filePath, source: 'worktree-vs-head' });

function run(threads: CommentThread[], opts?: ExportOpts, meta?: ExportMeta): ReviewExportJson {
  return JSON.parse(exportReviewJson(meta ?? META, threads, opts ?? { scope: 'all' })) as ReviewExportJson;
}

test('version, review block, and summary counts', () => {
  const doc = run([
    thread(),
    thread({ id: 't2', resolved: true }),
    thread({ id: 't3', anchor: lineAnchor({ filePath: 'src/b.ts' }) }),
  ]);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.review, {
    name: 'Review 1',
    repo: 'myrepo',
    branch: 'feature/x',
    source: 'Uncommitted changes',
    lineReferences: 'as-reviewed',
    generatedAt: '2026-07-04T12:00:00.000Z',
  });
  assert.deepEqual(doc.summary, { threads: 3, files: 2, unresolved: 2 });
});

test('lineReferences comes from the meta', () => {
  assert.equal(run([thread()], undefined, { ...META, lineReferences: 'current' }).review.lineReferences, 'current');
});

test('single-line thread has every field and leaves out PR write-back state', () => {
  const withWriteBack = thread({
    remoteThreadId: 'PRRT_1',
    remoteRootId: '101',
    remoteResolved: false,
    comments: [
      comment('Looks off', {
        remoteId: '101',
        remoteBody: 'Looks off',
        remoteUrl: 'https://x',
        localOnly: true,
        conflict: true,
      }),
    ],
  });
  assert.deepEqual(run([withWriteBack]).threads, [
    {
      id: 't1',
      kind: 'line',
      file: 'src/a.ts',
      oldPath: null,
      side: 'new',
      startLine: 42,
      endLine: 42,
      status: null,
      resolved: false,
      diffHunk: HUNK,
      comments: [
        {
          id: 'cLooks off',
          author: 'tester',
          body: 'Looks off',
          createdAt: '2026-07-04T11:00:00.000Z',
          suggestion: null,
          reactions: {},
        },
      ],
    },
  ]);
});

test('range on the old side', () => {
  const [t] = run([thread({ anchor: lineAnchor({ side: 'old', lineNumber: 10, endLineNumber: 13 }) })]).threads;
  assert.equal(t.side, 'old');
  assert.equal(t.startLine, 10);
  assert.equal(t.endLine, 13);
});

test('a thread made on a renamed file keeps its old path', () => {
  const [t] = run([thread({ anchor: lineAnchor({ oldPath: 'src/old.ts' }) })]).threads;
  assert.equal(t.file, 'src/a.ts');
  assert.equal(t.oldPath, 'src/old.ts');
});

test('a current export after a rename uses the new path and lists the commented path as the old one', () => {
  const [t] = run(
    [thread({ status: 'moved', resolvedLine: 1, resolvedEndLine: 1, resolvedPath: 'src/renamed.ts' })],
    undefined,
    CURRENT,
  ).threads;
  assert.equal(t.file, 'src/renamed.ts');
  assert.equal(t.oldPath, 'src/a.ts');
  assert.equal(t.startLine, 1);
});

test('an empty captured hunk exports as null', () => {
  const [t] = run([thread({ anchor: lineAnchor({ originalDiffHunk: '' }) })]).threads;
  assert.equal(t.diffHunk, null);
});

test('file-level thread has null side, lines, and diffHunk', () => {
  const [t] = run([thread({ anchor: fileAnchor('src/a.ts') })]).threads;
  assert.equal(t.kind, 'file');
  assert.equal(t.file, 'src/a.ts');
  assert.equal(t.side, null);
  assert.equal(t.startLine, null);
  assert.equal(t.endLine, null);
  assert.equal(t.diffHunk, null);
});

test('replies keep their order, ids, and authors', () => {
  const [t] = run([
    thread({ comments: [comment('root'), comment('first', { author: 'AI Agent' }), comment('second')] }),
  ]).threads;
  assert.deepEqual(
    t.comments.map((c) => [c.id, c.author, c.body]),
    [
      ['croot', 'tester', 'root'],
      ['cfirst', 'AI Agent', 'first'],
      ['csecond', 'tester', 'second'],
    ],
  );
});

test('a suggestion has only the original and the replacement', () => {
  const suggestion = { original: 'const a = 1;', replacement: 'const a = 2;' };
  const stored = { ...suggestion, draft: true } as Comment['suggestion'];
  const [t] = run([thread({ comments: [comment('use this', { suggestion: stored }), comment('no change')] })]).threads;
  assert.deepEqual(t.comments[0].suggestion, suggestion);
  assert.equal(t.comments[1].suggestion, null);
});

test('reactions follow display order and drop empty entries', () => {
  const [t] = run([
    thread({
      comments: [
        comment('root', { reactions: { '🎉': ['bob'], '👀': [], '👍': ['alice', 'AI Agent'] } }),
        comment('reply'),
      ],
    }),
  ]).threads;
  assert.deepEqual(t.comments[0].reactions, { '👍': ['alice', 'AI Agent'], '🎉': ['bob'] });
  assert.deepEqual(Object.keys(t.comments[0].reactions), ['👍', '🎉']);
  assert.deepEqual(t.comments[1].reactions, {});
});

test('reactions come from the current state, not the imported baseline', () => {
  const [t] = run([
    thread({ comments: [comment('root', { reactions: { '👍': ['alice'] }, remoteReactions: { '👎': ['carol'] } })] }),
  ]).threads;
  assert.deepEqual(t.comments[0].reactions, { '👍': ['alice'] });
});

test('unresolved scope drops resolved threads', () => {
  const doc = run([thread({ id: 't1', resolved: true }), thread({ id: 't2' })], { scope: 'unresolved' });
  assert.deepEqual(
    doc.threads.map((t) => t.id),
    ['t2'],
  );
  assert.deepEqual(doc.summary, { threads: 1, files: 1, unresolved: 1 });
});

test('file scope keeps only the chosen file', () => {
  const doc = run([thread({ id: 't1' }), thread({ id: 't2', anchor: lineAnchor({ filePath: 'src/b.ts' }) })], {
    scope: 'file',
    file: 'src/b.ts',
  });
  assert.deepEqual(
    doc.threads.map((t) => t.id),
    ['t2'],
  );
});

test('re-anchored threads use the resolved lines and status', () => {
  const [t] = run(
    [thread({ anchor: lineAnchor({ endLineNumber: 44 }), status: 'moved', resolvedLine: 55, resolvedEndLine: 57 })],
    undefined,
    CURRENT,
  ).threads;
  assert.equal(t.status, 'moved');
  assert.equal(t.startLine, 55);
  assert.equal(t.endLine, 57);
});

test('outdated threads fall back to the anchor lines', () => {
  const [t] = run(
    [
      thread({
        anchor: lineAnchor({ endLineNumber: 44 }),
        status: 'outdated',
        resolvedLine: null,
        resolvedEndLine: null,
      }),
    ],
    undefined,
    CURRENT,
  ).threads;
  assert.equal(t.status, 'outdated');
  assert.equal(t.startLine, 42);
  assert.equal(t.endLine, 44);
});

test('threads sort by file, then start line, then end line', () => {
  const doc = run([
    thread({ id: 'b', anchor: lineAnchor({ filePath: 'src/b.ts', lineNumber: 1 }) }),
    thread({ id: 'a-long', anchor: lineAnchor({ lineNumber: 10, endLineNumber: 20 }) }),
    thread({ id: 'a-late', anchor: lineAnchor({ lineNumber: 30 }) }),
    thread({ id: 'a-short', anchor: lineAnchor({ lineNumber: 10, endLineNumber: 12 }) }),
  ]);
  assert.deepEqual(
    doc.threads.map((t) => t.id),
    ['a-short', 'a-long', 'a-late', 'b'],
  );
});

test('a current export sorts by the re-anchored lines', () => {
  const doc = run(
    [
      thread({ id: 'first-anchored', anchor: lineAnchor({ lineNumber: 10 }), status: 'moved', resolvedLine: 90 }),
      thread({ id: 'last-anchored', anchor: lineAnchor({ lineNumber: 80 }), status: 'moved', resolvedLine: 20 }),
    ],
    undefined,
    CURRENT,
  );
  assert.deepEqual(
    doc.threads.map((t) => t.id),
    ['last-anchored', 'first-anchored'],
  );
});

test('a file-level thread sorts first in its file and is anchored in a current export', () => {
  const doc = run(
    [
      thread({ id: 'line', anchor: lineAnchor({ lineNumber: 1 }), status: 'anchored', resolvedLine: 1 }),
      thread({ id: 'file', anchor: fileAnchor('src/a.ts'), status: 'anchored', resolvedLine: null }),
    ],
    undefined,
    CURRENT,
  );
  assert.deepEqual(
    doc.threads.map((t) => [t.id, t.status]),
    [
      ['file', 'anchored'],
      ['line', 'anchored'],
    ],
  );
});

test('paths sort by code unit, not by locale', () => {
  const doc = run([
    thread({ id: 'lower', anchor: lineAnchor({ filePath: 'src/a.ts' }) }),
    thread({ id: 'upper', anchor: lineAnchor({ filePath: 'src/B.ts' }) }),
    thread({ id: 'z', anchor: lineAnchor({ filePath: 'src/z.ts' }) }),
    thread({ id: 't', anchor: lineAnchor({ filePath: 'src/t.ts' }) }),
  ]);
  assert.deepEqual(
    doc.threads.map((t) => t.id),
    ['upper', 'lower', 't', 'z'],
  );
});

test('the JSON summary matches the Markdown header counts', () => {
  const threads = [
    thread({ id: 't1' }),
    thread({ id: 't2', resolved: true }),
    thread({ id: 't3', anchor: fileAnchor('src/b.ts') }),
    thread({ id: 't4', anchor: lineAnchor({ filePath: 'src/b.ts' }), resolved: true }),
  ];
  const { summary } = run(threads);
  const md = exportReviewMarkdown(META, threads, { scope: 'all' });
  const header = /(\d+) comment threads? across (\d+) files? · (\d+) unresolved/.exec(md);
  assert.ok(header);
  assert.deepEqual(summary, {
    threads: Number(header[1]),
    files: Number(header[2]),
    unresolved: Number(header[3]),
  });
  assert.deepEqual(summary, { threads: 4, files: 2, unresolved: 2 });
});

test('empty selection returns an empty string', () => {
  assert.equal(exportReviewJson(META, [], { scope: 'all' }), '');
  assert.equal(exportReviewJson(META, [thread({ resolved: true })], { scope: 'unresolved' }), '');
});

test('output is indented with 2 spaces and ends with a newline', () => {
  const out = exportReviewJson(META, [thread()], { scope: 'all' });
  assert.ok(out.startsWith('{\n  "version": 1,\n'));
  assert.ok(out.endsWith('}\n'));
});
