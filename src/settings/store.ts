import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { configProblems, loadConfig, type Config } from '../config/index.js';
import { UserError } from '../util/errors.js';
import { writePrivateFile } from '../util/files.js';
import type { AuditLog } from './audit.js';
import {
  checkShapes,
  envIsSet,
  FIELD_BY_ENV,
  FIELD_BY_KEY,
  lockedKeys,
  type SettingProblem,
  type SettingsValues,
} from './fields.js';

export const SETTINGS_FILE = 'settings.json';
const SETTINGS_VERSION = 1;

const fileSchema = z.object({
  version: z.number().int(),
  updatedAt: z.string(),
  values: z.record(z.string(), z.unknown()),
});

export interface SettingsChange {
  /** key -> new value (shape-checked here, range-checked by the shared configuration rules). */
  set?: Record<string, unknown> | undefined;
  /** keys to forget; the setting falls back to its default. */
  clear?: string[] | undefined;
}

const listProblems = (ps: SettingProblem[]): string =>
  ps.map((p) => `${p.key} ${p.rule}`).join('; ');

/**
 * `DATA_DIR/settings.json`: what the UI saved. Mode 0600, written atomically, schema versioned. Environment
 * variables win over it (they are shown read-only and cannot be changed here). The password and the Google
 * client secret are stored in clear text like `.env` holds them: the protection is the file mode and disk
 * encryption, and a key stored next to them would add nothing (docs/UI.md section 4).
 */
export class SettingsStore {
  readonly file: string;

  constructor(
    readonly dataDir: string,
    private readonly audit?: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(dataDir, SETTINGS_FILE);
  }

  /** The saved values; `{}` when nothing was saved yet. A damaged file is an error, never silently ignored. */
  read(): SettingsValues {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (cause) {
      // A missing folder or a path below a file is the data-folder check's business (E_DATA_DIR_NOT_WRITABLE).
      const errno = (cause as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT' || errno === 'ENOTDIR') return {};
      throw this.damaged('the file cannot be read', cause);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw this.damaged('the file is not valid JSON', cause);
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) throw this.damaged('the file has an unexpected structure');
    if (parsed.data.version !== SETTINGS_VERSION) {
      throw this.damaged(
        `the file has version ${parsed.data.version}, this program understands version ${SETTINGS_VERSION}`,
      );
    }
    const { values, problems } = checkShapes(parsed.data.values);
    if (problems.length > 0)
      throw this.damaged(`settings with a wrong shape: ${listProblems(problems)}`);
    return values;
  }

  private damaged(detail: string, cause?: unknown): UserError {
    return new UserError({
      code: 'E_SETTINGS_FILE_INVALID',
      what: `The saved settings file could not be used (${detail}).`,
      why: 'It was edited by hand, damaged, or written by a newer version of this program.',
      action:
        'Fix or remove DATA_DIR/settings.json (keep a copy first), then start again. Settings in .env are not affected.',
      ...(cause === undefined ? {} : { cause }),
    });
  }

  /**
   * Saves a change. All or nothing: the whole change is checked against the same rules as `.env` before
   * anything is written. Returns the keys that changed. Messages name keys and rules, never values.
   */
  apply(change: SettingsChange, env: NodeJS.ProcessEnv): string[] {
    const clear = [...new Set(change.clear ?? [])];
    const { values, problems } = checkShapes(change.set ?? {});
    for (const key of clear) {
      if (!FIELD_BY_KEY.has(key))
        problems.push({ key, rule: 'is not a setting the UI can change' });
      else if (key in values)
        problems.push({ key, rule: 'cannot be set and cleared in one request' });
    }
    if (problems.length > 0) this.invalid(problems);

    const touched = [...Object.keys(values), ...clear];
    const locked = lockedKeys(env);
    const blocked = touched.filter((k) => locked.has(k));
    if (blocked.length > 0) {
      throw new UserError({
        code: 'E_SETTING_LOCKED',
        what: `Not changed: ${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} set by an environment variable.`,
        why: 'A value in .env or in the container environment always wins over the UI, so a change here would have no effect.',
        action: `Change it where it is set (${blocked.map((k) => FIELD_BY_KEY.get(k)?.env ?? k).join(', ')}), or remove that variable to manage the setting in the UI.`,
      });
    }

    const current = this.read();
    const next: SettingsValues = { ...current, ...values };
    for (const key of clear) delete next[key];

    const touchedEnv = new Set(touched.map((k) => FIELD_BY_KEY.get(k)?.env));
    const rangeProblems = configProblems(env, next)
      .filter((p) => touchedEnv.has(p.variable))
      .map((p) => ({ key: FIELD_BY_ENV.get(p.variable)?.key ?? p.variable, rule: p.message }));
    if (rangeProblems.length > 0) this.invalid(rangeProblems);

    const changed = touched.filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
    if (changed.length === 0) return [];
    writePrivateFile(
      this.file,
      `${JSON.stringify({ version: SETTINGS_VERSION, updatedAt: this.now().toISOString(), values: next }, null, 2)}\n`,
    );
    this.audit?.append('settings.update', {
      set: Object.keys(values).filter((k) => changed.includes(k)),
      cleared: clear.filter((k) => changed.includes(k)),
    });
    return changed;
  }

  private invalid(problems: SettingProblem[]): never {
    throw new UserError({
      code: 'E_SETTING_INVALID',
      what: `Not saved: ${listProblems(problems)}.`,
      why: 'A value does not follow the rule for that setting. Nothing was changed.',
      action: 'Correct the listed settings and save again.',
    });
  }
}

/** The configuration as the CLI and the UI see it: environment over settings.json over defaults. */
export function loadConfigFromDisk(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(envIsSet(env, 'DATA_DIR') ? (env['DATA_DIR'] as string) : './data');
  return loadConfig(env, new SettingsStore(dataDir).read());
}
