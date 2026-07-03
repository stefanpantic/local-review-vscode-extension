// Minimal type shim for `parse-diff` (the package ships no types).
// CJS function-with-namespace pattern so both the default value and the types resolve.
declare module 'parse-diff' {
  function parse(input: string): parse.File[];
  namespace parse {
    interface Change {
      type: 'normal' | 'add' | 'del';
      content: string; // full line content INCLUDING the leading +/-/space prefix
      ln?: number; // add: new line number; del: old line number
      ln1?: number; // normal: old line number
      ln2?: number; // normal: new line number
      normal?: boolean;
      add?: boolean;
      del?: boolean;
    }
    interface Chunk {
      content: string; // the "@@ -a,b +c,d @@ ..." header line
      changes: Change[];
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
    }
    interface File {
      chunks: Chunk[];
      deletions: number;
      additions: number;
      from?: string;
      to?: string;
      index?: string[];
      new?: boolean;
      deleted?: boolean;
      oldMode?: string;
      newMode?: string;
      newFileMode?: string;
      deletedFileMode?: string;
      binary?: boolean;
    }
  }
  export = parse;
}
