/**
 * Argument templates for CLI engines.
 *
 * A template is a list of tokens with `{placeholder}` holes. The one subtle
 * rule is flag pairing: an empty value drops its token *and* the flag in front
 * of it, so `['--model', '{model}']` with no model chosen produces no arguments
 * rather than a dangling `--model`.
 */

export interface TemplateValues {
  prompt: string;
  model: string;
  cwd: string;
  sessionId: string;
  /** Expanded in place of a literal `{extra}` token. */
  extra?: string[];
}

const SINGLE_PLACEHOLDER = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/;
const ANY_PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Placeholders whose empty value removes the token and its preceding flag. */
const DROP_WHEN_EMPTY = new Set(['model', 'sessionId', 'prompt', 'cwd']);

export const KNOWN_PLACEHOLDERS = ['prompt', 'model', 'cwd', 'sessionId', 'extra'];

export function renderArgs(template: string[], values: TemplateValues): string[] {
  const out: string[] = [];
  for (let index = 0; index < template.length; index += 1) {
    const token = template[index]!;
    if (token === '{extra}') {
      out.push(...(values.extra ?? []));
      continue;
    }
    const single = SINGLE_PLACEHOLDER.exec(token);
    if (single) {
      const name = single[1]!;
      // An unknown placeholder is a typo in a user-edited template. Keep it so
      // the mistake reaches the command line and is visible, instead of quietly
      // dropping an argument and changing what the engine does.
      if (!KNOWN_PLACEHOLDERS.includes(name)) {
        out.push(token);
        continue;
      }
      const value = valueOf(name, values);
      if (value === '') {
        if (DROP_WHEN_EMPTY.has(name)) dropFlagFor(out, template, index);
        continue;
      }
      out.push(value);
      continue;
    }
    out.push(token.replace(ANY_PLACEHOLDER, (match, name: string) => {
      if (!KNOWN_PLACEHOLDERS.includes(name)) return match;
      const value = valueOf(name, values);
      return value === '' ? match : value;
    }));
  }
  return out;
}

/**
 * Remove the flag that introduced an empty value.
 *
 * Only the flag belonging to *this* placeholder is removed: the check requires
 * that the previous template token is that flag and that it is still the last
 * argument emitted. Otherwise a task text that merely starts with a dash
 * (`--message "{prompt}"`) would delete the prompt along with the flag.
 */
function dropFlagFor(out: string[], template: string[], index: number): void {
  const previous = template[index - 1];
  if (previous === undefined) return;
  if (!previous.startsWith('-') || previous.length < 2) return;
  if (previous.includes('{')) return;
  if (out[out.length - 1] !== previous) return;
  out.pop();
}

function valueOf(name: string, values: TemplateValues): string {
  if (name === 'prompt') return values.prompt;
  if (name === 'model') return values.model;
  if (name === 'cwd') return values.cwd;
  if (name === 'sessionId') return values.sessionId;
  return '';
}

/** Whether a template references a placeholder at all. */
export function templateUses(template: string[], name: string): boolean {
  return template.some(
    (token) => token === `{${name}}` || token.includes(`{${name}}`),
  );
}

/** Substitute placeholders inside a plain string (used for handoff commands). */
export function renderString(template: string, values: TemplateValues): string {
  return template.replace(ANY_PLACEHOLDER, (match, name: string) => {
    if (!KNOWN_PLACEHOLDERS.includes(name)) return match;
    const value = valueOf(name, values);
    return value === '' ? match : value;
  });
}