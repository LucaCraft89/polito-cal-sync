import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS } from './http.js';

/** `web/` at the repository root; the same relative path works from `src/web` and from `dist/web`. */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

interface StaticFile {
  body: Buffer;
  type: string;
  etag: string;
}

/**
 * The files of the UI (`web/`), read once at start. Only files that exist in that folder are ever served,
 * looked up by exact path in a map, so there is no path to traverse. Same security headers as the API,
 * except caching: static files may be cached but must be revalidated (ETag), so an upgrade shows at once.
 */
export class StaticFiles {
  private readonly files = new Map<string, StaticFile>();

  constructor(root: string = DEFAULT_WEB_ROOT) {
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else {
          const type = TYPES[extname(name).toLowerCase()];
          if (!type) continue; // an unknown file type is never served
          const body = readFileSync(full);
          const key = `/${relative(root, full).split(sep).join('/')}`;
          this.files.set(key === '/index.html' ? '/' : key, {
            body,
            type,
            etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 24)}"`,
          });
        }
      }
    };
    walk(root);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Answers a GET/HEAD for a known path and returns true; false for anything else. */
  serve(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const file = this.files.get(path);
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const headers = {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-cache',
      ETag: file.etag,
      'Content-Type': file.type,
    };
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers).end();
      return true;
    }
    res.writeHead(200, { ...headers, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
    return true;
  }
}
