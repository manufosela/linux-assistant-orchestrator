import pino from 'pino';

/**
 * Creates a structured logger instance.
 * Full prompt/content logging is intentionally disabled for privacy.
 *
 * @param {{ level?: string, name?: string, pretty?: boolean }} options
 * @returns {import('pino').Logger}
 */
export function createLogger({ level = 'info', name = 'assistant', pretty = false } = {}) {
  const transport = pretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined;

  return pino({
    name,
    level,
    transport,
    serializers: {
      // Prevent accidental full object logging at top level
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
      err: pino.stdSerializers.err,
    },
  });
}
