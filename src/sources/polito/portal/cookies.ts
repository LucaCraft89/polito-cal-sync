interface Cookie {
  name: string;
  value: string;
  host: string;
  path: string;
  secure: boolean;
}

/** In-memory cookie jar for one login. Values never leave memory and are never logged. */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  store(host: string, setCookies: readonly string[]): void {
    for (const line of setCookies) {
      const [pair = '', ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const c: Cookie = {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        host,
        path: '/',
        secure: false,
      };
      let expired = false;
      for (const a of attrs) {
        const [k = '', v = ''] = a.split('=');
        const key = k.toLowerCase();
        if (key === 'path' && v) c.path = v;
        else if (key === 'secure') c.secure = true;
        else if (key === 'domain' && v) c.host = v.replace(/^\./, '');
        else if (key === 'max-age' && /^-?\d+$/.test(v) && Number(v) <= 0) expired = true;
        else if (key === 'expires' && Date.parse(v) < Date.now()) expired = true;
      }
      const id = `${c.host}|${c.path}|${c.name}`;
      if (expired) this.cookies.delete(id);
      else this.cookies.set(id, c);
    }
  }

  header(url: URL): string {
    const out: string[] = [];
    for (const c of this.cookies.values()) {
      const hostOk = url.hostname === c.host || url.hostname.endsWith(`.${c.host}`);
      if (hostOk && url.pathname.startsWith(c.path) && (!c.secure || url.protocol === 'https:')) {
        out.push(`${c.name}=${c.value}`);
      }
    }
    return out.join('; ');
  }
}
