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
export async function login(http, variant, username, password) {
  const body = fillTemplate(variant.template, username, password);
  const res = await http.request('POST', '/auth/login', {
    body,
    ...(variant.query ? { query: variant.query } : {}),
  });
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

// The first real answer (probe 02, 2026-11-04): HTTP 500 {"error":"Missing required params
// (device_platform,device_version,device_model)","code":-6}. Where those three go is UNKNOWN, so the
// shape check tries these variants with FAKE credentials, in order, and the first one the server answers
// with 401/403 is used. Values are honest (we are not a phone app) and carry no hostname or user name.
const DEVICE = {
  device_platform: process.platform,
  device_version: process.version,
  device_model: 'polito-cal-sync',
};
const BASIC = { type: 'basic', username: '$username', password: '$password' };

export const LOGIN_VARIANTS = [
  { name: 'device-in-body', template: { ...BASIC, ...DEVICE, preferences: {} } },
  { name: 'device-in-preferences', template: { ...BASIC, preferences: { ...DEVICE } } },
  { name: 'device-in-query', template: { ...BASIC, preferences: {} }, query: { ...DEVICE } },
];

/** Names only (no secrets) so probe 03 can reuse the variant 02 found. */
export const variantByName = (name) => LOGIN_VARIANTS.find((v) => v.name === name);

/**
 * Sends FAKE credentials with each variant until the server answers 401/403 (it understood the request
 * and rejected the credentials). Anything else, including 500, means "shape not accepted": the real
 * password is never sent in that case. At most one request per variant.
 */
export async function findAcceptedVariant(http, variants) {
  const tries = [];
  for (const variant of variants) {
    const fake = await login(http, variant, 'probe-no-such-user', 'probe-wrong-password');
    const status = fake.record.status;
    tries.push({
      variant: variant.name,
      status,
      bodyShape: fake.record.bodyShape,
      // Fake credentials are not secret, so the server's short error text is kept.
      serverSaid: fake.record.evidence,
    });
    if (status === 401 || status === 403) return { accepted: variant, tries };
  }
  return { accepted: undefined, tries };
}
