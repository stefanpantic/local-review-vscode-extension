// Which Shiki grammars are bundled, and which paths map to them. One table, so a grammar can never be
// registered without its file extensions (or the reverse) — that mismatch renders as silent plain text.
// Type-only Shiki import: erased at compile time, so this module pulls in no highlighter at runtime.
import type { LanguageInput } from 'shiki/core';

interface LangEntry {
  /** Static `import()` so the bundler can inline the grammar. */
  load: () => LanguageInput;
  /** Grammar's own registered name — the id passed to `codeToTokens`, not an alias. */
  name: string;
  /** Lowercase extensions, without the dot. */
  exts: readonly string[];
  /** Lowercase whole filenames, for files that carry no extension. */
  files?: readonly string[];
}

export const LANGS: readonly LangEntry[] = [
  { load: () => import('shiki/langs/typescript.mjs'), name: 'typescript', exts: ['ts', 'mts', 'cts'] },
  { load: () => import('shiki/langs/tsx.mjs'), name: 'tsx', exts: ['tsx'] },
  { load: () => import('shiki/langs/javascript.mjs'), name: 'javascript', exts: ['js', 'mjs', 'cjs'] },
  { load: () => import('shiki/langs/jsx.mjs'), name: 'jsx', exts: ['jsx'] },
  { load: () => import('shiki/langs/json.mjs'), name: 'json', exts: ['json', 'jsonc'] },
  { load: () => import('shiki/langs/python.mjs'), name: 'python', exts: ['py'] },
  { load: () => import('shiki/langs/go.mjs'), name: 'go', exts: ['go'] },
  { load: () => import('shiki/langs/rust.mjs'), name: 'rust', exts: ['rs'] },
  { load: () => import('shiki/langs/java.mjs'), name: 'java', exts: ['java'] },
  { load: () => import('shiki/langs/c.mjs'), name: 'c', exts: ['c', 'h'] },
  { load: () => import('shiki/langs/cpp.mjs'), name: 'cpp', exts: ['cc', 'cpp', 'cxx', 'hpp', 'hh'] },
  { load: () => import('shiki/langs/csharp.mjs'), name: 'csharp', exts: ['cs'] },
  { load: () => import('shiki/langs/ruby.mjs'), name: 'ruby', exts: ['rb'] },
  { load: () => import('shiki/langs/php.mjs'), name: 'php', exts: ['php'] },
  { load: () => import('shiki/langs/html.mjs'), name: 'html', exts: ['html', 'htm'] },
  { load: () => import('shiki/langs/css.mjs'), name: 'css', exts: ['css'] },
  { load: () => import('shiki/langs/scss.mjs'), name: 'scss', exts: ['scss'] },
  { load: () => import('shiki/langs/shellscript.mjs'), name: 'shellscript', exts: ['sh', 'bash', 'zsh'] },
  { load: () => import('shiki/langs/yaml.mjs'), name: 'yaml', exts: ['yml', 'yaml'] },
  { load: () => import('shiki/langs/markdown.mjs'), name: 'markdown', exts: ['md', 'markdown'] },
  { load: () => import('shiki/langs/sql.mjs'), name: 'sql', exts: ['sql'] },
  { load: () => import('shiki/langs/kotlin.mjs'), name: 'kotlin', exts: ['kt', 'kts'] },
  { load: () => import('shiki/langs/swift.mjs'), name: 'swift', exts: ['swift'] },
  { load: () => import('shiki/langs/scala.mjs'), name: 'scala', exts: ['scala', 'sc'] },
  { load: () => import('shiki/langs/groovy.mjs'), name: 'groovy', exts: ['groovy', 'gradle'] },
  { load: () => import('shiki/langs/toml.mjs'), name: 'toml', exts: ['toml'] },
  { load: () => import('shiki/langs/xml.mjs'), name: 'xml', exts: ['xml'] },
  // `dockerfile` and `properties` are Shiki aliases for these two, so register the canonical names.
  { load: () => import('shiki/langs/docker.mjs'), name: 'docker', exts: [], files: ['dockerfile'] },
  { load: () => import('shiki/langs/ini.mjs'), name: 'ini', exts: ['ini', 'properties', 'cfg'] },
  { load: () => import('shiki/langs/hcl.mjs'), name: 'hcl', exts: ['hcl'] },
  { load: () => import('shiki/langs/terraform.mjs'), name: 'terraform', exts: ['tf', 'tfvars'] },
  { load: () => import('shiki/langs/graphql.mjs'), name: 'graphql', exts: ['graphql', 'gql'] },
  { load: () => import('shiki/langs/proto.mjs'), name: 'proto', exts: ['proto'] },
];

const EXT_LANG: Record<string, string> = {};
const FILENAME_LANG: Record<string, string> = {};
for (const lang of LANGS) {
  for (const ext of lang.exts) EXT_LANG[ext] = lang.name;
  for (const file of lang.files ?? []) FILENAME_LANG[file] = lang.name;
}

/**
 * The grammar to tokenize a path with, or undefined when none is bundled (the caller then renders plain
 * text). Matches on the basename so a nested path resolves the same as a root-level one, trying whole
 * filenames first for the extensionless ones.
 */
export function langForPath(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName = FILENAME_LANG[base];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? undefined : EXT_LANG[base.slice(dot + 1)];
}
