import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDirPrivate, writePrivateFile } from '../util/files.js';

export const AUDIT_FILE = 'audit.log';
const MAX_BYTES = 256 * 1024;
const KEEP_LINES = 500;

export type AuditDetail = Record<string, string | number | boolean | string[]>;

export interface AuditEntry {
  at: string;
  action: string;
  [field: string]: unknown;
}

/**
 * What was changed through the UI, and when: `DATA_DIR/audit.log`, one JSON object per line, mode 0600.
 * It records WHICH settings changed, never their values (so a secret cannot get here by mistake), and
 * only short plain details such as a setting key or a source address.
 */
export class AuditLog {
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(dataDir, AUDIT_FILE);
  }

  append(action: string, detail: AuditDetail = {}): void {
    ensureDirPrivate(join(this.file, '..'));
    appendFileSync(
      this.file,
      `${JSON.stringify({ at: this.now().toISOString(), action, ...detail })}\n`,
      {
        mode: 0o600,
      },
    );
    try {
      if (statSync(this.file).size > MAX_BYTES) {
        const lines = readFileSync(this.file, 'utf8').trimEnd().split('\n');
        writePrivateFile(this.file, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
      }
    } catch {
      /* trimming is housekeeping; a failure must not lose the entry just written */
    }
  }

  recent(limit = 100): AuditEntry[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of text.trimEnd().split('\n').slice(-limit)) {
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (typeof e.at === 'string' && typeof e.action === 'string') out.push(e);
      } catch {
        /* skip a damaged line */
      }
    }
    return out;
  }
}
