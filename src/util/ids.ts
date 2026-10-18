import { randomUUID } from 'node:crypto';

/** Short, sortable, collision-free identifiers for runs and agents. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = randomUUID().slice(0, 8);
  return `${prefix}_${time}${rand}`;
}

/** A filesystem-safe slug derived from a human label (used for agent names). */
export function slugify(value: string, fallback = 'agent'): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return slug === '' ? fallback : slug;
}