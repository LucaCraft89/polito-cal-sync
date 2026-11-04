import { redactSecrets } from './secret-patterns.js';

/**
 * Every code a user can ever see. Each one MUST have a `## <CODE>` section in docs/ERRORS.md
 * (test/errors-doc.test.ts enforces both directions).
 */
export const ERROR_CODES = [
  'E_USAGE',
  'E_NOT_IMPLEMENTED',
  'E_INTERNAL',
  'E_CONFIG_INVALID',
  'E_DATA_DIR_NOT_WRITABLE',
  'E_STATE_DB_OPEN_FAILED',
  'E_STATE_DB_SCHEMA_NEWER',
  'E_NOT_CONFIGURED',
  'E_FIXTURE_INVALID',
  'E_EVENT_INVALID',
  'E_DUPLICATE_SOURCE_ID',
  'E_DELETE_THRESHOLD',
  'E_NOT_OURS',
  'E_ID_COLLISION',
  'E_GOOGLE_AUTH_EXPIRED',
  'E_GOOGLE_PERMISSION_DENIED',
  'E_GOOGLE_CALENDAR_NOT_FOUND',
  'E_GOOGLE_QUOTA',
  'E_GOOGLE_UNAVAILABLE',
  'E_GOOGLE_REQUEST_FAILED',
  'E_GOOGLE_CLIENT_MISSING',
  'E_GOOGLE_AUTH_FAILED',
  'E_GOOGLE_CALENDAR_IS_PRIMARY',
  'E_ICS_FEED_FETCH_FAILED',
  'E_ICS_FEED_REJECTED',
  'E_ICS_FEED_INVALID',
  'E_ICS_FEED_UNSUPPORTED',
  'E_SYNC_ALREADY_RUNNING',
  'E_POLITO_API_NOT_READY',
  'E_POLITO_API_AUTH_REJECTED',
  'E_POLITO_API_FETCH_FAILED',
  'E_POLITO_API_UNEXPECTED_DATA',
  'E_POLITO_LOGIN_EXTRA_STEP',
  'E_POLITO_LOGIN_BLOCKED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface UserErrorInit {
  code: ErrorCode;
  /** What happened, in plain words. */
  what: string;
  /** The most likely reason. */
  why: string;
  /** What the user should do next. */
  action: string;
  /** Underlying error; only ever written to debug logs, never shown. */
  cause?: unknown;
}

/** An error that is safe and useful to show to the user as is. */
export class UserError extends Error {
  readonly code: ErrorCode;
  readonly what: string;
  readonly why: string;
  readonly action: string;

  constructor(init: UserErrorInit) {
    super(`${init.code}: ${init.what}`, init.cause === undefined ? {} : { cause: init.cause });
    this.name = 'UserError';
    this.code = init.code;
    this.what = init.what;
    this.why = init.why;
    this.action = init.action;
  }

  /** Link target inside the repository (GitHub renders `## E_X` headings as `#e_x`). */
  get docsAnchor(): string {
    return `docs/ERRORS.md#${this.code.toLowerCase()}`;
  }
}

export function isUserError(err: unknown): err is UserError {
  return err instanceof UserError;
}

/** Turns anything thrown into a UserError (unknown errors become E_INTERNAL). */
export function toUserError(err: unknown): UserError {
  if (isUserError(err)) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new UserError({
    code: 'E_INTERNAL',
    what: 'Something unexpected went wrong.',
    why: `This is probably a bug in polito-cal-sync (${detail}).`,
    action:
      'Run again with LOG_LEVEL=debug to get details, then open an issue and attach the log. Remove any personal data from it first.',
    cause: err,
  });
}

/** Plain-text rendering for the terminal, wizard and `doctor`. Never includes a stack trace. */
export function formatUserError(err: unknown): string {
  const e = toUserError(err);
  const text = [
    `${e.code}: ${e.what}`,
    `  Why:  ${e.why}`,
    `  Do:   ${e.action}`,
    `  Docs: ${e.docsAnchor}`,
  ].join('\n');
  return redactSecrets(text);
}
