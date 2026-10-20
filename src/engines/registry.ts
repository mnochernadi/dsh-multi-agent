import { OUTPUT_FORMATS } from './parsers.ts';
import { builtinEngines, DSH_ENGINE_ID } from './presets.ts';
import type {
  EngineDefinition,
  EngineDetectSpec,
  EngineKind,
  EngineRunSpec,
  OutputFormat,
} from './types.ts';

/**
 * The engine registry resolves what the user can choose: built-in presets,
 * their per-field overrides, and fully custom engines.
 *
 * Settings only ever store *differences* — a user who never opens the engine
 * editor keeps an empty map, so a future preset change still reaches them.
 */

/** What settings store for engines: overrides keyed by engine id. */
export type EngineOverrides = Record<string, unknown>;

const KINDS: EngineKind[] = ['dsh', 'cli', 'ide'];

/** Accepts `string[]`, or a newline-separated string (one argument per line). */
function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter((entry) => entry !== '');
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }
  return undefined;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

export function slugifyEngineId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizeDetect(raw: unknown, fallback: EngineDetectSpec): EngineDetectSpec {
  const input = asRecord(raw);
  const commands = toStringArray(input.commands);
  const globs = toStringArray(input.searchGlobs);
  const versionArgs = toStringArray(input.versionArgs);
  const pinned = typeof input.executablePath === 'string' ? input.executablePath.trim() : '';
  return {
    commands: commands ?? fallback.commands,
    searchGlobs: globs ?? fallback.searchGlobs,
    versionArgs: versionArgs ?? fallback.versionArgs,
    versionRegex: typeof input.versionRegex === 'string' ? input.versionRegex : fallback.versionRegex,
    // A pinned program is the documented escape hatch when a wrapper cannot be
    // read, so it has to survive the round trip through settings and the API.
    executablePath: pinned !== '' ? pinned : fallback.executablePath,
  };
}

function normalizeRun(raw: unknown, fallback: EngineRunSpec): EngineRunSpec {
  const input = asRecord(raw);
  const format = str(input.outputFormat);
  const health = str(input.healthOutputFormat);
  const modelsRaw = input.models;
  const models = Array.isArray(modelsRaw)
    ? modelsRaw
        .map((entry) => asRecord(entry))
        .map((entry) => ({ id: str(entry.id), name: str(entry.name) || undefined, description: str(entry.description) || undefined }))
        .filter((entry) => entry.id !== '' || entry.name !== undefined)
    : undefined;
  return {
    argsTemplate: toStringArray(input.argsTemplate) ?? fallback.argsTemplate,
    outputFormat: (OUTPUT_FORMATS as string[]).includes(format)
      ? (format as OutputFormat)
      : fallback.outputFormat,
    ...(health !== '' && (OUTPUT_FORMATS as string[]).includes(health)
      ? { healthOutputFormat: health as OutputFormat }
      : fallback.healthOutputFormat
        ? { healthOutputFormat: fallback.healthOutputFormat }
        : {}),
    extraArgs: toStringArray(input.extraArgs) ?? fallback.extraArgs,
    promptViaStdin: bool(input.promptViaStdin, fallback.promptViaStdin),
    envPassthrough: toStringArray(input.envPassthrough) ?? fallback.envPassthrough,
    env: toStringRecord(input.env) ?? fallback.env,
    models: models ?? fallback.models,
    healthArgsTemplate: toStringArray(input.healthArgsTemplate) ?? fallback.healthArgsTemplate,
    healthPrompt: typeof input.healthPrompt === 'string' ? input.healthPrompt : fallback.healthPrompt,
    healthTimeoutMs: clampInt(input.healthTimeoutMs, fallback.healthTimeoutMs ?? 120_000, 5_000, 900_000),
  };
}

/**
 * Sanitize one engine definition from an API request.
 *
 * Anything the caller omits is taken from `base` (the preset being edited) or
 * from a conservative default, so a partially-filled form still produces a
 * usable engine instead of an invalid one.
 */
export function normalizeEngine(raw: unknown, base?: EngineDefinition): EngineDefinition | null {
  const input = asRecord(raw);
  const id = slugifyEngineId(str(input.id, base?.id ?? ''));
  if (id === '') return null;

  const kindRaw = str(input.kind, base?.kind ?? 'cli');
  const kind: EngineKind = (KINDS as string[]).includes(kindRaw) ? (kindRaw as EngineKind) : 'cli';

  const detectFallback: EngineDetectSpec = base?.detect ?? { commands: [], searchGlobs: [], versionArgs: ['--version'] };
  const runFallback: EngineRunSpec = base?.run ?? {
    argsTemplate: ['{prompt}'],
    // `json-lines` is the safest default: it decodes JSON events when the CLI
    // emits them and still shows plain text when it does not.
    outputFormat: 'json-lines',
    promptViaStdin: false,
    models: [],
  };

  const handoffRaw = input.handoff ?? base?.handoff;
  const handoffArgs = toStringArray(asRecord(handoffRaw).argsTemplate);

  return {
    id,
    label: str(input.label, base?.label ?? id) || id,
    kind,
    builtin: base?.builtin ?? false,
    enabled: bool(input.enabled, base?.enabled ?? true),
    description: typeof input.description === 'string' ? input.description : base?.description,
    homepage: typeof input.homepage === 'string' ? input.homepage : base?.homepage,
    detect: normalizeDetect(input.detect, detectFallback),
    run: normalizeRun(input.run, runFallback),
    ...(handoffArgs && handoffArgs.length > 0 ? { handoff: { argsTemplate: handoffArgs } } : {}),
  };
}

/**
 * Apply stored overrides to the built-in presets and append custom engines.
 *
 * A stored `removed: true` hides a built-in engine; `enabled: false` keeps it
 * visible but unusable, which is friendlier than making it disappear.
 */
export function resolveEngines(overrides: EngineOverrides | undefined): EngineDefinition[] {
  const result: EngineDefinition[] = [];
  const stored = overrides ?? {};
  const usedOverrides = new Set<string>();

  for (const preset of builtinEngines) {
    const override = asRecord(stored[preset.id]);
    usedOverrides.add(preset.id);
    if (override.removed === true) continue;
    const merged = normalizeEngine({ ...preset, ...override, id: preset.id }, preset);
    if (merged) result.push(merged);
  }

  for (const [key, value] of Object.entries(stored)) {
    if (usedOverrides.has(key)) continue;
    const record = asRecord(value);
    if (record.removed === true) continue;
    const engine = normalizeEngine({ ...record, id: str(record.id, key) });
    if (engine) result.push(engine);
  }

  return result;
}

export function findEngine(engines: EngineDefinition[], id: string): EngineDefinition | undefined {
  return engines.find((engine) => engine.id === id);
}

/**
 * Built-in presets the user has hidden.
 *
 * A hidden preset is removed from the working list, so the UI needs this to
 * offer a way back — otherwise `removed: true` would be a one-way door.
 */
export function hiddenPresets(overrides: EngineOverrides | undefined): { id: string; label: string }[] {
  const stored = overrides ?? {};
  const hidden: { id: string; label: string }[] = [];
  for (const preset of builtinEngines) {
    const override = asRecord(stored[preset.id]);
    if (override.removed === true) hidden.push({ id: preset.id, label: preset.label });
  }
  return hidden;
}

/** The engine used when an agent does not name one. */
export function defaultEngineId(engines: EngineDefinition[]): string {
  return findEngine(engines, DSH_ENGINE_ID)?.id ?? engines[0]?.id ?? DSH_ENGINE_ID;
}

export interface EngineProblem {
  field: string;
  message: string;
}

/** Structural validation used before an engine is saved or run. */
export function validateEngine(engine: EngineDefinition): EngineProblem[] {
  const problems: EngineProblem[] = [];
  if (engine.id === '') problems.push({ field: 'id', message: 'An engine needs an id.' });
  if (engine.kind !== 'ide') {
    if (engine.run.argsTemplate.length === 0 && engine.kind === 'cli') {
      problems.push({ field: 'run.argsTemplate', message: 'A CLI engine needs an argument template.' });
    }
    const mentionsPrompt = engine.run.argsTemplate.some((token) => token.includes('{prompt}'));
    if (!engine.run.promptViaStdin && !mentionsPrompt) {
      problems.push({
        field: 'run.argsTemplate',
        message: 'Either enable "prompt via stdin" or include {prompt} in the argument template.',
      });
    }
  }
  if (engine.detect.commands.length === 0 && (engine.detect.searchGlobs ?? []).length === 0) {
    problems.push({
      field: 'detect',
      message: 'Give one command name or a search pattern so the engine can be detected.',
    });
  }
  return problems;
}