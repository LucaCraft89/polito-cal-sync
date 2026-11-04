/**
 * Secret scan, part of `pnpm check`. Scans every tracked or not-ignored file for credentials and
 * fails on forbidden file names. It never prints the matched text, only file:line and the rule id.
 * A line containing `secret-scan:ignore` is skipped (use only for deliberate test strings).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLACEHOLDER_VALUE,
  SECRET_ASSIGNMENT,
  SECRET_PATTERNS,
} from '../src/util/secret-patterns.js';

export interface Finding {
  file: string;
  line: number;
  rule: string;
  description: string;
}

const MAX_BYTES = 1_000_000;
const SKIP_FILES = new Set(['pnpm-lock.yaml']);
const FORBIDDEN_NAMES: readonly RegExp[] = [
  /^\.env(?:\..+)?$/,
  /^credentials\.json$/,
  /^client_secret.*\.json$/,
  /^tokens?\.json$/,
  /\.(?:pem|key|p12|pfx)$/,
  /\.(?:sqlite|sqlite3|db)$/,
];
const ALLOWED_NAMES = new Set(['.env.example']);
const SECRETISH_ENV_KEY = /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY)/i;

export function checkFileName(path: string): Finding | undefined {
  const name = basename(path);
  if (ALLOWED_NAMES.has(name)) return undefined;
  const hit = FORBIDDEN_NAMES.some((re) => re.test(name));
  if (!hit && !/(^|\/)data\//.test(path)) return undefined;
  return {
    file: path,
    line: 0,
    rule: 'forbidden-file',
    description: 'file that normally holds secrets or state must not be committed',
  };
}

export function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  const isEnvExample = basename(path) === '.env.example';
  lines.forEach((line, index) => {
    if (line.includes('secret-scan:ignore')) return;
    for (const p of SECRET_PATTERNS) {
      if (p.regex.test(line)) {
        findings.push({ file: path, line: index + 1, rule: p.id, description: p.description });
      }
    }
    const assignment = SECRET_ASSIGNMENT.exec(line);
    if (assignment?.[1] && !PLACEHOLDER_VALUE.test(assignment[1])) {
      findings.push({
        file: path,
        line: index + 1,
        rule: 'secret-assignment',
        description: 'secret-like name assigned a literal value',
      });
    }
    if (isEnvExample) {
      const kv = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      const key = kv?.[1];
      const value = kv?.[2] ?? '';
      if (key && SECRETISH_ENV_KEY.test(key) && value !== '' && !PLACEHOLDER_VALUE.test(value)) {
        findings.push({
          file: path,
          line: index + 1,
          rule: 'env-example-value',
          description: '.env.example must hold placeholders only',
        });
      }
    }
  });
  return findings;
}

export function listCandidateFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
    },
  );
  return out.split('\0').filter((f) => f.length > 0);
}

export function scanFiles(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const nameFinding = checkFileName(file);
    if (nameFinding) findings.push(nameFinding);
    if (SKIP_FILES.has(basename(file))) continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // deleted but still listed
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    findings.push(...scanText(file, buf.toString('utf8')));
  }
  return findings;
}

function main(): void {
  let files: string[];
  try {
    files = listCandidateFiles();
  } catch {
    console.error(
      'secret-scan: cannot list files. Run it inside the git checkout (git must be installed).',
    );
    process.exit(2);
  }
  const findings = scanFiles(files);
  if (findings.length === 0) {
    console.log(`secret-scan: ok (${files.length} files checked)`);
    return;
  }
  console.error('secret-scan: FAILED. Matched text is intentionally not printed.');
  for (const f of findings) {
    console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}] ${f.description}`);
  }
  console.error(
    'Remove the secret, rotate it if it was ever real, and keep it in DATA_DIR or .env (both git-ignored).',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
