/** Minimal structured logging for the dashboard server (stdout only). */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

const SECRET_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]+/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
];

/**
 * Never let a credential reach a log line. Provider keys are read by `dsh`
 * itself, but a mistyped value or an echoed command could still surface here.
 */
export function redact(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '***redacted***');
  return out;
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(message)}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (extra === undefined) stream.write(`${line}\n`);
  else stream.write(`${line} ${redact(safeJson(extra))}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, extra) => emit('debug', scope, message, extra),
    info: (message, extra) => emit('info', scope, message, extra),
    warn: (message, extra) => emit('warn', scope, message, extra),
    error: (message, extra) => emit('error', scope, message, extra),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}