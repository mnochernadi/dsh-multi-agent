import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Windows command-wrapper handling.
 *
 * Most agent CLIs installed by npm (or bundled inside a desktop app) are not
 * executables: they are `.cmd` shims that forward to `node <script>`, or to a
 * bundled binary. Reading the shim lets the dashboard spawn the real target
 * directly, which avoids a shell entirely — and therefore avoids every quoting
 * hazard that comes with passing prompts and paths containing spaces.
 */

/** Split a Windows command line into tokens, honouring double quotes. */
export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens.filter((token) => token !== '' && token !== '%*' && token !== '$*');
}

/** Whether a token should be resolved as a filesystem path. */
export function looksLikePath(token: string): boolean {
  return /[\\/]/.test(token) || /\.(exe|cmd|bat|com|ps1|js|mjs|cjs)$/i.test(token);
}

export interface WrapperLaunch {
  command: string;
  argsPrefix: string[];
  env: Record<string, string>;
  /** Spawn through a shell because the wrapper could not be taken apart. */
  shell: boolean;
  /** The file the user recognizes as the launcher. */
  scriptPath: string;
}

/** `cmd.exe` keywords that mean we grabbed a control-flow segment, not the program. */
const CMD_KEYWORDS = new Set([
  'endlocal', 'setlocal', 'goto', 'title', 'if', 'else', 'set', 'call', 'echo',
  'exit', 'pause', 'rem', 'shift', 'for', 'do', 'cd', 'pushd', 'popd',
]);

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Collect `SET name=value` assignments so `%name%` can be expanded. */
function collectSetVariables(text: string, dir: string): Map<string, string> {
  const variables = new Map<string, string>();
  variables.set('dp0', `${dir}${path.sep}`);
  variables.set('COMSPEC', process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe');
  for (const match of text.matchAll(/set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$/gim)) {
    variables.set(match[1]!, match[2]!.trim());
  }
  // Values refer to each other (`_prog` is built from `dp0`), so expand twice.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [name, value] of [...variables]) {
      variables.set(name, expandVariables(value, variables));
    }
  }
  return variables;
}

function expandVariables(value: string, variables: Map<string, string>): string {
  return value
    .replace(/%~dp0/gi, variables.get('dp0') ?? '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => {
      const found = variables.get(name) ?? variables.get(name.toLowerCase());
      // Unknown names are left alone so nothing is silently emptied.
      return found ?? match;
    });
}

/** Drop redirections such as `2>NUL` that would otherwise become arguments. */
function stripRedirections(line: string): string {
  return line.replace(/\d?>\s*(NUL|&\d)/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Read a `.cmd`/`.bat` shim and return its real command line.
 *
 * Two shapes matter in practice:
 *  - a plain wrapper (`"…\App.exe" --flag "…\cli.js" %*`), which is what the
 *    DeepSeek Harness launcher and IDE shims use;
 *  - an npm `cmd-shim`, whose last line is a control-flow chain
 *    (`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "…" %*`).
 *    Taking the first token there yields `endLocal`, which is not a program, so
 *    the chain is split and only the segment that actually forwards `%*` is used.
 */
function parseCmdShim(file: string): WrapperLaunch | null {
  const text = readText(file);
  if (!text) return null;
  const dir = path.dirname(file);
  const variables = collectSetVariables(text, dir);

  const candidateLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(%\*|\$\*)/.test(line) && !/^(rem\b|::|@?echo)/i.test(line));

  for (const line of candidateLines) {
    const expanded = stripRedirections(expandVariables(line, variables));
    const segments = expanded.split(/\s*(?:&&|\|\||&)\s*/).filter((segment) => segment !== '');
    for (const segment of segments.reverse()) {
      if (!/(%\*|\$\*)/.test(segment)) continue;
      const cleaned = segment.replace(/(%\*|\$\*)/g, ' ').trim();
      const tokens = tokenizeCommandLine(cleaned);
      if (tokens.length === 0) continue;

      const [commandRaw, ...rest] = tokens;
      const bare = path.basename(commandRaw!).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
      if (CMD_KEYWORDS.has(bare)) continue;
      // A leftover variable placeholder means expansion was incomplete.
      if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(commandRaw!)) continue;

      const command = looksLikePath(commandRaw!) ? path.resolve(commandRaw!) : commandRaw!;
      const argsPrefix = rest.map((token) => (looksLikePath(token) ? path.resolve(dir, token) : token));
      // A path-like command that does not exist means this segment is not it.
      if (looksLikePath(command) && !existsSync(command)) continue;
      return { command, argsPrefix, env: {}, shell: false, scriptPath: file };
    }
  }
  return null;
}

function parsePowerShellScript(file: string): WrapperLaunch | null {
  const host = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  return {
    command: host,
    argsPrefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
    env: {},
    shell: false,
    scriptPath: file,
  };
}

function parseNodeScript(file: string): WrapperLaunch {
  return {
    command: process.execPath,
    argsPrefix: [file],
    env: {},
    shell: false,
    scriptPath: file,
  };
}

/**
 * Turn any launcher file into an exact command line.
 *
 * Returns `shell: true` only as a last resort, for a wrapper whose contents
 * cannot be understood.
 */
export function parseCommandWrapper(file: string): WrapperLaunch | null {
  const resolved = path.resolve(file);
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return parseCmdShim(resolved);
  if (ext === '.ps1') return parsePowerShellScript(resolved);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return parseNodeScript(resolved);
  if (process.platform === 'win32' && (ext === '.exe' || ext === '.com')) {
    return { command: resolved, argsPrefix: [], env: {}, shell: false, scriptPath: resolved };
  }
  if (process.platform !== 'win32') {
    return { command: resolved, argsPrefix: [], env: {}, shell: false, scriptPath: resolved };
  }
  // Unknown extension on Windows: let the shell interpret it.
  return { command: resolved, argsPrefix: [], env: {}, shell: true, scriptPath: resolved };
}