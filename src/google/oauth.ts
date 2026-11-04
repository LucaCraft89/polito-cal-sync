import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { google, type Auth } from 'googleapis';
import { UserError } from '../util/errors.js';
import { writePrivateFile } from '../util/files.js';

/**
 * Full Calendar scope. Needed to create the dedicated calendar and to delete the throw-away one
 * used by `verify-google`. The program still only ever writes events that carry our marker, in
 * the one calendar saved at setup (see OwnedCalendar). A narrower scope (calendar.app.created) is
 * not used because its behaviour with calendars created in the Google UI is unverified.
 */
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar';

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

const TOKEN_FILE = 'google-token.json';

function authExpired(what: string, cause?: unknown): UserError {
  return new UserError({
    code: 'E_GOOGLE_AUTH_EXPIRED',
    what,
    why: 'The saved login file is damaged, or the login was revoked or expired (an OAuth app in "Testing" mode loses it after 7 days).',
    action: 'Reconnect Google with the "auth google" command (docs/M2-RUNBOOK.md).',
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The Google login, kept in DATA_DIR with mode 0600. Its content is never logged or printed. */
export class TokenStore {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, TOKEN_FILE);
  }

  /** undefined = never connected. A damaged file is E_GOOGLE_AUTH_EXPIRED. */
  read(): StoredToken | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const t = JSON.parse(raw) as Partial<StoredToken>;
      if (typeof t.refresh_token !== 'string' || t.refresh_token.length === 0) throw new Error();
      return t as StoredToken;
    } catch (cause) {
      throw authExpired('The saved Google login file cannot be read.', cause);
    }
  }

  write(token: StoredToken): void {
    writePrivateFile(this.path, JSON.stringify(token));
  }
}

export function clientCredentials(g: { clientId?: string; clientSecret?: string }): {
  clientId: string;
  clientSecret: string;
} {
  if (!g.clientId || !g.clientSecret) {
    throw new UserError({
      code: 'E_GOOGLE_CLIENT_MISSING',
      what: 'The Google OAuth client is not configured.',
      why: 'GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET is empty.',
      action:
        'Create an OAuth client of type "Desktop app" in the Google Cloud console and put its id and secret in .env (steps: docs/M2-RUNBOOK.md).',
    });
  }
  return { clientId: g.clientId, clientSecret: g.clientSecret };
}

/** An OAuth2 client that already holds the saved login and saves refreshed access tokens. */
export function authorizedClient(
  creds: { clientId: string; clientSecret: string },
  store: TokenStore,
  onSaveError?: (err: unknown) => void,
): Auth.OAuth2Client {
  const saved = store.read();
  if (!saved) {
    throw new UserError({
      code: 'E_NOT_CONFIGURED',
      what: 'Google is not connected yet.',
      why: 'There is no saved Google login in the data folder (or DATA_DIR points to another folder than during setup).',
      action: 'Run the "auth google" command once (docs/M2-RUNBOOK.md).',
    });
  }
  const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  client.setCredentials(saved);
  let current = saved;
  client.on('tokens', (t) => {
    current = {
      ...current,
      ...(t as Partial<StoredToken>),
      refresh_token: t.refresh_token ?? current.refresh_token,
    };
    try {
      store.write(current);
    } catch (err) {
      onSaveError?.(err);
    }
  });
  return client;
}

/** The part of OAuth2Client the loopback flow needs (a fake implements it in tests). */
export interface OAuthFlowClient {
  generateCodeVerifierAsync(): Promise<{ codeVerifier?: string; codeChallenge?: string }>;
  generateAuthUrl(opts: Auth.GenerateAuthUrlOpts): string;
  getToken(opts: Auth.GetTokenOptions): Promise<{ tokens: Auth.Credentials }>;
}

export interface LoopbackOptions {
  /** Address to listen on. 127.0.0.1 normally; 0.0.0.0 inside Docker (published to the host's loopback only). */
  bind: string;
  /** 0 = pick a free port. */
  port: number;
  timeoutMs: number;
  /** Receives the URL the user must open. */
  announce(url: string): void;
}

const CALLBACK_PATH = '/oauth2callback';

function authFailed(why: string, action: string, cause?: unknown): UserError {
  return new UserError({
    code: 'E_GOOGLE_AUTH_FAILED',
    what: 'The Google sign-in did not finish, nothing was saved.',
    why,
    action,
    ...(cause === undefined ? {} : { cause }),
  });
}

const RETRY = 'Run "auth google" again.';

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;max-width:32em;margin:3em auto"><h1>${title}</h1><p>${body}</p>`;

/**
 * Installed-app loopback flow with PKCE: listens on 127.0.0.1, prints the Google URL, waits for the
 * redirect, checks the `state`, exchanges the code. Returns the credentials (never logged here).
 */
export async function loopbackAuthorize(
  client: OAuthFlowClient,
  o: LoopbackOptions,
): Promise<{ tokens: StoredToken; redirectUri: string }> {
  const state = randomBytes(24).toString('base64url');
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  if (!codeVerifier || !codeChallenge) throw authFailed('PKCE could not be prepared.', RETRY);

  let server: Server | undefined;
  try {
    const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const srv = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        const err = url.searchParams.get('error');
        if (url.searchParams.get('state') !== state) {
          res
            .writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(
              page(
                'Wrong sign-in',
                'This request does not belong to the running sign-in. Nothing happened.',
              ),
            );
          return; // keep waiting for the real redirect
        }
        if (err) {
          res
            .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(page('Sign-in cancelled', 'You can close this tab. Nothing was saved.'));
          reject(
            authFailed(
              `Google reported "${err.replace(/[^\w.-]/g, '').slice(0, 40)}" (for example access_denied when you press Cancel).`,
              RETRY,
            ),
          );
          return;
        }
        const c = url.searchParams.get('code');
        if (!c) {
          res.writeHead(400).end();
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            page(
              'Done',
              'Google is connected. You can close this tab and go back to the terminal.',
            ),
          );
        resolve({ code: c, redirectUri });
      });
      server = srv;
      let redirectUri = '';
      srv.once('error', (e: NodeJS.ErrnoException) =>
        reject(
          authFailed(
            e.code === 'EADDRINUSE'
              ? `Port ${o.port} is already in use on this machine.`
              : 'The local listener for the sign-in redirect could not start.',
            e.code === 'EADDRINUSE' ? 'Use --port with a free port, or leave it out.' : RETRY,
            e,
          ),
        ),
      );
      srv.listen(o.port, o.bind, () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : o.port;
        redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        o.announce(
          client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent', // makes Google return a refresh token every time
            scope: [GOOGLE_SCOPE],
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256' as Auth.CodeChallengeMethod,
            redirect_uri: redirectUri,
          }),
        );
      });
      setTimeout(
        () =>
          reject(
            authFailed(
              `Nothing came back within ${Math.round(o.timeoutMs / 60_000)} minutes.`,
              `${RETRY} With Docker, the port must be published (see docs/M2-RUNBOOK.md).`,
            ),
          ),
        o.timeoutMs,
      ).unref();
    });

    let tokens: Auth.Credentials;
    try {
      ({ tokens } = await client.getToken({
        code: code.code,
        codeVerifier,
        redirect_uri: code.redirectUri,
      }));
    } catch (cause) {
      throw authFailed(
        'Google refused to exchange the sign-in code (the client id/secret may not match the OAuth client you created).',
        'Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then run "auth google" again.',
        cause,
      );
    }
    if (!tokens.refresh_token) {
      throw authFailed(
        'Google did not return a long-lived login (refresh token).',
        'Remove this app at https://myaccount.google.com/permissions and run "auth google" again.',
      );
    }
    if (tokens.scope && !tokens.scope.split(' ').includes(GOOGLE_SCOPE)) {
      throw authFailed(
        'The calendar permission was not granted (the permission boxes on the consent page must be ticked).',
        RETRY,
      );
    }
    return { tokens: tokens as StoredToken, redirectUri: code.redirectUri };
  } finally {
    server?.close();
    server?.closeAllConnections();
  }
}
