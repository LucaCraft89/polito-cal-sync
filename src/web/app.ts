import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { AuditLog } from '../settings/audit.js';
import { describeSettings } from '../settings/fields.js';
import { SettingsStore } from '../settings/store.js';
import type { RuntimeDeps } from '../sync/run.js';
import { UserError } from '../util/errors.js';
import { PassphraseStore, LoginThrottle, SessionStore, type Session } from './auth.js';
import { errorReply, parseCookies, readJsonBody, send, type Reply } from './http.js';
import { GoogleService, type GoogleDeps } from './google.js';
import { PreviewService } from './preview.js';
import { StaticFiles } from './static.js';

export const SESSION_COOKIE = 'pcs_session';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export interface WebAppOptions {
  dataDir: string;
  /** The real environment (read each time, so a changed .env variable shows up as locked). */
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** Extra Host names besides localhost (a reverse proxy name). Setup still needs a loopback Host. */
  allowedHosts?: readonly string[];
  /** A TLS proxy sits in front: cookies get `Secure`, the expected Origin is https, HSTS is sent. */
  https?: boolean;
  /** Test hooks. */
  passphraseCost?: number;
  now?: () => number;
  /** Replaces Google, the portal and the clock in the preview (tests only). */
  runDeps?: RuntimeDeps;
  previewMinIntervalMs?: number;
  /** Replaces the Google sign-in and calendar list (tests only). */
  google?: GoogleDeps;
  /** How long the Google sign-in waits for the browser (tests shorten it). */
  googleConnectTimeoutMs?: number;
  /** The folder with the UI files; default is `web/` of the package. */
  webRoot?: string;
  sessions?: SessionStore;
  throttle?: LoginThrottle;
}

export interface WebApp {
  /** Answers `/api/*` and the UI files and returns true; returns false for any other path (not ours). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

interface Ctx {
  req: IncomingMessage;
  address: string;
  session: Session | undefined;
  sessionId: string | undefined;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

interface Route {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  /** Needs a logged-in session (and, for anything but GET, the CSRF token). */
  auth: boolean;
  /** Reads a JSON body. */
  json: boolean;
  run(ctx: Ctx): Promise<Reply> | Reply;
}

const refused = (what: string, why: string, action: string): UserError =>
  new UserError({ code: 'E_UI_REQUEST_REFUSED', what, why, action });

const passphraseBody = z.object({ passphrase: z.string().max(1000) }).strict();
const changeBody = z.object({ current: z.string().max(1000), next: z.string().max(1000) }).strict();
const calendarBody = z.union([
  z.object({ id: z.string().min(1).max(300) }).strict(),
  z
    .object({
      create: z
        .object({
          name: z
            .string()
            .trim()
            .min(1)
            .max(100)
            // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
            .regex(/^[^\u0000-\u001f\u007f]+$/)
            .optional(),
        })
        .strict(),
    })
    .strict(),
]);
const settingsBody = z
  .object({
    set: z.record(z.string(), z.unknown()).optional(),
    clear: z.array(z.string().max(100)).max(50).optional(),
    /** Edit the feed list without ever seeing the addresses (they hold secret tokens). Indexes are 0-based. */
    icsFeeds: z
      .object({
        add: z.array(z.string().min(1).max(2000)).max(50).optional(),
        remove: z.array(z.number().int().min(0).max(1000)).max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function parseBody<T>(schema: z.ZodType<T>, body: Record<string, unknown>): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  // Field names only: a body can hold a passphrase, so nothing from it is echoed.
  const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? 'body')))].join(', ');
  throw refused(
    `The request was refused: unexpected or missing field(s): ${fields}.`,
    'The body does not have the shape this call expects.',
    'Send exactly the fields documented in docs/UI.md.',
  );
}

/**
 * The secured JSON API of the web UI (docs/UI.md sections 4 and 6, decision 023). No pages yet.
 * Every request is checked in the same order: Host allow-list, route, Origin (non-GET), session,
 * CSRF token (non-GET), body (JSON, size-limited). GET never changes anything.
 */
export function createWebApp(o: WebAppOptions): WebApp {
  const audit = new AuditLog(o.dataDir);
  const settings = new SettingsStore(o.dataDir, audit);
  const passphrase = new PassphraseStore(o.dataDir, {
    ...(o.passphraseCost ? { cost: o.passphraseCost } : {}),
  });
  const sessions = o.sessions ?? new SessionStore();
  const throttle = o.throttle ?? new LoginThrottle();
  const allowed = new Set([
    ...LOOPBACK_HOSTS,
    ...(o.allowedHosts ?? []).map((h) => h.toLowerCase()),
  ]);
  const scheme = o.https ? 'https' : 'http';
  const log = o.logger;

  const cookie = (id: string, maxAgeS: number): string =>
    `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${o.https ? '; Secure' : ''}`;
  const startSession = (): { cookie: string; csrf: string } => {
    const { id, session } = sessions.create();
    return { cookie: cookie(id, 12 * 3600), csrf: session.csrf };
  };

  const files = new StaticFiles(o.webRoot);
  const now = o.now ?? Date.now;
  const preview = new PreviewService({
    dataDir: o.dataDir,
    env: o.env,
    settings,
    logger: o.logger,
    now,
    ...(o.runDeps ? { deps: o.runDeps } : {}),
    ...(o.previewMinIntervalMs !== undefined ? { minIntervalMs: o.previewMinIntervalMs } : {}),
  });

  const googleService = new GoogleService({
    dataDir: o.dataDir,
    env: o.env,
    settings,
    audit,
    logger: o.logger,
    ...(o.google ? { deps: o.google } : {}),
    ...(o.googleConnectTimeoutMs !== undefined
      ? { connectTimeoutMs: o.googleConnectTimeoutMs }
      : {}),
  });

  /** Applies "add / remove a feed" to the saved list, so the browser never needs the addresses. */
  const feedChange = (
    change: z.infer<typeof settingsBody>,
  ): { set?: Record<string, unknown>; clear?: string[] } => {
    const { icsFeeds, set = {}, clear = [] } = change;
    if (!icsFeeds) return { set, clear };
    if ('icsUrls' in set || clear.includes('icsUrls')) {
      throw refused(
        'The request was refused: the feed list was changed in two ways at once.',
        '"icsFeeds" and "icsUrls" cannot be used together.',
        'Send one of them.',
      );
    }
    const saved = settings.read()['icsUrls'];
    const list = Array.isArray(saved)
      ? saved.filter((u): u is string => typeof u === 'string')
      : [];
    const drop = new Set(icsFeeds.remove ?? []);
    const missing = [...drop].filter((i) => i >= list.length);
    if (missing.length > 0) {
      throw new UserError({
        code: 'E_SETTING_INVALID',
        what: `Not saved: feed ${missing.map((i) => i + 1).join(', ')} does not exist.`,
        why: 'The list changed since this page was loaded.',
        action: 'Reload the page and try again.',
      });
    }
    const next = list.filter((_, i) => !drop.has(i));
    for (const u of icsFeeds.add ?? []) if (!next.includes(u)) next.push(u);
    return next.length > 0
      ? { set: { ...set, icsUrls: next }, clear }
      : { set, clear: [...clear, 'icsUrls'] };
  };

  const sessionState = () => ({
    setupRequired: !passphrase.isSet(),
  });

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/session',
      auth: false,
      json: false,
      run: (c) => ({
        status: 200,
        body: {
          ...sessionState(),
          authenticated: c.session !== undefined,
          ...(c.session ? { csrfToken: c.session.csrf } : {}),
        },
      }),
    },
    {
      method: 'POST',
      path: '/api/setup',
      auth: false,
      json: true,
      run: async (c) => {
        const host = hostName(c.req);
        if (!LOOPBACK_HOSTS.includes(host)) {
          throw new UserError({
            code: 'E_UI_HOST_REFUSED',
            what: 'The first-run step is only available through localhost.',
            why: 'Whoever opens the page first chooses the passphrase, so it must be you, on this machine.',
            action:
              'Open http://localhost:<port> on the machine that runs the service and set the passphrase there.',
          });
        }
        const { passphrase: p } = parseBody(passphraseBody, c.body);
        await passphrase.initialize(p);
        audit.append('ui.setup');
        log.info('ui passphrase set');
        const s = startSession();
        return { status: 201, body: { csrfToken: s.csrf }, headers: { 'Set-Cookie': s.cookie } };
      },
    },
    {
      method: 'POST',
      path: '/api/login',
      auth: false,
      json: true,
      run: async (c) => {
        if (!passphrase.isSet()) throw setupFirst();
        const { passphrase: p } = parseBody(passphraseBody, c.body);
        const wait = throttle.retryAfterSeconds(c.address);
        if (wait > 0) throw throttled(wait);
        if (!(await passphrase.verify(p))) {
          throttle.failure(c.address);
          audit.append('ui.login.failed', { address: c.address });
          log.warn({ address: c.address }, 'ui login failed');
          throw new UserError({
            code: 'E_UI_LOGIN_FAILED',
            what: 'The passphrase is not correct.',
            why: 'It does not match the one set on first run.',
            action:
              'Try again. After a few wrong tries you have to wait. If it is lost, run "reset-ui-passphrase" on the machine.',
          });
        }
        throttle.success(c.address);
        audit.append('ui.login', { address: c.address });
        const s = startSession();
        return { status: 200, body: { csrfToken: s.csrf }, headers: { 'Set-Cookie': s.cookie } };
      },
    },
    {
      method: 'POST',
      path: '/api/logout',
      auth: true,
      json: false,
      run: (c) => {
        sessions.destroy(c.sessionId);
        audit.append('ui.logout');
        return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': cookie('', 0) } };
      },
    },
    {
      method: 'POST',
      path: '/api/passphrase',
      auth: true,
      json: true,
      run: async (c) => {
        const { current, next } = parseBody(changeBody, c.body);
        const wait = throttle.retryAfterSeconds(c.address);
        if (wait > 0) throw throttled(wait);
        if (!(await passphrase.verify(current))) {
          throttle.failure(c.address);
          audit.append('ui.passphrase.refused', { address: c.address });
          throw new UserError({
            code: 'E_UI_LOGIN_FAILED',
            what: 'The current passphrase is not correct, so nothing was changed.',
            why: 'It does not match the passphrase in use.',
            action: 'Type the current passphrase again.',
          });
        }
        await passphrase.replace(next);
        sessions.destroyAll();
        audit.append('ui.passphrase.changed');
        log.info('ui passphrase changed; all sessions ended');
        const s = startSession();
        return { status: 200, body: { csrfToken: s.csrf }, headers: { 'Set-Cookie': s.cookie } };
      },
    },
    {
      method: 'GET',
      path: '/api/settings',
      auth: true,
      json: false,
      run: () => {
        const values = settings.read();
        const config = loadConfig(o.env, values);
        return { status: 200, body: { settings: describeSettings(o.env, values, config) } };
      },
    },
    {
      method: 'PUT',
      path: '/api/settings',
      auth: true,
      json: true,
      run: (c) => {
        const change = feedChange(parseBody(settingsBody, c.body));
        const changed = settings.apply(change, o.env);
        log.info({ changed }, 'ui settings saved');
        const values = settings.read();
        const config = loadConfig(o.env, values);
        return {
          status: 200,
          body: { changed, settings: describeSettings(o.env, values, config) },
        };
      },
    },
    {
      method: 'GET',
      path: '/api/preview',
      auth: true,
      json: false,
      run: () => ({ status: 200, body: preview.latest }),
    },
    {
      method: 'POST',
      path: '/api/preview',
      auth: true,
      json: true,
      run: async () => ({ status: 200, body: await preview.run() }),
    },
    {
      method: 'GET',
      path: '/api/google',
      auth: true,
      json: false,
      run: () => ({ status: 200, body: googleService.status() }),
    },
    {
      method: 'POST',
      path: '/api/google/connect',
      auth: true,
      json: true,
      run: async () => ({ status: 200, body: await googleService.startConnect() }),
    },
    {
      method: 'POST',
      path: '/api/google/connect/cancel',
      auth: true,
      json: true,
      run: () => ({ status: 200, body: googleService.cancelConnect() }),
    },
    {
      method: 'GET',
      path: '/api/google/calendars',
      auth: true,
      json: false,
      run: async () => ({ status: 200, body: await googleService.listCalendars() }),
    },
    {
      method: 'POST',
      path: '/api/google/calendar',
      auth: true,
      json: true,
      run: async (c) => ({
        status: 200,
        body: await googleService.chooseCalendar(parseBody(calendarBody, c.body)),
      }),
    },
    {
      method: 'GET',
      path: '/api/audit',
      auth: true,
      json: false,
      run: (c) => {
        const n = Number(c.query.get('limit') ?? 100);
        return {
          status: 200,
          body: { entries: audit.recent(Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 100) },
        };
      },
    },
  ];

  const hostRefused = () =>
    new UserError({
      code: 'E_UI_HOST_REFUSED',
      what: 'This address is not allowed.',
      why: 'The Host header is not localhost. This stops web pages from reaching the UI through your browser (DNS rebinding).',
      action:
        'Open the UI as http://localhost:<port>. To use another name, add it to UI_ALLOWED_HOSTS.',
    });
  const setupFirst = () =>
    new UserError({
      code: 'E_UI_SETUP_STATE',
      what: 'No passphrase is set yet.',
      why: 'The first-run step has not been done.',
      action: 'Open the UI on this machine and choose a passphrase.',
    });
  const throttled = (wait: number) =>
    new UserError({
      code: 'E_UI_LOGIN_THROTTLED',
      what: `Too many wrong passphrases. Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
      why: 'Repeated failures are slowed down on purpose, so a guesser gets nowhere.',
      action: `Wait ${wait} second${wait === 1 ? '' : 's'}, then type the passphrase carefully.`,
      status: 429,
    });

  function hostName(req: IncomingMessage): string {
    return (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  }

  function checkOrigin(req: IncomingMessage): void {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') {
      throw refused(
        'The request was refused: it comes from another site.',
        `The browser says it was started from "${String(site).slice(0, 20)}".`,
        'Use the page served by this program itself.',
      );
    }
    if (req.headers.origin !== `${scheme}://${req.headers.host}`) {
      throw refused(
        'The request was refused: its Origin is missing or does not match this page.',
        'Changes are accepted only from the UI itself, to stop other web pages from sending them.',
        'Use the UI in the browser. For tests with curl, send -H "Origin: <the page address>".',
      );
    }
  }

  function checkCsrf(req: IncomingMessage, session: Session): void {
    const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    const want = Buffer.from(session.csrf);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) {
      throw refused(
        'The request was refused: the CSRF token is missing or wrong.',
        'Every change needs the token the page received after logging in.',
        'Reload the page and try again.',
      );
    }
  }

  async function dispatch(
    req: IncomingMessage,
    path: string,
    query: URLSearchParams,
  ): Promise<Reply> {
    if (!allowed.has(hostName(req))) throw hostRefused();
    const matches = routes.filter((r) => r.path === path);
    if (matches.length === 0) {
      throw new UserError({
        code: 'E_UI_NOT_FOUND',
        what: 'There is nothing at this address.',
        why: 'The path is not part of the API.',
        action: 'Check the address against docs/UI.md.',
      });
    }
    const method = req.method ?? 'GET';
    const route = matches.find((r) => r.method === method);
    if (!route) {
      req.resume();
      throw new UserError({
        code: 'E_UI_REQUEST_REFUSED',
        what: `The request was refused: ${method.slice(0, 10)} is not allowed here.`,
        why: `This address answers ${matches.map((r) => r.method).join(', ')} only.`,
        action: 'Use the right method.',
        status: 405,
      });
    }
    if (route.method !== 'GET') checkOrigin(req);
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = sessions.get(sessionId);
    if (route.auth) {
      if (!session) {
        req.resume();
        throw new UserError({
          code: 'E_UI_AUTH_REQUIRED',
          what: 'You are not logged in.',
          why: 'There is no session, or it expired (30 minutes without use, 12 hours in total).',
          action: 'Log in with your passphrase.',
        });
      }
      if (route.method !== 'GET') checkCsrf(req, session);
    }
    const body = route.json ? await readJsonBody(req) : {};
    if (!route.json) req.resume();
    return route.run({
      req,
      address: req.socket.remoteAddress ?? 'unknown',
      session,
      sessionId,
      body,
      query,
    });
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://placeholder.invalid');
      if (!url.pathname.startsWith('/api/')) {
        // The UI files. Unknown paths fall through to the status page.
        if (!files.has(url.pathname)) return false;
        if (!allowed.has(hostName(req))) {
          send(res, errorReply(hostRefused()));
          return true;
        }
        return files.serve(req, res, url.pathname);
      }
      const hsts: Record<string, string> = o.https
        ? { 'Strict-Transport-Security': 'max-age=31536000' }
        : {};
      // An answer sent before the whole body arrived (too large, wrong type, not logged in) must close the
      // connection, or a keep-alive client would send its next request into the unread rest.
      const answer = (reply: Reply): void =>
        send(res, {
          ...reply,
          headers: {
            ...hsts,
            ...(req.complete ? {} : { Connection: 'close' }),
            ...reply.headers,
          },
        });
      try {
        answer(await dispatch(req, url.pathname, url.searchParams));
      } catch (err) {
        if (err instanceof UserError) {
          answer(
            errorReply(
              err,
              err.code === 'E_UI_LOGIN_THROTTLED'
                ? { 'Retry-After': throttleHeader(err) }
                : undefined,
            ),
          );
        } else {
          log.error({ err }, 'ui request failed');
          answer({
            status: 500,
            body: {
              error: {
                code: 'E_INTERNAL',
                what: 'Something unexpected went wrong.',
                why: 'This is probably a bug in polito-cal-sync.',
                action:
                  'Run again with LOG_LEVEL=debug and open an issue. Remove personal data from the log first.',
                docs: 'docs/ERRORS.md#e_internal',
              },
            },
          });
        }
      }
      return true;
    },
  };
}

function throttleHeader(err: UserError): string {
  const m = /in (\d+) second/.exec(err.what);
  return m?.[1] ?? '60';
}
