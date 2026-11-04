import { pino, type DestinationStream, type Logger } from 'pino';
import { redactSecrets } from './secret-patterns.js';

/** Field names whose value is always censored, at the top level and one level deep. */
const SECRET_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authtoken',
  'authorization',
  'cookie',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'apiKey',
  'api_key',
];

const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.headers.${k}`]);

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/**
 * JSON logger that cannot leak credentials: known secret fields are censored, and every
 * message and error text is scrubbed with the same patterns the repository secret scan uses.
 */
export function createLogger(level: LogLevel = 'info', destination?: DestinationStream): Logger {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      err: (e: unknown) => {
        if (!(e instanceof Error)) return redactSecrets(String(e));
        return {
          type: e.name,
          message: redactSecrets(e.message),
          ...(e.stack ? { stack: redactSecrets(e.stack) } : {}),
        };
      },
    },
    hooks: {
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(
          this,
          args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a)),
        );
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
