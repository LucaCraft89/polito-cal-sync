import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'out');

/** Writes JSON under probe/out (git-ignored), file mode 0600. Returns the path. */
export function writeOut(relative, data) {
  const path = join(OUT_DIR, relative);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
