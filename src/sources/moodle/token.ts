import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from '../../util/files.js';

/** The Moodle app's login ends in a redirect `moodlemobile://token=<base64(siteid:::token[:::privatetoken])>`. */
export const APP_SCHEME = 'moodlemobile://';

/** The web-service token out of that redirect (the private token is never kept). Undefined if it does not parse. */
export function tokenFromRedirect(location: string): string | undefined {
  if (!location.startsWith(APP_SCHEME)) return undefined;
  const raw = location.slice(APP_SCHEME.length).replace(/^token=/, '');
  let decoded: string;
  try {
    decoded = Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  const token = decoded.split(':::')[1];
  return token && /^[A-Za-z0-9]{16,64}$/.test(token) ? token : undefined;
}

/**
 * The web-service token, kept in DATA_DIR (0600) so a normal sync needs no new university login: it is used until
 * Moodle refuses it. Bound to the username (a hash), so another account never reuses it. Never logged or printed.
 */
export class MoodleTokenStore {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'moodle-token.json');
  }
  private static owner(username: string): string {
    return createHash('sha256').update(username).digest('hex').slice(0, 16);
  }
  read(username: string): string | undefined {
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8')) as { token?: unknown; owner?: unknown };
      return typeof v.token === 'string' && v.owner === MoodleTokenStore.owner(username)
        ? v.token
        : undefined;
    } catch {
      return undefined;
    }
  }
  write(username: string, token: string, at: Date): void {
    writePrivateFile(
      this.path,
      JSON.stringify({ token, owner: MoodleTokenStore.owner(username), savedAt: at.toISOString() }),
    );
  }
  clear(): void {
    rmSync(this.path, { force: true });
  }
}
