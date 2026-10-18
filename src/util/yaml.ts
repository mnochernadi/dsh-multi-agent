/**
 * A small, dependency-free YAML subset.
 *
 * The dashboard needs YAML for exactly two jobs, and this module covers both
 * without pulling a parser into the dependency tree:
 *
 *  1. Emitting a *run patch* — a Cordis loader overlay that selects the
 *     provider/model for one agent run. Output is ordinary block-style YAML so
 *     a failed run can be debugged by reading the generated file.
 *  2. Reading a DSH profile patch such as
 *     `$DSH_HOME/profiles/desktop/cordis.patch.yml` to import the provider and
 *     model catalogue the user already configured in the Harness app.
 *
 * The parser is deliberately tolerant rather than complete: it understands
 * block mappings, block sequences, quoted and plain scalars, flow collections,
 * comments, document markers, and block scalars. Values carrying a `!!js` tag
 * are kept as raw text instead of being evaluated — importing a config must
 * never execute anything.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface SourceLine {
  indent: number;
  content: string;
  line: number;
}

const RESERVED_PLAIN = new Set([
  'true', 'false', 'null', 'yes', 'no', 'on', 'off', '~', 'y', 'n', 'nan', 'inf', '-inf',
]);

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

/* ------------------------------------------------------------------ parsing */

/** Parse YAML text into plain JavaScript values. Throws on structural errors. */
export function parseYaml(text: string): YamlValue {
  const lines = toSourceLines(text);
  if (lines.length === 0) return null;
  const state = { index: 0 };
  const value = parseNode(lines, state, lines[0]!.indent);
  return value;
}

function toSourceLines(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    const original = raw[i]!;
    const withoutComment = stripComment(original);
    if (withoutComment.trim() === '') continue;
    const trimmed = withoutComment.trim();
    if (trimmed === '---' || trimmed === '...') continue;
    out.push({
      indent: countIndent(withoutComment),
      content: trimmed,
      line: i + 1,
    });
  }
  return out;
}

function countIndent(value: string): number {
  let n = 0;
  while (n < value.length && value[n] === ' ') n += 1;
  return n;
}

/** Remove a trailing `# comment`, honouring quoted sections. */
function stripComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && value[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i).replace(/\s+$/, '');
    }
  }
  return value.replace(/\s+$/, '');
}

function parseNode(lines: SourceLine[], state: { index: number }, indent: number): YamlValue {
  const line = lines[state.index];
  if (!line) return null;
  if (line.content === '-' || line.content.startsWith('- ')) {
    return parseSequence(lines, state, indent);
  }
  return parseMapping(lines, state, indent);
}

function parseSequence(lines: SourceLine[], state: { index: number }, indent: number): YamlValue {
  const result: YamlValue[] = [];
  while (state.index < lines.length) {
    const line = lines[state.index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) break;
    if (line.content !== '-' && !line.content.startsWith('- ')) break;

    const inline = line.content === '-' ? '' : line.content.slice(2).trim();
    if (inline === '') {
      state.index += 1;
      const next = lines[state.index];
      if (next && next.indent > indent) result.push(parseNode(lines, state, next.indent));
      else result.push(null);
      continue;
    }
    if (looksLikeKeyValue(inline)) {
      // Rewrite the item in place so the mapping parser sees a normal block map.
      lines[state.index] = { indent: indent + 2, content: inline, line: line.line };
      result.push(parseMapping(lines, state, indent + 2));
      continue;
    }
    state.index += 1;
    result.push(parseScalar(inline));
  }
  return result;
}

function parseMapping(lines: SourceLine[], state: { index: number }, indent: number): YamlValue {
  const result: { [key: string]: YamlValue } = {};
  while (state.index < lines.length) {
    const line = lines[state.index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) break;
    if (line.content === '-' || line.content.startsWith('- ')) break;

    const split = splitKeyValue(line.content);
    if (!split) {
      // A bare scalar where a mapping was expected: accept it as a single value.
      state.index += 1;
      return parseScalar(line.content);
    }
    state.index += 1;
    const { key, rest } = split;

    if (rest === '') {
      const next = lines[state.index];
      if (next && next.indent > indent) result[key] = parseNode(lines, state, next.indent);
      else result[key] = null;
      continue;
    }
    if (/^[|>][+-]?$/.test(rest)) {
      result[key] = readBlockScalar(lines, state, indent, rest);
      continue;
    }
    result[key] = parseScalar(rest);
  }
  return result;
}

function readBlockScalar(
  lines: SourceLine[],
  state: { index: number },
  parentIndent: number,
  marker: string,
): string {
  const folded = marker.startsWith('>');
  const chomp = marker.slice(1);
  const parts: string[] = [];
  let blockIndent: number | null = null;
  while (state.index < lines.length) {
    const line = lines[state.index]!;
    if (line.indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = line.indent;
    parts.push(' '.repeat(Math.max(0, line.indent - blockIndent)) + line.content);
    state.index += 1;
  }
  const joined = folded ? parts.join(' ') : parts.join('\n');
  return chomp === '-' ? joined : `${joined}\n`;
}

function looksLikeKeyValue(value: string): boolean {
  return splitKeyValue(value) !== null;
}

function splitKeyValue(value: string): { key: string; rest: string } | null {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && value[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) {
      const after = value[i + 1];
      if (after === undefined || after === ' ') {
        const rawKey = value.slice(0, i).trim();
        if (rawKey === '') return null;
        const key = rawKey.startsWith('"') || rawKey.startsWith("'")
          ? String(parseScalar(rawKey))
          : rawKey;
        return { key, rest: value.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

export function parseScalar(value: string): YamlValue {
  const text = value.trim();
  if (text === '') return null;
  if (text.startsWith('"')) return parseDoubleQuoted(text);
  if (text.startsWith("'")) return parseSingleQuoted(text);
  if (text.startsWith('[')) return parseFlow(text, '[', ']');
  if (text.startsWith('{')) return parseFlow(text, '{', '}');
  if (text.startsWith('!')) {
    // A tag such as `!!js/function`: keep the payload as text, never evaluate it.
    const space = text.search(/\s/);
    return space === -1 ? text : text.slice(space + 1).trim();
  }
  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(text)) return true;
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(text)) return false;
  if (NUMBER_RE.test(text) || HEX_RE.test(text)) {
    const num = HEX_RE.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
    if (Number.isFinite(num)) return num;
  }
  return text;
}

function parseDoubleQuoted(text: string): string {
  const end = findClosingQuote(text, '"');
  const body = text.slice(1, end);
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body.replace(/\\(.)/g, '$1');
  }
}

function parseSingleQuoted(text: string): string {
  const end = findClosingQuote(text, "'");
  return text.slice(1, end).replace(/''/g, "'");
}

function findClosingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i += 1;
        continue;
      }
      return i;
    }
    if (quote === '"' && text[i] === '\\') i += 1;
  }
  return text.length;
}

function parseFlow(text: string, open: string, close: string): YamlValue {
  const end = text.lastIndexOf(close);
  const body = end === -1 ? text.slice(1) : text.slice(1, end);
  const items = splitFlow(body);
  if (open === '[') return items.map((item) => parseScalar(item));
  const obj: { [key: string]: YamlValue } = {};
  for (const item of items) {
    const split = splitKeyValue(item.trim());
    if (split) obj[split.key] = parseScalar(split.rest);
  }
  return obj;
}

function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (current.trim() !== '') parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/* ---------------------------------------------------------------- emitting */

/** Serialise plain JavaScript values to block-style YAML. */
export function toYaml(value: YamlValue, indent = 0): string {
  const lines: string[] = [];
  emitValue(value, indent, lines, true);
  return lines.join('\n');
}

function emitValue(value: YamlValue, indent: number, lines: string[], topLevel: boolean): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${formatScalar(item)}`);
        continue;
      }
      if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        emitValue(item, indent + 2, lines, false);
        continue;
      }
      const entries = Object.entries(item);
      if (entries.length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      const [firstKey, firstValue] = entries[0]!;
      if (isScalar(firstValue)) {
        lines.push(`${pad}- ${formatKey(firstKey)}: ${formatScalar(firstValue)}`);
      } else if (isEmptyCollection(firstValue)) {
        lines.push(`${pad}- ${formatKey(firstKey)}: ${Array.isArray(firstValue) ? '[]' : '{}'}`);
      } else {
        lines.push(`${pad}- ${formatKey(firstKey)}:`);
        emitValue(firstValue, indent + 4, lines, false);
      }
      for (const [key, child] of entries.slice(1)) {
        if (isScalar(child)) {
          lines.push(`${pad}  ${formatKey(key)}: ${formatScalar(child)}`);
        } else if (isEmptyCollection(child)) {
          lines.push(`${pad}  ${formatKey(key)}: ${Array.isArray(child) ? '[]' : '{}'}`);
        } else {
          lines.push(`${pad}  ${formatKey(key)}:`);
          emitValue(child, indent + 4, lines, false);
        }
      }
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`${pad}{}`);
      return;
    }
    for (const [key, child] of entries) {
      if (isScalar(child)) {
        lines.push(`${pad}${formatKey(key)}: ${formatScalar(child)}`);
      } else if (isEmptyCollection(child)) {
        lines.push(`${pad}${formatKey(key)}: ${Array.isArray(child) ? '[]' : '{}'}`);
      } else {
        lines.push(`${pad}${formatKey(key)}:`);
        emitValue(child, indent + 2, lines, false);
      }
    }
    return;
  }
  if (topLevel && isScalar(value)) lines.push(`${pad}${formatScalar(value)}`);
}

function isScalar(value: YamlValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object';
}

function isEmptyCollection(value: YamlValue): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function formatKey(key: string): string {
  return needsQuoting(key) ? JSON.stringify(key) : key;
}

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  return needsQuoting(value) ? JSON.stringify(value) : value;
}

function needsQuoting(value: string): boolean {
  if (value === '') return true;
  if (RESERVED_PLAIN.has(value.toLowerCase())) return true;
  if (NUMBER_RE.test(value) || HEX_RE.test(value)) return true;
  if (/^[\s#&*!|>%@`"'[\]{},?:-]/.test(value)) return true;
  if (/[\s#:]$/.test(value)) return true;
  if (/:\s/.test(value) || /\s#/.test(value)) return true;
  if (/[\n\r\t]/.test(value)) return true;
  return false;
}
