import { UserError } from '../../../util/errors.js';
import { USER_AGENT } from '../../../util/version.js';
import { CookieJar } from './cookies.js';
import { parseForms } from './html.js';

/** The student portal. Verified by the owner's probe run on 2026-11-04 (decision 018). */
export const PORTAL_START_URL = 'https://didattica.polito.it/login';
export const PORTAL_HOSTS = ['didattica.polito.it', 'idp.polito.it'] as const;

export interface PortalOptions {
  fetchImpl?: typeof fetch;
  startUrl?: string;
  /** Hosts that may be contacted. Anything else stops the login. Default: the two university hosts. */
  allowedHosts?: readonly string[];
  /** Hosts allowed without https (tests only). */
  insecureHosts?: readonly string[];
  /** Pause between requests. Default 1500 ms. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxRequests?: number;
}

const unexpected = (what: string): UserError =>
  new UserError({
    code: 'E_POLITO_API_UNEXPECTED_DATA',
    what: `The university login did not go the expected way: ${what}.`,
    why: 'The login page or its redirects changed, or the connection was intercepted.',
    action:
      'Nothing was sent anywhere unexpected and nothing was deleted. Run probe/05-idp-login.mjs to see where it differs and report it (field names only, never values).',
  });

const fetchFailed = (what: string, cause?: unknown): UserError =>
  new UserError({
    code: 'E_POLITO_API_FETCH_FAILED',
    what: `A request to the Polito portal failed: ${what}.`,
    why: 'The service is down or busy, this machine is offline, or we asked too often.',
    action: 'Nothing was deleted. The next scheduled run tries again.',
    cause,
  });

/**
 * A logged-in portal session. `PortalSession.login` does what a browser does (decision 018):
 * portal login -> redirects to the identity provider -> its form POSTed ONCE -> the SAML answer
 * forwarded back -> redirects to the portal. One request at a time; no retries inside a login.
 * The password is only ever POSTed to a form on an allowed host over https.
 */
export class PortalSession {
  requests = 0;
  private last = 0;

  private constructor(
    private readonly jar: CookieJar,
    private readonly o: Required<Pick<PortalOptions, 'startUrl'>> & PortalOptions,
  ) {}

  private hostOk(url: URL): boolean {
    const hosts = this.o.allowedHosts ?? PORTAL_HOSTS;
    const insecure = this.o.insecureHosts ?? [];
    return (
      hosts.includes(url.hostname) && (url.protocol === 'https:' || insecure.includes(url.hostname))
    );
  }

  private async send(
    method: 'GET' | 'POST',
    url: URL,
    form?: Record<string, string>,
  ): Promise<{ res: Response; text: string }> {
    if (!this.hostOk(url))
      throw unexpected('a redirect or form pointed to a host that is not allowed');
    if (++this.requests > (this.o.maxRequests ?? 30)) throw unexpected('too many redirects');
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const wait = this.last + (this.o.pauseMs ?? 1500) - Date.now();
    if (this.requests > 1 && wait > 0) await sleep(wait);
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.5',
    };
    const cookie = this.jar.header(url);
    if (cookie) headers['Cookie'] = cookie;
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(url, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
    } catch (cause) {
      throw fetchFailed('no connection or a timeout', cause);
    } finally {
      this.last = Date.now();
    }
    const text = await res.text();
    this.jar.store(url.hostname, res.headers.getSetCookie());
    if (res.status === 429) throw fetchFailed('the server asked us to slow down (429)');
    if (res.status >= 500) throw fetchFailed(`the server answered ${res.status}`);
    return { res, text };
  }

  static async login(
    username: string,
    password: string,
    o: PortalOptions = {},
  ): Promise<PortalSession> {
    const session = new PortalSession(new CookieJar(), { startUrl: PORTAL_START_URL, ...o });
    await session.run(username, password);
    return session;
  }

  private async run(username: string, password: string): Promise<void> {
    let url = new URL(this.o.startUrl);
    let method: 'GET' | 'POST' = 'GET';
    let form: Record<string, string> | undefined;
    let credsSent = false;
    let idpHost = 'idp.polito.it';
    for (;;) {
      const { res, text } = await this.send(method, url, form);
      method = 'GET';
      form = undefined;
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url);
        continue;
      }
      if (res.status !== 200) throw unexpected(`a page answered with status ${res.status}`);
      const forms = parseForms(text);
      const login = forms.find((f) => f.inputs.some((i) => i.name === 'j_password'));
      const saml = forms.find((f) => f.inputs.some((i) => i.name === 'SAMLResponse'));
      if (login) {
        idpHost = url.hostname;
        if (credsSent) {
          throw new UserError({
            code: 'E_POLITO_API_AUTH_REJECTED',
            what: 'The university login showed its login form again after our username and password were sent.',
            why: 'The credentials were most likely refused (wrong password, changed password, or a locked account).',
            action:
              'No retry is made, and nothing was deleted. Check POLITO_USERNAME and POLITO_PASSWORD by logging in with a browser. The login stays paused until they change.',
          });
        }
        const action = new URL(login.action || url.href, url);
        if (!this.hostOk(action))
          throw unexpected(
            'the login form points to a host that is not allowed; the password was not sent',
          );
        form = {};
        for (const i of login.inputs) {
          if (i.name === 'j_password') form[i.name] = password;
          else if (i.name === 'j_username') form[i.name] = username;
          // The proceed button's value is filled by the page script in a browser.
          else if (i.name === '_eventId_proceed') form[i.name] = i.value || '1';
          else if (i.type === 'hidden') form[i.name] = i.value;
          // checkboxes and the passkey button are left out, as an unticked browser form would
        }
        credsSent = true;
        method = 'POST';
        url = action;
        continue;
      }
      if (saml) {
        form = Object.fromEntries(
          saml.inputs.filter((i) => i.type === 'hidden').map((i) => [i.name, i.value]),
        );
        method = 'POST';
        url = new URL(saml.action, url);
        continue;
      }
      if (forms.length > 0 && url.hostname === idpHost) {
        throw new UserError({
          code: 'E_POLITO_LOGIN_EXTRA_STEP',
          what: 'The university login asked for an extra step (such as a code or a second factor) that this program cannot answer.',
          why: 'Multi-factor authentication is required for this account or for this new "device".',
          action:
            'Nothing was answered and nothing was deleted. The ICS source is unaffected. See docs/ERRORS.md and docs/M3-RUNBOOK.md.',
        });
      }
      return; // a page without forms on an allowed host: logged in
    }
  }

  /** GET a JSON document from the portal with the session cookies. */
  async getJson(path: string): Promise<unknown> {
    const url = new URL(path, this.o.startUrl);
    const { res, text } = await this.send('GET', url);
    if (res.status !== 200) throw unexpected(`the data request answered ${res.status}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unexpected('the data answer is not JSON (the session may have expired)');
    }
  }
}
