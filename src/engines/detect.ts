import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { envValue } from '../util/env.ts';
import { captureProcess, runProcess } from '../util/process.ts';
import { createLogger } from '../util/log.ts';
import { parseCommandWrapper } from '../util/winwrap.ts';
import { probeLauncher } from '../dsh/launcher.ts';
import { DSH_ENGINE_ID } from './presets.ts';
import { renderArgs, renderString } from './template.ts';
import { getParser } from './parsers.ts';
import { emptyParserState, type EngineDefinition, type EngineDetection, type EngineHealthResult, type EngineLaunch } from './types.ts';

const log = createLogger('engines:detect');

/**
 * Engine detection: is this program on the machine, what version, and how must
 * it be launched?
 *
 * Availability is deliberately three-valued:
 *   missing   — nothing found
 *   installed — found, but the engine has not proven it can answer
 *   ready     — a health check completed successfully
 * A CLI that is installed but not signed in is the common real case, and
 * reporting it as "missing" would send the user looking in the wrong place.
 */

const CACHE_TTL_MS = 20_000;
/** Successful health checks are remembered far longer than a version probe. */
const HEALTH_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  detection: EngineDetection;
  at: number;
  /** Identifies the definition the entry was built from, so an edit re-probes. */
  signature: string;
}

interface HealthEntry {
  ok: boolean;
  message: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const healthResults = new Map<string, HealthEntry>();

/**
 * Cache key input: any change to how an engine is found (or to the DSH binary)
 * must invalidate the cached detection rather than report a stale executable.
 */
function detectionSignature(engine: EngineDefinition, dshBin: string | undefined): string {
  return JSON.stringify([engine.id, engine.enabled, normalizeDetectForSignature(engine), dshBin ?? '']);
}

/** Record the outcome of a health check so availability can report `ready`. */
export function recordHealthResult(engineId: string, ok: boolean, message: string): void {
  healthResults.set(engineId, { ok, message, at: Date.now() });
}

export function getHealthResult(engineId: string): HealthEntry | undefined {
  const entry = healthResults.get(engineId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > HEALTH_TTL_MS) {
    healthResults.delete(engineId);
    return undefined;
  }
  return entry;
}

/* --------------------------------------------------------------- paths */

/** Expand `%VAR%`, `$VAR`, `${VAR}` and a leading `~`. */
export function expandPathPattern(pattern: string): string {
  let out = pattern;
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => envValue(name) ?? match);
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string, plain: string) => {
    return envValue(braced ?? plain) ?? match;
  });
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    const home = envValue('USERPROFILE') ?? envValue('HOME') ?? '';
    out = home + out.slice(1);
  }
  return out;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Resolve a bare command name through PATH, honouring PATHEXT on Windows. */
export function resolveOnPath(name: string): string | null {
  if (/[\\/]/.test(name)) {
    const resolved = path.resolve(expandPathPattern(name));
    return isFile(resolved) ? resolved : null;
  }
  const dirs = (envValue('PATH') ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const extensions =
    process.platform === 'win32'
      ? (envValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (isFile(candidate)) return candidate;
    }
    const exact = path.join(dir, name);
    if (isFile(exact)) return exact;
  }
  return null;
}

const MAX_GLOB_RESULTS = 200;
const MAX_GLOB_DEPTH = 6;

/**
 * Expand a small glob: `*` matches one path segment, `**` matches any depth.
 * This is how versioned install layouts are found, e.g.
 * `%LOCALAPPDATA%/Claude-3p/claude-code/* * /claude.exe`.
 */
export function expandGlob(pattern: string, maxDepth = MAX_GLOB_DEPTH): string[] {
  const normalized = pattern.replace(/[\\/]+/g, path.sep);
  const parts = normalized.split(path.sep).filter((part) => part !== '');

  let roots: string[];
  let index: number;
  if (/^[A-Za-z]:$/.test(parts[0] ?? '')) {
    roots = [`${parts[0]}${path.sep}`];
    index = 1;
  } else if (normalized.startsWith(path.sep)) {
    roots = [path.sep];
    index = 1;
  } else {
    roots = ['.'];
    index = 0;
  }

  const results: string[] = [];
  const walk = (current: string, position: number, depth: number): void => {
    if (results.length >= MAX_GLOB_RESULTS) return;
    if (position >= parts.length) {
      if (isFile(current)) results.push(path.resolve(current));
      return;
    }
    const segment = parts[position]!;

    if (segment === '**') {
      // Zero segments first, then one level deeper — bounded so a `**` pattern
      // can never walk an entire drive.
      walk(current, position + 1, depth);
      if (depth >= maxDepth) return;
      for (const child of listDirectory(current)) walk(child, position, depth + 1);
      return;
    }
    if (/[*?]/.test(segment)) {
      const matcher = globSegmentMatcher(segment);
      for (const child of listDirectory(current)) {
        if (matcher.test(path.basename(child))) walk(child, position + 1, depth + 1);
      }
      return;
    }
    walk(path.join(current, segment), position + 1, depth + 1);
  };

  for (const root of roots) walk(root, index, 0);
  return results.slice(0, MAX_GLOB_RESULTS);
}

function listDirectory(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function globSegmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/* ------------------------------------------------------------- resolution */

export interface ExecutableCandidate {
  path: string;
  origin: 'path' | 'glob' | 'configured';
}

/** Every file that could be the engine, in the order it should be tried. */
export function candidateExecutables(engine: EngineDefinition, configuredPath?: string): ExecutableCandidate[] {
  const out: ExecutableCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: string | null, origin: ExecutableCandidate['origin']): void => {
    if (!candidate) return;
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    if (!isFile(resolved)) return;
    seen.add(key);
    out.push({ path: resolved, origin });
  };

  if (configuredPath && configuredPath.trim() !== '') push(expandPathPattern(configuredPath.trim()), 'configured');
  for (const command of engine.detect.commands) push(resolveOnPath(command), 'path');
  for (const pattern of engine.detect.searchGlobs ?? []) {
    const matches = expandGlob(expandPathPattern(pattern));
    // Versioned install layouts hold several copies side by side
    // (`.../claude-code/2.1.295/...` and `.../2.1.299/...`); prefer the newest.
    matches.sort(compareVersionsDescending);
    for (const match of matches) push(match, 'glob');
  }
  return out;
}

/** Order paths so that a higher embedded version number comes first. */
export function compareVersionsDescending(a: string, b: string): number {
  const versionOf = (value: string): number[] =>
    (/(\d+(?:\.\d+)+)/.exec(value)?.[1] ?? '')
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));
  const left = versionOf(a);
  const right = versionOf(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return b.localeCompare(a, undefined, { numeric: true });
}

/**
 * The command line an executable needs, taking wrappers into account.
 *
 * Returns `null` when a wrapper cannot be understood. Launching such a file
 * would require a shell, and a shell would interpret `&`, `|` and quotes inside
 * a prompt — so the dashboard refuses instead of running something arbitrary.
 */
export function resolveLaunch(executablePath: string): EngineLaunch | null {
  const wrapper = parseCommandWrapper(executablePath);
  if (!wrapper) {
    log.warn(`refusing to launch ${executablePath}: its wrapper could not be read`);
    return null;
  }
  if (wrapper.shell) {
    log.warn(`refusing to launch ${executablePath} through a shell`);
    return null;
  }
  return wrapper;
}

function normalizeDetectForSignature(engine: EngineDefinition): string {
  return JSON.stringify([
    engine.detect.commands,
    engine.detect.searchGlobs ?? [],
    engine.detect.versionArgs ?? [],
    engine.detect.versionRegex ?? '',
    engine.detect.executablePath ?? '',
  ]);
}

/** Extract a version string from `--version` output. */
export function extractVersion(output: string, pattern?: string): string | null {
  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
  if (firstLine === '') return null;
  if (pattern) {
    try {
      const match = new RegExp(pattern).exec(firstLine);
      if (match?.[1]) return match[1];
    } catch {
      /* fall through to the loose match */
    }
  }
  const loose = /([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(firstLine);
  return loose ? loose[1]! : firstLine.slice(0, 60);
}

/* --------------------------------------------------------------- detection */

export interface DetectOptions {
  /** Configured `dsh` launcher path (used by the built-in DSH engine). */
  dshBin?: string;
  /** Bypass the cache. */
  force?: boolean;
  /** Version-probe timeout. */
  timeoutMs?: number;
}

export async function detectEngine(
  engine: EngineDefinition,
  options: DetectOptions = {},
): Promise<EngineDetection> {
  const cacheKey = engine.id;
  const signature = detectionSignature(engine, options.dshBin);
  const cached = cache.get(cacheKey);
  if (!options.force && cached && cached.signature === signature && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.detection;
  }

  const detection = await detectUncached(engine, options);
  cache.set(cacheKey, { detection, at: Date.now(), signature });
  return detection;
}

/** Forget a cached detection (after the user edits, hides, or installs something). */
export function invalidateDetection(engineId?: string): void {
  if (engineId) {
    cache.delete(engineId);
    return;
  }
  cache.clear();
}

async function detectUncached(engine: EngineDefinition, options: DetectOptions): Promise<EngineDetection> {
  const base = {
    engineId: engine.id,
    executablePath: null as string | null,
    version: null as string | null,
    candidatesTried: [] as string[],
    checkedAt: Date.now(),
  };

  if (!engine.enabled) {
    return { ...base, availability: 'disabled', message: 'This engine is disabled in settings.' };
  }

  // DSH is not a plain executable: its launcher is an Electron/asar wrapper with
  // its own resolution rules, so it delegates to that resolver.
  if (engine.kind === 'dsh' && engine.id === DSH_ENGINE_ID) {
    const probe = await probeLauncher(options.dshBin);
    const candidatesTried = probe.candidatesTried.slice(0, 8);
    if (!probe.launcher) {
      return {
        ...base,
        availability: 'missing',
        candidatesTried,
        message: probe.error ?? 'No `dsh` launcher found.',
      };
    }
    const launch: EngineLaunch = {
      command: probe.launcher.command,
      argsPrefix: probe.launcher.argsPrefix,
      env: probe.launcher.env,
      shell: false,
      scriptPath: probe.launcher.launcherPath,
    };
    return {
      ...base,
      availability: 'installed',
      executablePath: probe.launcher.launcherPath,
      launch,
      version: probe.version,
      candidatesTried,
      message:
        probe.version !== null
          ? `DeepSeek Harness ${probe.version} (${probe.launcher.kind})`
          : 'Launcher found, but it did not report a version.',
    };
  }

  const candidates = candidateExecutables(engine, engine.detect.executablePath);
  const candidatesTried = candidates.map((candidate) => candidate.path);

  if (candidates.length === 0) {
    const searched = [
      ...engine.detect.commands,
      ...(engine.detect.searchGlobs ?? []),
      ...(engine.detect.executablePath ? [engine.detect.executablePath] : []),
    ];
    return {
      ...base,
      availability: 'missing',
      candidatesTried,
      message: `Not found. Looked for: ${searched.join(', ')}`,
    };
  }

  const chosen = candidates[0]!;
  const launch = resolveLaunch(chosen.path);
  if (!launch) {
    return {
      ...base,
      availability: 'broken',
      executablePath: chosen.path,
      candidatesTried,
      message:
        `${engine.label} was found at ${chosen.path}, but its launcher cannot be read safely ` +
        '(an opaque .cmd/.bat wrapper). Point "Executable path" at the real program instead.',
    };
  }

  let version: string | null = null;
  if (engine.detect.versionArgs && engine.detect.versionArgs.length > 0) {
    const result = await captureProcess({
      command: launch.command,
      args: [...launch.argsPrefix, ...engine.detect.versionArgs],
      env: { ...process.env, ...launch.env },
      timeoutMs: options.timeoutMs ?? 20_000,
    });
    version = extractVersion(`${result.stdout}\n${result.stderr}`, engine.detect.versionRegex);
  }

  // A recorded health check is the only thing that can promote an engine to
  // `ready` (or demote it to `broken`, which is what "installed but not signed
  // in" looks like from the outside).
  const health = getHealthResult(engine.id);
  const availability = health ? (health.ok ? 'ready' : 'broken') : 'installed';
  const kindNote = engine.kind === 'ide' ? ' (IDE — no headless agent)' : '';
  const baseMessage =
    `${engine.label}${version ? ` ${version}` : ''} found at ${chosen.path}${kindNote}.`;

  return {
    ...base,
    availability,
    executablePath: chosen.path,
    launch,
    version,
    candidatesTried,
    message: health
      ? `${baseMessage} Last test: ${health.ok ? 'passed' : 'failed'} — ${health.message}`
      : `${baseMessage} Run a test to confirm it can answer.`,
  };
}

/* ------------------------------------------------------------ health check */

/**
 * Prove an engine is usable by asking it something trivial.
 *
 * This is the only honest way to distinguish "installed" from "ready": a CLI
 * that is not signed in fails here with its own error message, which the UI
 * shows verbatim instead of a generic failure.
 */
export async function healthCheckEngine(
  engine: EngineDefinition,
  detection: EngineDetection,
  options: { cwd: string; timeoutMs?: number; dshBin?: string } = { cwd: process.cwd() },
): Promise<EngineHealthResult> {
  const startedAt = Date.now();

  /** Record and return, so a result always reaches the availability cache. */
  const conclude = (result: EngineHealthResult): EngineHealthResult => {
    recordHealthResult(engine.id, result.ok, result.message);
    invalidateDetection(engine.id);
    return result;
  };

  let launch: EngineLaunch | null;
  if (engine.kind === 'dsh') {
    const probe = await probeLauncher(options.dshBin);
    if (!probe.launcher) {
      return conclude({
        ok: false,
        message: probe.error ?? 'Launcher not found.',
        durationMs: Date.now() - startedAt,
      });
    }
    launch = {
      command: probe.launcher.command,
      argsPrefix: probe.launcher.argsPrefix,
      env: probe.launcher.env,
      shell: false,
      scriptPath: probe.launcher.launcherPath,
    };
  } else {
    if (!detection.executablePath) {
      return conclude({ ok: false, message: detection.message, durationMs: Date.now() - startedAt });
    }
    launch = detection.launch ?? resolveLaunch(detection.executablePath);
  }

  if (!launch) {
    return conclude({ ok: false, message: detection.message, durationMs: Date.now() - startedAt });
  }

  // A DSH health check drives the real headless runner, whose flag order the
  // generic template cannot express, so it gets its own command line.
  const healthTemplate =
    engine.kind === 'dsh'
      ? ['headless', '--json', '-']
      : (engine.run.healthArgsTemplate ?? []);
  if (healthTemplate.length === 0) {
    return conclude({
      ok: false,
      message: 'This engine declares no health check; run it once from the dashboard instead.',
      durationMs: 0,
    });
  }

  const prompt = engine.run.healthPrompt ?? 'Reply with exactly: OK';
  const args = renderArgs(healthTemplate, {
    prompt,
    model: '',
    cwd: options.cwd,
    sessionId: '',
  });
  const promptViaStdin =
    (engine.run.promptViaStdin || engine.kind === 'dsh') &&
    !healthTemplate.some((token) => token.includes('{prompt}'));

  const state = emptyParserState();
  const parser = getParser(
    engine.kind === 'dsh' ? 'dsh-json' : engine.run.healthOutputFormat ?? engine.run.outputFormat ?? 'json-lines',
  );
  let lastError: string | null = null;

  const handle = runProcess({
    command: launch.command,
    args: [...launch.argsPrefix, ...args],
    cwd: options.cwd,
    env: { ...process.env, ...launch.env },
    shell: launch.shell,
    timeoutMs: options.timeoutMs ?? engine.run.healthTimeoutMs ?? 120_000,
    onStdoutLine: (line) => {
      const parsed = parser.parse(line, state);
      for (const event of parsed.events ?? (parsed.event ? [parsed.event] : [])) {
        if (event.type === 'error') lastError = event.message;
      }
    },
  });
  if (promptViaStdin) handle.sendStdin(prompt);
  else handle.closeStdin();

  const outcome = await handle.done;
  const durationMs = Date.now() - startedAt;

  if (outcome.timedOut) {
    return conclude({ ok: false, message: `Timed out after ${Math.round(durationMs / 1000)}s.`, durationMs });
  }
  if (outcome.spawnError) {
    return conclude({ ok: false, message: outcome.spawnError, durationMs });
  }

  const stderrTail = outcome.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-3)
    .join(' ');

  if (state.failed || outcome.exitCode !== 0) {
    const message =
      lastError || state.error || stderrTail || `The engine exited with code ${outcome.exitCode}`;
    return conclude({ ok: false, message, durationMs });
  }
  const answer = state.finalText || state.messages.join(' ').trim();
  if (answer === '') {
    return conclude({
      ok: false,
      message:
        'The engine exited successfully but produced no readable output — check the output format for this engine.',
      durationMs,
    });
  }
  return conclude({ ok: true, message: `Answered: ${answer.slice(0, 200)}`, durationMs, output: answer });
}

/** Launch an IDE engine against a workspace (handoff, not an agent run). */
export function handoffToIde(
  engine: EngineDefinition,
  detection: EngineDetection,
  cwd: string,
): { ok: boolean; message: string } {
  if (!engine.handoff) return { ok: false, message: 'This engine has no handoff command.' };
  const launch = detection.launch;
  if (!launch) return { ok: false, message: detection.message };
  const args = engine.handoff.argsTemplate.map((token) => renderString(token, { prompt: '', model: '', sessionId: '', cwd }));
  try {
    const child = runProcess({
      command: launch.command,
      args: [...launch.argsPrefix, ...args],
      cwd,
      env: { ...process.env, ...launch.env },
      shell: launch.shell,
      timeoutMs: 15_000,
    });
    void child.done;
    return { ok: true, message: `Opened ${cwd} in ${engine.label}.` };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

/** Filesystem sanity check used by tests and the settings UI. */
export function executableExists(candidate: string): boolean {
  return existsSync(candidate);
}