/**
 * Minimal structured logger.
 *
 * One JSON object per line keeps logs greppable and works everywhere without
 * pulling in a logging dependency for a service this size.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Reads LOG_LEVEL on each call so tests and operators can mute output at runtime. */
function threshold(): number {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (configured === undefined || configured === '') return PRIORITY.info;
  if (configured === 'silent' || configured === 'off' || configured === 'none') return Infinity;
  return PRIORITY[configured as LogLevel] ?? PRIORITY.info;
}

export function log(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
): void {
  if (PRIORITY[level] < threshold()) return;

  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...context,
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
