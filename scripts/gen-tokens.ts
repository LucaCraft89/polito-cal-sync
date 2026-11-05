import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTokensCss } from './palette.js';

/** Regenerates web/assets/tokens.css (run: pnpm tokens). A test fails when the committed file differs. */
const out = fileURLToPath(new URL('../web/assets/tokens.css', import.meta.url));
writeFileSync(out, buildTokensCss());
console.log(`wrote ${out}`);
