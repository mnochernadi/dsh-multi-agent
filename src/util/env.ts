import { readFileSync } from 'node:fs';

/**
 * Read a `.env` file into `process.env` without overwriting variables that are
 * already set, so a shell export always wins over the file.
 *
 * Values are parsed, never executed, and nothing is logged — a malformed line
 * is skipped rather than fatal.
 */
export function loadDotEnv(path: string): { loaded: boolean; keys: string[] } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { loaded: false, keys: [] };
  }
  const keys: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys };
}

/** Environment value, treating an empty string as absent (mirrors DSH itself). */
export function envValue(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function envFlag(name: string, fallback: boolean): boolean {
  const value = envValue(name);
  if (value === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

export function envInt(name: string, fallback: number): number {
  const value = envValue(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
