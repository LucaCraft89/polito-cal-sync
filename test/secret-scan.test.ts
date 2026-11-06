import { describe, expect, it } from 'vitest';
import { checkFileName, scanText } from '../scripts/secret-scan.js';
import { redactSecrets } from '../src/util/secret-patterns.js';

// Fake secrets are assembled at runtime so this file never contains a scannable literal.
const fakeClientSecret = 'GOCSPX-' + 'a1B2c3D4'.repeat(4);
const fakeAccessToken = 'ya29.' + 'a0Af'.repeat(10);
const fakeRefresh = '1//' + '0gAbC'.repeat(10);
const fakeJwt = ['eyJ' + 'h'.repeat(12), 'eyJ' + 'p'.repeat(12), 's'.repeat(12)].join('.');

describe('secret scan', () => {
  it.each([
    ['google-client-secret', `x = "${fakeClientSecret}"`],
    ['google-access-token', `Authorization: ${fakeAccessToken}`],
    ['google-refresh-token', `refresh ${fakeRefresh}`],
    ['jwt', `t=${fakeJwt}`],
    ['private-key', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['url-credentials', 'https://student:' + 'hunter2@example.org/x'],
    [
      'moodle-authtoken',
      'https://m.example.org/calendar/export_execute.php?authtoken=' + 'ab12'.repeat(8),
    ],
    ['secret-assignment', 'const password = "' + 'correcthorse' + '";'],
  ])('flags %s', (rule, line) => {
    const findings = scanText('src/x.ts', line);
    expect(findings.map((f) => f.rule)).toContain(rule);
  });

  it('does not print or keep matched text in findings', () => {
    const [finding] = scanText('src/x.ts', fakeAccessToken);
    expect(JSON.stringify(finding)).not.toContain(fakeAccessToken);
  });

  it('ignores placeholders, plain prose and marked lines', () => {
    expect(scanText('a.ts', 'const password = "changeme";')).toEqual([]);
    expect(scanText('a.md', 'Never log the token or the password.')).toEqual([]);
    expect(scanText('a.ts', `${fakeAccessToken} // secret-scan:ignore`)).toEqual([]);
  });

  it('requires .env.example to hold placeholders only', () => {
    expect(scanText('.env.example', 'GOOGLE_CLIENT_SECRET=')).toEqual([]);
    const findings = scanText('.env.example', 'GOOGLE_CLIENT_SECRET=realvalue123');
    expect(findings.map((f) => f.rule)).toEqual(['env-example-value']);
  });

  it('rejects files that normally hold secrets or state', () => {
    expect(checkFileName('.env')).toBeDefined();
    expect(checkFileName('data/state.db')).toBeDefined();
    expect(checkFileName('config/tokens.json')).toBeDefined();
    expect(checkFileName('.env.example')).toBeUndefined();
    expect(checkFileName('src/main.ts')).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('removes secrets from free text', () => {
    const text = `failed with ${fakeAccessToken} and password=hunter2 for ${fakeClientSecret}`;
    const out = redactSecrets(text);
    expect(out).not.toContain(fakeAccessToken);
    expect(out).not.toContain(fakeClientSecret);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('password=[REDACTED]');
  });
});
