// Login helpers shared by 02-login.mjs and 03-samples.mjs.
// Credentials live only in local variables of the running process.

import { readFileSync } from 'node:fs';
import { describeToken } from './jwt.mjs';
import { shapeOfBody } from './shape.mjs';

/** The login body per docs/RESEARCH.md (spec: type basic = username + password, plus preferences). UNVERIFIED. */
export const DEFAULT_TEMPLATE = {
  type: 'basic',
  username: '$username',
  password: '$password',
  preferences: {},
};

/** Loads a custom body template (JSON with the strings "$username" and "$password"). */
export function loadTemplate(path) {
  if (!path) return DEFAULT_TEMPLATE;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function fillTemplate(value, username, password) {
  if (value === '$username') return username;
  if (value === '$password') return password;
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, username, password));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillTemplate(v, username, password)]),
    );
  }
  return value;
}

/** Removes any secret values from a server text before it is stored. */
export function scrub(text, secrets) {
  let out = text;
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join('<redacted>');
  return out;
}

/** Server error text is evidence (it may say "MFA required"), so we keep a short scrubbed part of it. */
export function errorEvidence(text, secrets) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw: scrub(text, secrets).slice(0, 200) };
  }
  const pick = {};
  if (parsed && typeof parsed === 'object') {
    for (const k of ['message', 'error', 'code', 'type', 'title', 'detail', 'status', 'errors']) {
      if (k in parsed)
        pick[k] = JSON.parse(scrub(JSON.stringify(parsed[k]), secrets).slice(0, 400) || 'null');
    }
  }
  return pick;
}

export function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One login request. Returns what we may record (no values) plus the token for in-memory use.
 * @param {import('./http.mjs').Http} http
 */
export async function login(http, template, username, password) {
  const body = fillTemplate(template, username, password);
  const res = await http.request('POST', '/auth/login', { body });
  const secrets = [username, password];
  const parsed = safeParse(res.text);
  const token = parsed && typeof parsed === 'object' ? parsed.token : undefined;
  const ok = res.status >= 200 && res.status < 300;
  return {
    token: typeof token === 'string' ? token : undefined,
    record: {
      status: res.status,
      headers: res.headers,
      cookieNames: res.cookieNames,
      bodyShape: shapeOfBody(res.text, res.headers['content-type']),
      identityKeys:
        ok && parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : undefined,
      token: ok ? describeToken(token) : undefined,
      evidence: ok ? undefined : errorEvidence(res.text, secrets),
    },
  };
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
