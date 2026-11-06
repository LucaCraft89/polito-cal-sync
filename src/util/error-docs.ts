import { readFileSync } from 'node:fs';

export interface ErrorDoc {
  what: string;
  why: string;
  action: string;
}

let cache: Map<string, ErrorDoc> | undefined;

/** Markdown to plain text for a page that shows text only. */
const plain = (s: string): string =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The generic what / why / what-to-do of an error code, read from docs/ERRORS.md (the one place the texts are
 * written down; a test keeps every code in it). Used where only a CODE was saved, e.g. the history of runs.
 * Without the file (it is not part of the package) the answer is undefined and the caller falls back to the code.
 */
export function errorDoc(code: string, file?: URL): ErrorDoc | undefined {
  if (!cache) {
    cache = new Map();
    try {
      const text = readFileSync(file ?? new URL('../../docs/ERRORS.md', import.meta.url), 'utf8');
      for (const section of text.split(/^## /m).slice(1)) {
        const name = section.split('\n', 1)[0]?.trim();
        const m =
          /\*\*What happened:\*\*([\s\S]*?)\*\*Why:\*\*([\s\S]*?)\*\*What to do:\*\*([\s\S]*?)(?=\n\n|$)/.exec(
            section,
          );
        if (name && m)
          cache.set(name, {
            what: plain(m[1] ?? ''),
            why: plain(m[2] ?? ''),
            action: plain(m[3] ?? ''),
          });
      }
    } catch {
      /* no docs next to the program: callers show the code only */
    }
  }
  return cache.get(code);
}
