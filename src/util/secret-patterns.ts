/**
 * One list of "what a secret looks like", shared by the repository secret scan
 * (scripts/secret-scan.ts) and the log/error redaction (src/util/logger.ts, errors.ts).
 * Patterns are deliberately specific: a scan that cries wolf gets ignored.
 */

export interface SecretPattern {
  id: string;
  description: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'google-client-secret',
    description: 'Google OAuth client secret',
    regex: /GOCSPX-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: 'google-client-id',
    description: 'Google OAuth client ID',
    regex: /\b\d{8,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/,
  },
  {
    id: 'google-access-token',
    description: 'Google OAuth access token',
    regex: /\bya29\.[A-Za-z0-9_-]{20,}/,
  },
  {
    id: 'google-refresh-token',
    description: 'Google OAuth refresh token',
    regex: /\b1\/\/[0-9A-Za-z_-]{30,}/,
  },
  {
    id: 'private-key',
    description: 'PEM private key block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/,
  },
  {
    id: 'bearer-token',
    description: 'HTTP bearer token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/,
  },
  {
    id: 'url-credentials',
    description: 'user:password embedded in a URL',
    regex: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/,
  },
  {
    id: 'moodle-authtoken',
    description: 'Moodle calendar export auth token',
    regex: /\bauthtoken=[0-9A-Za-z]{16,}/,
  },
];

/** Values that obviously are placeholders (used by the scanner for `key = "value"` lines). */
export const PLACEHOLDER_VALUE =
  /^(?:x{3,}|\*{3,}|\.{3,}|changeme|change-me|placeholder|todo|none|null|undefined|example.*|your[-_ ].*|<.*>|\$\{.*\}|\$[A-Z_]+)$/i;

/** A secret-like name assigned a quoted literal of 8+ characters. */
export const SECRET_ASSIGNMENT =
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authtoken|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;

const KEY_VALUE =
  /\b(password|passwd|secret|token|authtoken|authorization|api[_-]?key)=([^\s&"']+)/gi;

/** Replaces anything that looks like a secret with [REDACTED]. Safe to call on any string. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(new RegExp(p.regex.source, 'g'), '[REDACTED]');
  }
  return out.replace(KEY_VALUE, (_m, key: string) => `${key}=[REDACTED]`);
}
