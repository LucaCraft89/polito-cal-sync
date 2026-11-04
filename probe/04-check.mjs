// Step 4 - final check before anything is committed. Reads probe/out/sanitized/*.json (and the two
// summary files) and prints what must be reviewed by a human. It changes nothing.
//   node probe/04-check.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leaks } from './lib/sanitize.mjs';
import { OUT_DIR } from './lib/out.mjs';

const dirs = ['sanitized', 'needs-review'].filter((d) => existsSync(join(OUT_DIR, d)));
if (dirs.length === 0) {
  console.log('No sanitized files yet. Run node probe/03-samples.mjs first.');
  process.exit(1);
}
let bad = 0;
for (const d of dirs) {
  for (const f of readdirSync(join(OUT_DIR, d)).filter((x) => x.endsWith('.json'))) {
    const text = readFileSync(join(OUT_DIR, d, f), 'utf8');
    const found = leaks(text);
    const kb = Math.round(text.length / 102.4) / 10;
    console.log(
      `${d}/${f}  ${kb} KB  ${found.length === 0 ? 'no automatic findings' : 'FINDINGS: ' + found.join(', ')}`,
    );
    if (found.length > 0 || d === 'needs-review') bad++;
    const values = [...text.matchAll(/"([^"\n]{3,80})"\s*[,\]\n}]/g)].map((m) => m[1]);
    const unknown = new Set(
      values.filter(
        (v) => !/^(id|person|text|key|n|[a-z]{3,16})-\d+$/.test(v) && !/^\d{4}-\d{2}-\d{2}/.test(v),
      ),
    );
    console.log(
      `   distinct values to eyeball: ${[...unknown].slice(0, 12).join(' | ') || '(none)'}${unknown.size > 12 ? ` ... +${unknown.size - 12}` : ''}`,
    );
  }
}
console.log(
  '\nHuman checklist (all must be YES before you copy anything to test/fixtures/polito/):',
);
for (const line of [
  'Open every file. Do you recognise any real course name, teacher, room, email, matricola, link?',
  'Dates: are they your real dates? If that bothers you, re-run 03 with --shift-days 30.',
  'No file contains a token, a password, or a long random-looking string.',
  'You are sending back only probe/out/sanitized/*.json and the summary JSON files - not raw output.',
  'probe/out/mfa-device.json (if it exists) is NOT among the files you send. It is a secret.',
])
  console.log(`  [ ] ${line}`);
process.exit(bad > 0 ? 2 : 0);
