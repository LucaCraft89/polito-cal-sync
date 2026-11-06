import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../util/errors.js';
import { writePrivateFile } from '../util/files.js';

export const UI_AUTH_FILE = 'ui-auth.json';
export const MIN_PASSPHRASE_LENGTH = 12;
const MAX_PASSPHRASE_LENGTH = 256;

const authFile = z.object({
  version: z.literal(1),
  kdf: z.literal('scrypt'),
  N: z
    .number()
    .int()
    .min(1024)
    .max(2 ** 20),
  r: z.number().int().min(1).max(32),
  p: z.number().int().min(1).max(16),
  salt: z.string().min(16),
  hash: z.string().min(16),
  setAt: z.string(),
});

const derive = (
  passphrase: string,
  salt: Buffer,
  o: { N: number; r: number; p: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const opts: ScryptOptions = { ...o, maxmem: 256 * o.N * o.r + 4 * 1024 * 1024 };
    scrypt(passphrase.normalize('NFKC'), salt, 64, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });

export interface PassphraseOptions {
  /** scrypt cost; the default (2^15) takes about 0.1 s. Tests lower it. */
  cost?: number;
  now?: () => Date;
}

/** Checks a new passphrase: length and a hint, no composition rules (docs/UI.md section 4). */
export function checkPassphraseStrength(passphrase: string): UserError | undefined {
  const weak = (why: string) =>
    new UserError({
      code: 'E_UI_PASSPHRASE_WEAK',
      what: 'This passphrase was not accepted.',
      why,
      action: `Use at least ${MIN_PASSPHRASE_LENGTH} characters. Several unrelated words work well; there are no rules about digits or symbols.`,
    });
  const chars = [...passphrase];
  if (chars.length < MIN_PASSPHRASE_LENGTH) {
    return weak(`It has ${chars.length} characters; the minimum is ${MIN_PASSPHRASE_LENGTH}.`);
  }
  if (chars.length > MAX_PASSPHRASE_LENGTH) {
    return weak(`It is longer than ${MAX_PASSPHRASE_LENGTH} characters.`);
  }
  if (new Set(chars).size < 5) return weak('It uses fewer than 5 different characters.');
  return undefined;
}

/**
 * The UI passphrase: only a scrypt hash with a per-install salt, in `DATA_DIR/ui-auth.json` (mode 0600).
 * There is no reset by email; recovery is `reset-ui-passphrase` on the machine, which needs the data folder.
 */
export class PassphraseStore {
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly o: PassphraseOptions = {},
  ) {
    this.file = join(dataDir, UI_AUTH_FILE);
  }

  isSet(): boolean {
    return existsSync(this.file);
  }

  private async hashNew(passphrase: string): Promise<z.infer<typeof authFile>> {
    const weak = checkPassphraseStrength(passphrase);
    if (weak) throw weak;
    const salt = randomBytes(16);
    const N = this.o.cost ?? 2 ** 15;
    const hash = await derive(passphrase, salt, { N, r: 8, p: 1 });
    return {
      version: 1,
      kdf: 'scrypt',
      N,
      r: 8,
      p: 1,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      setAt: (this.o.now ?? (() => new Date()))().toISOString(),
    };
  }

  /** First run. Fails if a passphrase exists (also if another request set it while this one was hashing). */
  async initialize(passphrase: string): Promise<void> {
    if (this.isSet()) throw this.alreadySet();
    const record = await this.hashNew(passphrase);
    if (this.isSet()) throw this.alreadySet();
    writePrivateFile(this.file, `${JSON.stringify(record)}\n`);
  }

  /** Replaces the passphrase. The caller has verified the old one. */
  async replace(passphrase: string): Promise<void> {
    writePrivateFile(this.file, `${JSON.stringify(await this.hashNew(passphrase))}\n`);
  }

  async verify(passphrase: string): Promise<boolean> {
    let record: z.infer<typeof authFile>;
    try {
      record = authFile.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return false;
    }
    if ([...passphrase].length > MAX_PASSPHRASE_LENGTH) return false;
    const expected = Buffer.from(record.hash, 'base64');
    const actual = await derive(passphrase, Buffer.from(record.salt, 'base64'), record);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** `reset-ui-passphrase`: forgets the passphrase so the first-run page appears again. */
  reset(): boolean {
    if (!this.isSet()) return false;
    rmSync(this.file);
    return true;
  }

  private alreadySet(): UserError {
    return new UserError({
      code: 'E_UI_SETUP_STATE',
      what: 'A passphrase is already set, so the first-run step is closed.',
      why: 'The first-run page works only once.',
      action:
        'Log in with the passphrase. If it is lost, run "reset-ui-passphrase" on the machine.',
    });
  }
}

export interface Session {
  csrf: string;
  createdAt: number;
  lastSeen: number;
}

export interface SessionOptions {
  idleMs?: number;
  absoluteMs?: number;
  max?: number;
  now?: () => number;
}

/** Server-side sessions: random 256-bit ids (kept only as a hash), idle timeout 30 min, absolute 12 h. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(o: SessionOptions = {}) {
    this.idleMs = o.idleMs ?? 30 * 60_000;
    this.absoluteMs = o.absoluteMs ?? 12 * 3_600_000;
    this.max = o.max ?? 50;
    this.now = o.now ?? Date.now;
  }

  private key = (id: string): string => createHash('sha256').update(id).digest('hex');

  create(): { id: string; session: Session } {
    this.prune();
    while (this.sessions.size >= this.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    const session: Session = {
      csrf: randomBytes(32).toString('base64url'),
      createdAt: t,
      lastSeen: t,
    };
    this.sessions.set(this.key(id), session);
    return { id, session };
  }

  /** The live session for this id, refreshing its idle timer; expired ones are removed. */
  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const k = this.key(id);
    const s = this.sessions.get(k);
    if (!s) return undefined;
    const t = this.now();
    if (t - s.lastSeen > this.idleMs || t - s.createdAt > this.absoluteMs) {
      this.sessions.delete(k);
      return undefined;
    }
    s.lastSeen = t;
    return s;
  }

  /** Like `get`, but never refreshes the idle timer: for background pushes and refreshes, which must not keep a session alive. */
  peek(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const k = this.key(id);
    const s = this.sessions.get(k);
    if (!s) return undefined;
    const t = this.now();
    if (t - s.lastSeen > this.idleMs || t - s.createdAt > this.absoluteMs) {
      this.sessions.delete(k);
      return undefined;
    }
    return s;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(this.key(id));
  }

  destroyAll(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, s] of this.sessions) {
      if (t - s.lastSeen > this.idleMs || t - s.createdAt > this.absoluteMs)
        this.sessions.delete(k);
    }
  }
}

export interface ThrottleOptions {
  /** Failures per address that cost nothing (typos). */
  freeFailures?: number;
  baseMs?: number;
  maxMs?: number;
  /** Failures from all addresses together that block everybody for a while. */
  globalLimit?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * Login throttling: per source address an exponential back-off after a few free typos, up to a 15 minute
 * lockout, plus a global ceiling. While blocked even the right passphrase is refused (and not even
 * checked), so a guesser learns nothing and the hash cost cannot be used to keep the machine busy.
 */
export class LoginThrottle {
  private readonly perAddress = new Map<string, { fails: number; until: number; last: number }>();
  private globalFails: number[] = [];
  private readonly o: Required<Omit<ThrottleOptions, 'now'>>;
  private readonly now: () => number;

  constructor(o: ThrottleOptions = {}) {
    this.o = {
      freeFailures: o.freeFailures ?? 2,
      baseMs: o.baseMs ?? 2000,
      maxMs: o.maxMs ?? 15 * 60_000,
      globalLimit: o.globalLimit ?? 30,
      windowMs: o.windowMs ?? 15 * 60_000,
    };
    this.now = o.now ?? Date.now;
  }

  /** Seconds to wait, or 0 when an attempt may be checked. */
  retryAfterSeconds(address: string): number {
    const t = this.now();
    this.globalFails = this.globalFails.filter((x) => t - x < this.o.windowMs);
    let until = 0;
    if (this.globalFails.length >= this.o.globalLimit) {
      until = (this.globalFails[0] ?? t) + this.o.windowMs;
    }
    const a = this.perAddress.get(address);
    if (a) {
      if (t - a.last > this.o.maxMs) this.perAddress.delete(address);
      else until = Math.max(until, a.until);
    }
    return until > t ? Math.ceil((until - t) / 1000) : 0;
  }

  failure(address: string): void {
    const t = this.now();
    this.globalFails.push(t);
    if (this.perAddress.size > 1000) this.perAddress.clear();
    const a = this.perAddress.get(address) ?? { fails: 0, until: 0, last: t };
    a.fails += 1;
    a.last = t;
    if (a.fails > this.o.freeFailures) {
      a.until =
        t + Math.min(this.o.baseMs * 2 ** (a.fails - this.o.freeFailures - 1), this.o.maxMs);
    }
    this.perAddress.set(address, a);
  }

  success(address: string): void {
    this.perAddress.delete(address);
  }
}
