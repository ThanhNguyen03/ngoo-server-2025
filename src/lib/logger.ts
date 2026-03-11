/**
 * Structured logger factory built on top of pino.
 *
 * Pino writes JSON to stdout by default, which is the recommended pattern for
 * production services — the infrastructure (Docker, PM2, cloud logging) is
 * responsible for routing and formatting. Pipe through `npx pino-pretty` in
 * local development for human-readable output.
 *
 * Usage:
 *   import { createLogger } from '@lib';
 *   const logger = createLogger('MyModule');
 *   logger.info('something happened');
 *   logger.error({ err }, 'operation failed');   // ← pino convention: object first
 *
 * Circular dependency note: this module reads LOG_LEVEL directly from
 * process.env instead of through the `@helper` config module. This prevents
 * a circular import: helper/paypal.ts → @lib → lib/logger → @helper → helper/paypal.ts.
 * Loggers must be available before config validation completes, so reading
 * process.env here is intentional and correct.
 */
import pino from 'pino';

/** Valid pino log levels */
type TLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const VALID_LEVELS: TLogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const rawLevel = process.env.LOG_LEVEL ?? 'info';
const level: TLogLevel = VALID_LEVELS.includes(rawLevel as TLogLevel) ? (rawLevel as TLogLevel) : 'info';

/**
 * Root pino instance, shared across all child loggers.
 * Level is controlled by the LOG_LEVEL environment variable (default: info).
 * Changing the root level at runtime applies to all existing child loggers.
 */
const rootLogger = pino({
  level,
  // Serialize Error instances via pino's built-in `err` serializer so that
  // stack traces and error codes are captured in the structured output.
  serializers: {
    err: pino.stdSerializers.err,
  },
  // Standard base fields: pid and hostname help with log aggregation.
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create a child logger with a `context` field for module-level tracing.
 *
 * Every log entry from the returned logger will include `"context":"<name>"`,
 * making it easy to filter logs by module in any log aggregation tool.
 *
 * @param context  Human-readable module name (e.g. `'PayPalHandler'`, `'Redis'`)
 * @returns A pino child logger bound to the given context
 */
export function createLogger(context: string) {
  return rootLogger.child({ context });
}

export { rootLogger };
