export type LogDomain = "action" | "notify" | "modlist" | "cache" | "app";

export interface DomainLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Creates a domain-prefixed logger mapping to standard console methods.
 * - debug -> console.debug (visible with devvit logs -v)
 * - info  -> console.log (visible in default devvit logs)
 * - warn  -> console.warn
 * - error -> console.error
 *
 * @param domain Subsystem domain name (e.g. 'action', 'notify', 'modlist', 'cache', 'app')
 * @returns DomainLogger instance
 */
export function createLogger(domain: LogDomain): DomainLogger {
  const prefix = `[${domain}]`;
  return {
    debug: (message: string, ...args: unknown[]) => console.debug(`${prefix} ${message}`, ...args),
    info: (message: string, ...args: unknown[]) => console.log(`${prefix} ${message}`, ...args),
    warn: (message: string, ...args: unknown[]) => console.warn(`${prefix} ${message}`, ...args),
    error: (message: string, ...args: unknown[]) => console.error(`${prefix} ${message}`, ...args),
  };
}

export const logger = {
  action: createLogger("action"),
  notify: createLogger("notify"),
  modlist: createLogger("modlist"),
  cache: createLogger("cache"),
  app: createLogger("app"),
};
