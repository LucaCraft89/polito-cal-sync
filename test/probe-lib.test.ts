import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { describeToken } from '../probe/lib/jwt.mjs';
import { Sanitizer, leaks } from '../probe/lib/sanitize.mjs';
import { shapeOf, shapeOfBody } from '../probe/lib/shape.mjs';
import { errorEvidence, fillTemplate, DEFAULT_TEMPLATE } from '../probe/lib/session.mjs';
import { Http, StopProbe, parseArgs } from '../probe/lib/http.mjs';

// All data here is invented.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('probe: shapeOf', () => {
  it('keeps key names, types and lengths but never values', () => {
    const shape = JSON.stringify(
      shapeOf({ name: 'Mario Rossi', n: 42, ok: true, list: ['a', 'b'], expiresIn: 3600 }),
    );
    expect(shape).not.toContain('Mario');
    expect(shape).not.toContain('42');
    expect(shape).toContain('string(len=11)');
    expect(shape).toContain('number(3600)'); // lifetimes are the one numeric thing we keep
  });
  it('describes a non-JSON body without quoting it', () => {
    expect(String(shapeOfBody('<html>secret</html>', 'text/html'))).not.toContain('secret');
  });
});

describe('probe: describeToken', () => {
  it('reports claim names and lifetime, not claim values', () => {
    const token = `${b64({ alg: 'ES256' })}.${b64({ sub: 's000001', iat: 100, exp: 3700 })}.sig`;
    const d = describeToken(token);
    expect(d).toMatchObject({ looksLikeJwt: true, lifetimeSeconds: 3600, alg: 'ES256' });
    expect(JSON.stringify(d)).not.toContain('s000001');
  });
  it('handles opaque tokens', () => {
    expect(describeToken('opaque-token-value')).toMatchObject({ looksLikeJwt: false });
    expect(describeToken(undefined)).toEqual({ present: false });
  });
});

describe('probe: Sanitizer', () => {
  const sample = [
    {
      id: 5,
      title: 'Analisi 1',
      teacher: 'Mario Rossi',
      email: 'mario.rossi@example.test',
      startsAt: '2026-11-10T08:30:00Z',
      status: 'confirmed',
      room: { name: 'Aula 12', latitude: 45.06 },
      note: 'Analisi 1',
      url: 'https://example.test/a?t=1',
    },
  ];
  it('replaces names, ids, rooms, links, coordinates; keeps dates and enums', () => {
    const { sanitized, problems } = new Sanitizer().run(sample);
    const text = JSON.stringify(sanitized);
    for (const real of ['Analisi', 'Rossi', 'Aula', 'example.test', '45.06']) {
      expect(text).not.toContain(real);
    }
    expect(text).toContain('2026-11-10T08:30:00Z');
    expect(text).toContain('confirmed');
    expect(problems).toEqual([]);
  });
  it('gives the same real text the same placeholder everywhere', () => {
    const s = new Sanitizer();
    const a = s.walk({ title: 'Analisi 1' }) as { title: string };
    const b = s.walk({ name: 'Analisi 1' }) as { name: string };
    expect(a.title).toBe(b.name);
    expect(s.walk({ name: 'Fisica' })).not.toEqual(b);
  });
  it('shifts dates by whole days consistently', () => {
    const s = new Sanitizer({ shiftDays: 30 });
    expect(s.walk({ d: '2026-11-10' })).toEqual({ d: '2026-12-10' });
    expect(s.walk({ d: '2026-11-10T08:30:00Z' })).toEqual({ d: '2026-12-10T08:30:00Z' });
  });
  it('flags leftovers: typed secrets, emails, tokens, student ids', () => {
    expect(leaks('{"a":"hello s123456"}')).toContain('Italian student id (s + 6 digits)');
    expect(leaks('{"a":"x@y.it"}')).toContain('email address');
    expect(leaks('{"a":"mysecretuser"}', ['mysecretuser']).length).toBeGreaterThan(0);
    expect(leaks('{"a":"text-1"}')).toEqual([]);
  });
});

describe('probe: login helpers', () => {
  it('fills the body template without keeping the credentials in the template', () => {
    const body = fillTemplate(DEFAULT_TEMPLATE, 'u', 'p') as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'basic', username: 'u', password: 'p' });
    expect(JSON.stringify(DEFAULT_TEMPLATE)).not.toContain('"u"');
  });
  it('scrubs credentials from server error text before it is stored', () => {
    const ev = errorEvidence('{"message":"user mario-x not found, pw hunter22"}', [
      'mario-x',
      'hunter22',
    ]);
    expect(JSON.stringify(ev)).not.toContain('mario-x');
    expect(JSON.stringify(ev)).not.toContain('hunter22');
  });
  it('parses command line flags', () => {
    expect(parseArgs(['--enrol', '--shift-days', '30', '--base-url=http://x'])).toEqual({
      enrol: true,
      'shift-days': '30',
      'base-url': 'http://x',
    });
  });
});

describe('probe: Http', () => {
  async function withServer(
    handler: (url: string, headers: Record<string, unknown>) => [number, object],
    run: (base: string) => Promise<void>,
  ) {
    const server = createServer((req, res) => {
      const [status, body] = handler(req.url ?? '', req.headers);
      res.writeHead(status, {
        'content-type': 'application/json',
        'set-cookie': 'sid=VALUE; Path=/',
      });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`);
    } finally {
      server.close();
    }
  }

  it('sends the honest User-Agent, keeps cookie names but not values', async () => {
    await withServer(
      (_u, h) => [200, { ua: h['user-agent'] }],
      async (base) => {
        const http = new Http({ baseUrl: base, log: () => undefined });
        const r = await http.request('GET', '/x');
        expect(r.text).toContain('polito-cal-sync/');
        expect(r.cookieNames).toEqual(['sid']);
        expect(JSON.stringify(r)).not.toContain('VALUE');
      },
    );
  });
  it('stops on 429 and on requested statuses', async () => {
    await withServer(
      (u) => (u.includes('limited') ? [429, {}] : [403, {}]),
      async (base) => {
        const http = new Http({ baseUrl: base, log: () => undefined });
        await expect(http.request('GET', '/limited')).rejects.toBeInstanceOf(StopProbe);
        await expect(http.request('GET', '/x', { stopOn: [403] })).rejects.toBeInstanceOf(
          StopProbe,
        );
        expect((await http.request('GET', '/x')).status).toBe(403); // not requested: just returned
      },
    );
  });
});
