import { readFileSync } from 'node:fs';

/** Reads the version from package.json (same relative location from src/ and dist/). */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

/** Honest User-Agent for every outgoing request (AGENTS.md: low traffic, identify ourselves). */
export const USER_AGENT = `polito-cal-sync/${VERSION} (personal, self-hosted)`;
