/**
 * A minimal logging interface. `console`, pino, winston, bunyan and most other loggers satisfy it as-is.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const noop = () => {};

export const noopLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
