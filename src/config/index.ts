import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { settingsToEnv, type SettingsValues } from '../settings/fields.js';
import { UserError } from '../util/errors.js';

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Empty strings in .env mean "not set". */
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);

const envSchema = z.object({
  TZ: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('Europe/Rome')
      .refine(isValidTimeZone, 'must be an IANA time zone name such as Europe/Rome'),
  ),
  DATA_DIR: z.preprocess(emptyToUndefined, z.string().default('./data')),
  SYNC_INTERVAL_MINUTES: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int('must be a whole number of minutes')
      .min(15, 'must be at least 15 (this is personal use, keep traffic low)')
      .max(1440, 'must be at most 1440 (one day)')
      .default(60),
  ),
  DELETE_THRESHOLD: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .min(0, 'must be between 0 and 1')
      .max(1, 'must be between 0 and 1')
      .default(0.3),
  ),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  GOOGLE_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  GOOGLE_CALENDAR_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  SOURCE_POLITO_ICS_URLS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .superRefine((value, ctx) => {
        // Feed URLs can embed a secret token: say which entry is wrong, never show it.
        splitList(value ?? '').forEach((entry, i) => {
          if (!isHttpUrl(entry)) {
            ctx.addIssue({
              code: 'custom',
              message: `entry ${i + 1} is not a valid http(s) URL (entries are separated by commas)`,
            });
          }
        });
      }),
  ),
  SOURCE_POLITO_PORTAL_ENABLED: z.preprocess(
    emptyToUndefined,
    z
      .enum(['true', 'false'], 'must be true or false')
      .default('false')
      .transform((v) => v === 'true'),
  ),
  POLITO_EXAM_CALLS: z.preprocess(
    emptyToUndefined,
    z.enum(['booked', 'all'], 'must be booked or all').default('booked'),
  ),
  MOODLE_BASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('https://moodle.polito.it')
      .refine(
        (v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol),
        'must be an http(s) URL',
      ),
  ),
  POLITO_SQUADS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(
        /^\s*[\w-]+\s*=\s*[\w-]+(?:\s*,\s*[\w-]+\s*=\s*[\w-]+)*\s*$/,
        'must look like 309885=B,309742=2 (course id = squad, comma separated)',
      )
      .optional(),
  ),
  POLITO_USERNAME: z.preprocess(emptyToUndefined, z.string().optional()),
  POLITO_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  STATUS_PORT: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int('must be a whole number')
      .min(0, 'must be 0 (off) or a port number')
      .max(65535, 'must be a port number')
      .default(8787),
  ),
  STATUS_BIND: z.preprocess(emptyToUndefined, z.string().default('127.0.0.1')),
  UI_ENABLED: z.preprocess(
    emptyToUndefined,
    z
      .enum(['true', 'false'], 'must be true or false')
      .default('false')
      .transform((v) => v === 'true'),
  ),
  UI_ALLOWED_HOSTS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(
        /^\s*[A-Za-z0-9.[\]:-]+(?:\s*,\s*[A-Za-z0-9.[\]:-]+)*\s*$/,
        'must be host names separated by commas, e.g. calendar.example.org',
      )
      .optional(),
  ),
  UI_HTTPS: z.preprocess(
    emptyToUndefined,
    z
      .enum(['true', 'false'], 'must be true or false')
      .default('false')
      .transform((v) => v === 'true'),
  ),
});

function parseSquads(value: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of splitList(value ?? '')) {
    const [id = '', squad = ''] = pair.split('=').map((x) => x.trim());
    (out[id] ??= []).push(squad.toUpperCase());
  }
  return out;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isHttpUrl(s: string): boolean {
  if (!URL.canParse(s)) return false;
  const p = new URL(s).protocol;
  return p === 'http:' || p === 'https:';
}

export interface Config {
  tz: string;
  dataDir: string;
  syncIntervalMinutes: number;
  deleteThreshold: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  google: { clientId?: string; clientSecret?: string; calendarId?: string };
  /** Per-course / feed ICS URLs. They may embed a secret token: never log or print them. */
  icsUrls: string[];
  /** The Polito student portal source (decision 018). Off by default. The password is a secret: never log it. */
  polito: {
    enabled: boolean;
    username?: string;
    password?: string;
    examCalls: 'booked' | 'all';
    /** course id -> squads the student is in */
    squads: Record<string, string[]>;
  };
  /** Host of the Moodle site: events from a feed on this host are labelled as Moodle events. */
  moodleHost: string;
  moodleBaseUrl: string;
  /** Local status page: port 0 turns it off. */
  status: { port: number; bind: string };
  /**
   * The web UI API (docs/UI.md). Off by default. Environment only: a page must not be able to change who can
   * reach it. `allowedHosts` are extra Host names besides localhost; `https` means a TLS proxy sits in front.
   */
  ui: { enabled: boolean; allowedHosts: string[]; https: boolean };
}

export interface ConfigProblem {
  /** The environment variable (every setting has one, even when it came from settings.json). */
  variable: string;
  message: string;
}

/**
 * The environment the configuration is read from: values saved by the UI (settings.json) UNDER the real
 * environment. A variable that is set and not empty always wins, so `.env` and the UI can be mixed.
 */
export function layerEnv(env: NodeJS.ProcessEnv, settings: SettingsValues): NodeJS.ProcessEnv {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  return { ...settingsToEnv(settings), ...set };
}

/** Every rule that fails, by variable name. Never contains a value. */
export function configProblems(
  env: NodeJS.ProcessEnv,
  settings: SettingsValues = {},
): ConfigProblem[] {
  const parsed = envSchema.safeParse(layerEnv(env, settings));
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => ({
    variable: String(i.path[0] ?? '?'),
    message: i.message,
  }));
}

/**
 * Validates the environment (and, under it, the settings saved by the UI). The error lists variable names
 * and the rule that failed but never the offending value, because a mistyped secret must not end up on a
 * screen or in a log.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  settings: SettingsValues = {},
): Config {
  const parsed = envSchema.safeParse(layerEnv(env, settings));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${String(i.path[0] ?? '?')}: ${i.message}`);
    throw new UserError({
      code: 'E_CONFIG_INVALID',
      what: `The configuration has ${problems.length} problem(s): ${problems.join('; ')}.`,
      why: 'A value in .env, in the environment of the container or in the settings saved by the web UI is missing its expected format.',
      action:
        'Fix the listed variables in your .env file (compare with .env.example) or in the web UI, then start again.',
    });
  }
  const v = parsed.data;
  const google: Config['google'] = {};
  if (v.GOOGLE_CLIENT_ID !== undefined) google.clientId = v.GOOGLE_CLIENT_ID;
  if (v.GOOGLE_CLIENT_SECRET !== undefined) google.clientSecret = v.GOOGLE_CLIENT_SECRET;
  if (v.GOOGLE_CALENDAR_ID !== undefined) google.calendarId = v.GOOGLE_CALENDAR_ID;
  return {
    tz: v.TZ,
    dataDir: resolve(v.DATA_DIR),
    syncIntervalMinutes: v.SYNC_INTERVAL_MINUTES,
    deleteThreshold: v.DELETE_THRESHOLD,
    logLevel: v.LOG_LEVEL,
    google,
    icsUrls: splitList(v.SOURCE_POLITO_ICS_URLS ?? ''),
    moodleHost: new URL(v.MOODLE_BASE_URL).hostname,
    moodleBaseUrl: v.MOODLE_BASE_URL,
    polito: {
      enabled: v.SOURCE_POLITO_PORTAL_ENABLED,
      examCalls: v.POLITO_EXAM_CALLS,
      squads: parseSquads(v.POLITO_SQUADS),
      ...(v.POLITO_USERNAME !== undefined ? { username: v.POLITO_USERNAME } : {}),
      ...(v.POLITO_PASSWORD !== undefined ? { password: v.POLITO_PASSWORD } : {}),
    },
    status: { port: v.STATUS_PORT, bind: v.STATUS_BIND },
    ui: {
      enabled: v.UI_ENABLED,
      allowedHosts: splitList(v.UI_ALLOWED_HOSTS ?? '').map((h) => h.toLowerCase()),
      https: v.UI_HTTPS,
    },
  };
}

/** Creates DATA_DIR (mode 0700) if needed and proves we can write there. */
export function ensureDataDir(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!statSync(dataDir).isDirectory()) throw new Error('not a directory');
    accessSync(dataDir, constants.R_OK | constants.W_OK);
  } catch (cause) {
    throw new UserError({
      code: 'E_DATA_DIR_NOT_WRITABLE',
      what: `Cannot write to the data directory ${dataDir}.`,
      why: 'The folder does not exist and cannot be created, is not a directory, or belongs to another user (common with a Docker volume created as root).',
      action:
        'Make the folder writable for the user that runs the service (in Docker: user "node", uid 1000), or point DATA_DIR to a folder you own.',
      cause,
    });
  }
}
