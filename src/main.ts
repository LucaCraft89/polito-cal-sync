import { runCli } from './cli/index.js';

// .env is optional (Docker passes real environment variables); Node 22 can read it natively.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file: fine */
}

process.exitCode = await runCli(process.argv.slice(2), process.env, {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  logStream: process.stderr,
});
