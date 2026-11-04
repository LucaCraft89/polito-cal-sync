import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/util/errors.js';

const doc = readFileSync(new URL('../docs/ERRORS.md', import.meta.url), 'utf8');
const documented = [...doc.matchAll(/^## (E_[A-Z_]+)\s*$/gm)].map((m) => m[1]);

describe('docs/ERRORS.md', () => {
  it('documents every error code', () => {
    for (const code of ERROR_CODES) expect(documented, code).toContain(code);
  });
  it('documents no code that does not exist', () => {
    for (const code of documented)
      expect(ERROR_CODES as readonly (string | undefined)[], code).toContain(code);
  });
  it('gives every section what / why / what to do', () => {
    const sections = doc.split(/^## /m).slice(1);
    for (const s of sections) {
      expect(s, s.split('\n')[0]).toContain('**What happened:**');
      expect(s).toContain('**Why:**');
      expect(s).toContain('**What to do:**');
    }
  });
});
