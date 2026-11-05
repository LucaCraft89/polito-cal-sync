import type { IncomingMessage, ServerResponse } from 'node:http';
import { UserError } from '../util/errors.js';
import { redactSecrets } from '../util/secret-patterns.js';

/** Sent with every answer of the UI server (docs/UI.md section 4). No inline script or style, no third party. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
};

export const MAX_BODY_BYTES = 256 * 1024;

/** HTTP status for each code the API can answer with. */
const STATUS: Partial<Record<UserError['code'], number>> = {
  E_UI_HOST_REFUSED: 421,
  E_UI_REQUEST_REFUSED: 403,
  E_UI_AUTH_REQUIRED: 401,
  E_UI_LOGIN_FAILED: 401,
  E_UI_LOGIN_THROTTLED: 429,
  E_UI_SETUP_STATE: 409,
  E_UI_PASSPHRASE_WEAK: 422,
  E_UI_NOT_FOUND: 404,
  E_UI_PREVIEW_BUSY: 409,
  E_UI_PREVIEW_RATE_LIMITED: 429,
  E_UI_TEST_BUSY: 409,
  E_UI_TEST_RATE_LIMITED: 429,
  E_UI_UNREACHABLE: 503,
  // Google answers. Never 401: the page reads a 401 as "your session ended".
  E_GOOGLE_CLIENT_MISSING: 409,
  E_GOOGLE_AUTH_EXPIRED: 409,
  E_GOOGLE_AUTH_FAILED: 400,
  E_GOOGLE_CALENDAR_IS_PRIMARY: 422,
  E_GOOGLE_CALENDAR_NOT_FOUND: 404,
  E_GOOGLE_PERMISSION_DENIED: 403,
  E_GOOGLE_QUOTA: 429,
  E_GOOGLE_UNAVAILABLE: 502,
  E_GOOGLE_REQUEST_FAILED: 502,
  E_SETTING_INVALID: 422,
  E_SETTING_LOCKED: 409,
  E_SETTINGS_FILE_INVALID: 500,
};

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The three-line error form (what, why, what to do) plus the docs link, as JSON. */
export function errorReply(err: UserError, headers?: Record<string, string>): Reply {
  const clean = (s: string) => redactSecrets(s);
  return {
    status: err.status ?? STATUS[err.code] ?? 400,
    body: {
      error: {
        code: err.code,
        what: clean(err.what),
        why: clean(err.why),
        action: clean(err.action),
        docs: err.docsAnchor,
      },
    },
    ...(headers ? { headers } : {}),
  };
}

export function send(res: ServerResponse, reply: Reply): void {
  const payload = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...reply.headers,
  });
  res.end(payload);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

const refused = (what: string, why: string, action: string): UserError =>
  new UserError({ code: 'E_UI_REQUEST_REFUSED', what, why, action });

/**
 * Reads a JSON object from the request. At most MAX_BODY_BYTES; `Content-Type` must be application/json.
 * Nothing is echoed back on failure (a body may hold a password).
 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    req.resume();
    throw refused(
      'The request was refused: the body must be JSON.',
      'The Content-Type header is not application/json.',
      'Send the request as application/json.',
    );
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    req.resume();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      req.resume();
      throw tooLarge();
    }
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw refused(
      'The request was refused: the body is not valid JSON.',
      'The text could not be parsed.',
      'Send a JSON object.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw refused(
      'The request was refused: the body must be a JSON object.',
      'A list or a single value was sent.',
      'Send a JSON object.',
    );
  }
  return parsed as Record<string, unknown>;
}

const tooLarge = (): UserError =>
  refused(
    `The request was refused: the body is larger than ${MAX_BODY_BYTES / 1024} KB.`,
    'No setting needs that much text.',
    'Send less.',
  );
