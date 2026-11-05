import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../../../util/errors.js';

/**
 * After the university login refuses a username/password, no further attempt is made until the
 * credentials CHANGE: an hourly retry of a wrong password would walk into an account lockout.
 * The file holds a short fingerprint, not the password (but the .env already holds it, 0600 either way).
 */
export class LoginLatch {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'polito-login-blocked.json');
  }

  private static fingerprint(username: string, password: string): string {
    return createHash('sha256').update(`${username}\u0000${password}`).digest('hex').slice(0, 16);
  }

  /** Throws E_POLITO_LOGIN_BLOCKED if this exact username/password was refused before. */
  assertOpen(username: string, password: string): void {
    let stored: { fingerprint?: unknown; at?: unknown } | undefined;
    try {
      stored = JSON.parse(readFileSync(this.file, 'utf8')) as typeof stored;
    } catch {
      return;
    }
    if (stored?.fingerprint === LoginLatch.fingerprint(username, password)) {
      throw new UserError({
        code: 'E_POLITO_LOGIN_BLOCKED',
        what: 'The Polito login is paused: these exact credentials were refused earlier, so no new attempt is made.',
        why: 'Repeating a refused login every hour could get the account locked.',
        action: `Check in a browser that the login works, then fix the username or password (Sources page, or POLITO_USERNAME / POLITO_PASSWORD in .env): the pause ends by itself when they change. If the credentials were right and the refusal was a one-off, press "I fixed the credentials" on the History page. Refused at ${typeof stored.at === 'string' ? stored.at : 'an earlier run'}.`,
      });
    }
  }

  /** When these exact credentials were refused, or undefined if they are not paused (also after they changed). */
  pausedSince(username: string, password: string): string | undefined {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as {
        fingerprint?: unknown;
        at?: unknown;
      };
      return v.fingerprint === LoginLatch.fingerprint(username, password)
        ? typeof v.at === 'string'
          ? v.at
          : ''
        : undefined;
    } catch {
      return undefined;
    }
  }

  block(username: string, password: string, now: Date): void {
    mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        fingerprint: LoginLatch.fingerprint(username, password),
        at: now.toISOString(),
      }),
      { mode: 0o600 },
    );
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}
