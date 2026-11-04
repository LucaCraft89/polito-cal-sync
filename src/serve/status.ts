import { createServer, type Server } from 'node:http';
import { evaluateHealth, type Heartbeat } from './heartbeat.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface StatusServer {
  listen(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Minimal local status endpoint. GET /status -> JSON, GET /healthz -> 200 or 503.
 * It shows counts and codes only: no event text, no feed URLs, nothing secret. Requests whose
 * Host header is not a local name are refused (protects against DNS-rebinding from a web page).
 */
export function createStatusServer(
  snapshot: () => Heartbeat,
  o: { bind: string; port: number; now?: () => Date },
): StatusServer {
  const now = o.now ?? (() => new Date());
  const server: Server = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const json = (code: number, body: unknown) =>
      res
        .writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(body));
    if (!LOCAL_HOSTS.has(host)) return json(421, { error: 'use localhost' });
    if (req.method !== 'GET') return json(405, { error: 'GET only' });
    const hb = snapshot();
    const health = evaluateHealth(hb, now());
    if (req.url === '/healthz') return json(health.healthy ? 200 : 503, health);
    if (req.url === '/status' || req.url === '/') return json(200, { ...health, ...hb });
    return json(404, { error: 'not found' });
  });
  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port, o.bind, () => {
          const a = server.address();
          resolve(typeof a === 'object' && a ? a.port : o.port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
