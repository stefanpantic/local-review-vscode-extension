import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info' };

/** Extension host bundle (Node). */
const host = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  // In the Node extension host `navigator` is a global getter that throws on access (a VS Code migration
  // nudge). Some bundled deps probe `typeof navigator` for environment detection; fold it to undefined so
  // that probe takes its normal Node path instead of throwing at module load.
  define: { navigator: 'undefined' },
};

/** Webview UI bundle (browser). CSS imported from main.tsx is emitted to dist/webview.css. */
const web = {
  ...common,
  entryPoints: ['webview-ui/main.tsx'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.css': 'css' },
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(host), esbuild.context(web)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching…');
} else {
  await Promise.all([esbuild.build(host), esbuild.build(web)]);
  console.log('[esbuild] build complete');
}
