// Minimal cookie jar for the SSO probe. Values stay in memory; reports carry names, lifetimes and flags only.

export class CookieJar {
  constructor() {
    /** @type {Map<string, { name: string, value: string, host: string, path: string, secure: boolean, httpOnly: boolean, maxAge?: number, expires?: string, session: boolean }>} */
    this.cookies = new Map();
  }

  /** @param {string} host  @param {string[]} setCookies */
  store(host, setCookies) {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const eq = (pair ?? '').indexOf('=');
      if (eq <= 0) continue;
      const c = {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        host,
        path: '/',
        secure: false,
        httpOnly: false,
        session: true,
      };
      for (const a of attrs) {
        const [k, v = ''] = a.split('=');
        const key = k.toLowerCase();
        if (key === 'path' && v) c.path = v;
        else if (key === 'secure') c.secure = true;
        else if (key === 'httponly') c.httpOnly = true;
        else if (key === 'max-age' && /^-?\d+$/.test(v)) {
          c.maxAge = Number(v);
          c.session = false;
        } else if (key === 'expires') {
          c.expires = v;
          c.session = false;
        } else if (key === 'domain' && v) c.host = v.replace(/^\./, '');
      }
      const id = `${c.host}|${c.path}|${c.name}`;
      if (c.maxAge !== undefined && c.maxAge <= 0) this.cookies.delete(id);
      else this.cookies.set(id, c);
    }
  }

  /** Cookie header for a URL. */
  header(url) {
    const u = new URL(url);
    const out = [];
    for (const c of this.cookies.values()) {
      const hostOk = u.hostname === c.host || u.hostname.endsWith(`.${c.host}`);
      if (hostOk && u.pathname.startsWith(c.path) && (!c.secure || u.protocol === 'https:')) {
        out.push(`${c.name}=${c.value}`);
      }
    }
    return out.join('; ');
  }

  /** What may be recorded: no values. Lifetime in seconds when the server states one. */
  describe() {
    return [...this.cookies.values()].map((c) => ({
      name: c.name,
      host: c.host,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      session: c.session,
      ...(c.maxAge !== undefined ? { maxAgeSeconds: c.maxAge } : {}),
      ...(c.expires ? { expires: c.expires } : {}),
      valueLength: c.value.length,
    }));
  }
}
