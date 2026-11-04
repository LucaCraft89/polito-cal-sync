import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
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
});

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
  polito: { enabled: boolean; username?: string; password?: string };
  /** Local status page: port 0 turns it off. */
  status: { port: number; bind: string };
}

/**
 * Validates the environment. The error lists variable names and the rule that failed but never
 * the offending value, because a mistyped secret must not end up on a screen or in a log.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${String(i.path[0] ?? '?')}: ${i.message}`);
    throw new UserError({
      code: 'E_CONFIG_INVALID',
      what: `The configuration has ${problems.length} problem(s): ${problems.join('; ')}.`,
      why: 'A value in .env or in the environment of the container is missing its expected format.',
      action:
        'Fix the listed variables in your .env file (compare with .env.example), then start again.',
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
    polito: {
      enabled: v.SOURCE_POLITO_PORTAL_ENABLED,
      ...(v.POLITO_USERNAME !== undefined ? { username: v.POLITO_USERNAME } : {}),
      ...(v.POLITO_PASSWORD !== undefined ? { password: v.POLITO_PASSWORD } : {}),
    },
    status: { port: v.STATUS_PORT, bind: v.STATUS_BIND },
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
