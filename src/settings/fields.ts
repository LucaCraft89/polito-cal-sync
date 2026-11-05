import { z } from 'zod';
import type { Config } from '../config/index.js';

/**
 * Every setting the UI may change, as ONE table: the key the UI uses, the environment variable that
 * overrides it, how the value is checked, how it becomes the environment-variable text that
 * `loadConfig` already validates, and how it is shown. Env-only infrastructure settings (DATA_DIR,
 * LOG_LEVEL, STATUS_*, UI_*) are deliberately not here: a page must not be able to move the data folder
 * or open the server to the network.
 */
export interface SettingField {
  /** Dotted key used by the UI and in settings.json. */
  key: string;
  /** The environment variable that wins over the file when it is set (non-empty). */
  env: string;
  /** Write-only: never returned, never logged, never in an audit entry. */
  secret: boolean;
  /** Shape check of one value coming from the UI; the range rules live in the shared env schema. */
  value: z.ZodType;
  toEnv(value: unknown): string;
  /** The value as the effective configuration holds it. */
  read(config: Config): unknown;
  /** What the UI may be told about the value (never a secret, never a feed URL). */
  display?(value: unknown): unknown;
}

const word = z.string().regex(/^[\w-]+$/, 'letters, digits, "_" and "-" only');

const field = <T extends z.ZodType>(
  f: Omit<SettingField, 'value' | 'toEnv'> & { value: T; toEnv(v: z.infer<T>): string },
): SettingField => f;

export const SETTING_FIELDS: readonly SettingField[] = [
  field({
    key: 'tz',
    env: 'TZ',
    secret: false,
    value: z.string().min(1).max(64),
    toEnv: (v) => v,
    read: (c) => c.tz,
  }),
  field({
    key: 'syncIntervalMinutes',
    env: 'SYNC_INTERVAL_MINUTES',
    secret: false,
    value: z.number().int(),
    toEnv: (v) => String(v),
    read: (c) => c.syncIntervalMinutes,
  }),
  field({
    key: 'deleteThreshold',
    env: 'DELETE_THRESHOLD',
    secret: false,
    value: z.number(),
    toEnv: (v) => String(v),
    read: (c) => c.deleteThreshold,
  }),
  field({
    key: 'moodleBaseUrl',
    env: 'MOODLE_BASE_URL',
    secret: false,
    value: z.string().min(1).max(300),
    toEnv: (v) => v,
    read: (c) => c.moodleBaseUrl,
  }),
  field({
    key: 'icsUrls',
    env: 'SOURCE_POLITO_ICS_URLS',
    secret: false,
    // A feed URL can embed a secret token. The list is accepted and stored, but only hosts are shown.
    value: z
      .array(
        z
          .string()
          .min(1)
          .max(2000)
          .refine((u) => !/[,\s]/.test(u), 'must not contain commas or spaces'),
      )
      .max(50),
    toEnv: (v) => v.join(','),
    read: (c) => c.icsUrls,
    display: (v) =>
      (v as string[]).map((u, i) => ({
        index: i + 1,
        host: URL.canParse(u) ? new URL(u).host : 'invalid URL',
      })),
  }),
  field({
    key: 'polito.enabled',
    env: 'SOURCE_POLITO_PORTAL_ENABLED',
    secret: false,
    value: z.boolean(),
    toEnv: (v) => String(v),
    read: (c) => c.polito.enabled,
  }),
  field({
    key: 'moodle.enabled',
    env: 'SOURCE_MOODLE_ENABLED',
    secret: false,
    value: z.boolean(),
    toEnv: (v) => String(v),
    read: (c) => c.moodle.enabled,
  }),
  field({
    key: 'polito.username',
    env: 'POLITO_USERNAME',
    secret: false,
    value: z.string().min(1).max(100),
    toEnv: (v) => v,
    read: (c) => c.polito.username,
  }),
  field({
    key: 'polito.password',
    env: 'POLITO_PASSWORD',
    secret: true,
    value: z.string().min(1).max(200),
    toEnv: (v) => v,
    read: (c) => c.polito.password,
  }),
  field({
    key: 'polito.examCalls',
    env: 'POLITO_EXAM_CALLS',
    secret: false,
    value: z.enum(['booked', 'all']),
    toEnv: (v) => v,
    read: (c) => c.polito.examCalls,
  }),
  field({
    key: 'polito.squads',
    env: 'POLITO_SQUADS',
    secret: false,
    value: z.record(word, z.array(word).min(1).max(10)),
    toEnv: (v) =>
      Object.entries(v)
        .flatMap(([course, squads]) => squads.map((s) => `${course}=${s}`))
        .join(','),
    read: (c) => c.polito.squads,
  }),
  field({
    key: 'google.clientId',
    env: 'GOOGLE_CLIENT_ID',
    secret: false,
    value: z.string().min(1).max(300),
    toEnv: (v) => v,
    read: (c) => c.google.clientId,
  }),
  field({
    key: 'google.clientSecret',
    env: 'GOOGLE_CLIENT_SECRET',
    secret: true,
    value: z.string().min(1).max(300),
    toEnv: (v) => v,
    read: (c) => c.google.clientSecret,
  }),
  field({
    key: 'google.calendarId',
    env: 'GOOGLE_CALENDAR_ID',
    secret: false,
    value: z.string().min(1).max(300),
    toEnv: (v) => v,
    read: (c) => c.google.calendarId,
  }),
];

export const FIELD_BY_KEY: ReadonlyMap<string, SettingField> = new Map(
  SETTING_FIELDS.map((f) => [f.key, f]),
);
export const FIELD_BY_ENV: ReadonlyMap<string, SettingField> = new Map(
  SETTING_FIELDS.map((f) => [f.env, f]),
);

/** Settings kept in settings.json: dotted key -> value (shape-checked per field). */
export type SettingsValues = Record<string, unknown>;

/** The settings as environment-variable text, for the one shared validation in `loadConfig`. */
export function settingsToEnv(values: SettingsValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of SETTING_FIELDS) {
    if (!(f.key in values)) continue;
    const text = f.toEnv(values[f.key]);
    if (text !== '') out[f.env] = text;
  }
  return out;
}

/** True when the environment variable holds a value (an empty one means "not set", as in `loadConfig`). */
export function envIsSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return v !== undefined && v !== '';
}

/** Keys whose environment variable is set: the UI shows them read-only and refuses to change them. */
export function lockedKeys(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(SETTING_FIELDS.filter((f) => envIsSet(env, f.env)).map((f) => f.key));
}

export interface SettingProblem {
  key: string;
  rule: string;
}

/** Shape-checks `{key: value}` pairs from the UI. Rules never echo the value. */
export function checkShapes(set: Record<string, unknown>): {
  values: SettingsValues;
  problems: SettingProblem[];
} {
  const values: SettingsValues = {};
  const problems: SettingProblem[] = [];
  for (const [key, raw] of Object.entries(set)) {
    const f = FIELD_BY_KEY.get(key);
    if (!f) {
      problems.push({ key: clipKey(key), rule: 'is not a setting the UI can change' });
      continue;
    }
    const r = f.value.safeParse(raw);
    if (r.success) values[key] = r.data;
    else problems.push({ key, rule: r.error.issues[0]?.message ?? 'has the wrong shape' });
  }
  return { values, problems };
}

const clipKey = (k: string): string => (/^[\w.]{1,60}$/.test(k) ? k : '(unreadable key)');

export interface SettingView {
  key: string;
  /** The environment variable that overrides this setting (a name, never a value). */
  env: string;
  source: 'env' | 'ui' | 'default';
  /** Set by an environment variable: shown, cannot be changed in the UI. */
  locked: boolean;
  secret: boolean;
  /** Whether a value exists at all (the only thing a secret reveals). */
  set: boolean;
  /** Absent for secrets. Feed URLs appear as `{index, host}` only. */
  value?: unknown;
}

const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** What the UI is allowed to know about the effective settings. */
export function describeSettings(
  env: NodeJS.ProcessEnv,
  values: SettingsValues,
  config: Config,
): SettingView[] {
  return SETTING_FIELDS.map((f) => {
    const current = f.read(config);
    const source = envIsSet(env, f.env) ? 'env' : f.key in values ? 'ui' : 'default';
    const view: SettingView = {
      key: f.key,
      env: f.env,
      source,
      locked: source === 'env',
      secret: f.secret,
      set: !isEmpty(current),
    };
    if (!f.secret && view.set) view.value = f.display ? f.display(current) : current;
    return view;
  });
}
