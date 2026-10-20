import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseYaml, type YamlValue } from '../util/yaml.ts';
import { envFlag, envInt, envValue } from '../util/env.ts';
import { ensureStateDirs, resolveDshHome, resolveRunCwd, settingsFile, stateRoot } from './paths.ts';
import { createLogger } from '../util/log.ts';
import type { AgentSpec, DashboardSettings, ModelChoice, ProviderCatalogue, ProviderSpec } from '../types.ts';

const log = createLogger('config:settings');

export const SETTINGS_VERSION = 1;

function defaultModel(): ModelChoice {
  return { provider: '', model: '' };
}

export function defaultSettings(): DashboardSettings {
  return {
    version: SETTINGS_VERSION,
    dsh: {
      bin: '',
      home: resolveDshHome(),
      profile: 'headless',
      runCwd: resolveRunCwd(),
      trustStoredCredentials: true,
    },
    server: {
      host: envValue('DSH_MA_DASHBOARD_HOST') ?? '127.0.0.1',
      port: envInt('DSH_MA_DASHBOARD_PORT', 7317),
    },
    runs: {
      maxConcurrency: envInt('DSH_MA_MAX_CONCURRENCY', 4),
      timeoutMs: envInt('DSH_MA_RUN_TIMEOUT_MS', 30 * 60 * 1000),
    },
    ui: {
      language: (envValue('DSH_MA_LANGUAGE') === 'en' ? 'en' : 'fa') as 'fa' | 'en',
      direction: envValue('DSH_MA_LANGUAGE') === 'en' ? 'ltr' : 'rtl',
    },
    providers: {},
    engines: {},
    roster: {
      main: {
        id: 'main',
        name: 'Main',
        role: 'main',
        model: defaultModel(),
        instructions:
          'You are the lead agent. Decompose the task, delegate the parts you are given, and produce the final answer.',
      },
      subs: [
        {
          id: 'researcher',
          name: 'Researcher',
          role: 'sub',
          model: defaultModel(),
          instructions: 'Gather facts, read the relevant files, and report findings with evidence.',
        },
        {
          id: 'reviewer',
          name: 'Reviewer',
          role: 'sub',
          model: defaultModel(),
          instructions: 'Review the work critically. List concrete problems and concrete fixes.',
        },
      ],
    },
  };
}

/** Merge a partial/older settings file over the defaults, field by field. */
export function normalizeSettings(raw: unknown): DashboardSettings {
  const base = defaultSettings();
  if (raw === null || typeof raw !== 'object') return base;
  const input = raw as Partial<DashboardSettings>;

  const settings: DashboardSettings = {
    version: SETTINGS_VERSION,
    dsh: {
      bin: str(input.dsh?.bin, base.dsh.bin),
      home: str(input.dsh?.home, base.dsh.home),
      profile: str(input.dsh?.profile, base.dsh.profile) || 'headless',
      runCwd: str(input.dsh?.runCwd, base.dsh.runCwd),
      trustStoredCredentials:
        typeof input.dsh?.trustStoredCredentials === 'boolean'
          ? input.dsh.trustStoredCredentials
          : base.dsh.trustStoredCredentials,
    },
    server: {
      host: str(input.server?.host, base.server.host) || '127.0.0.1',
      port: clampInt(input.server?.port, base.server.port, 0, 65535),
    },
    runs: {
      maxConcurrency: clampInt(input.runs?.maxConcurrency, base.runs.maxConcurrency, 1, 32),
      timeoutMs: clampInt(input.runs?.timeoutMs, base.runs.timeoutMs, 0, 24 * 60 * 60 * 1000),
    },
    ui: {
      language: input.ui?.language === 'en' ? 'en' : input.ui?.language === 'fa' ? 'fa' : base.ui.language,
      direction: input.ui?.direction === 'ltr' ? 'ltr' : input.ui?.direction === 'rtl' ? 'rtl' : base.ui.direction,
    },
    providers: normalizeCatalogue(input.providers),
    engines: normalizeEngineOverrides(input.engines),
    roster: normalizeRoster(input.roster, base.roster),
  };
  settings.ui.direction = settings.ui.language === 'en' ? 'ltr' : 'rtl';
  return settings;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/**
 * Engine overrides are stored raw, exactly as the user wrote them.
 *
 * They are intentionally *not* expanded into full definitions here: settings
 * should keep only the differences, so an improved built-in preset still
 * reaches a user who once edited one field. The registry does the merging.
 */
export function normalizeEngineOverrides(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim();
    if (id === '') continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    out[id] = value;
  }
  return out;
}

export function normalizeCatalogue(raw: unknown): ProviderCatalogue {
  const out: ProviderCatalogue = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const spec = value as ProviderSpec;
    const rawModels = (value as Record<string, unknown>).models;
    const models = Array.isArray(rawModels)
      ? rawModels
          .filter((model): model is Record<string, unknown> => model !== null && typeof model === 'object')
          .map((model) => ({ ...model, id: String(model.id ?? '') }))
          .filter((model) => model.id !== '')
      : [];
    out[name] = { ...spec, models };
  }
  return out;
}

function normalizeRoster(
  raw: Partial<DashboardSettings['roster']> | undefined,
  fallback: DashboardSettings['roster'],
): DashboardSettings['roster'] {
  const main = normalizeAgent(raw?.main, fallback.main, 'main', 'main');
  const subs = Array.isArray(raw?.subs)
    ? raw!.subs.map((agent, index) => normalizeAgent(agent, fallback.subs[index] ?? fallback.subs[0]!, `sub-${index + 1}`, `Sub ${index + 1}`))
    : fallback.subs;
  return { main, subs };
}

function normalizeAgent(
  raw: unknown,
  fallback: AgentSpec,
  defaultId: string,
  defaultName: string,
): AgentSpec {
  if (raw === null || typeof raw !== 'object') {
    return { ...fallback, id: defaultId, name: defaultName };
  }
  const input = raw as Partial<AgentSpec>;
  const model: ModelChoice = {
    provider: str(input.model?.provider, fallback.model.provider),
    model: str(input.model?.model, fallback.model.model),
    ...(typeof input.model?.reasoningEffort === 'string' && input.model.reasoningEffort !== ''
      ? { reasoningEffort: input.model.reasoningEffort }
      : {}),
  };
  return {
    id: str(input.id, defaultId) || defaultId,
    name: str(input.name, defaultName) || defaultName,
    role: input.role === 'main' ? 'main' : 'sub',
    model,
    ...(typeof input.engine === 'string' && input.engine.trim() !== ''
      ? { engine: input.engine.trim() }
      : {}),
    ...(typeof input.cliModel === 'string' ? { cliModel: input.cliModel } : {}),
    ...(typeof input.instructions === 'string' ? { instructions: input.instructions } : {}),
    ...(typeof input.personaPrefix === 'string' ? { personaPrefix: input.personaPrefix } : {}),
    ...(Array.isArray(input.dependsOn) ? { dependsOn: input.dependsOn.map(String) } : {}),
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
  };
}

export function loadSettings(): DashboardSettings {
  if (!existsSync(settingsFile)) return defaultSettings();
  try {
    const text = readFileSync(settingsFile, 'utf8');
    return normalizeSettings(JSON.parse(text) as unknown);
  } catch (error) {
    log.warn('settings.json is unreadable; falling back to defaults', { error: String(error) });
    return defaultSettings();
  }
}

export function saveSettings(settings: DashboardSettings): DashboardSettings {
  ensureStateDirs();
  const normalized = normalizeSettings(settings);
  writeFileSync(settingsFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

/** Apply environment overrides that always win over stored settings. */
export function applyEnvOverrides(settings: DashboardSettings): DashboardSettings {
  const out = structuredClone(settings);
  const bin = envValue('DSH_MA_DSH_BIN');
  if (bin) out.dsh.bin = bin;
  const home = envValue('DSH_MA_DSH_HOME');
  if (home) out.dsh.home = home;
  const cwd = envValue('DSH_MA_RUN_CWD');
  if (cwd) out.dsh.runCwd = cwd;
  const host = envValue('DSH_MA_DASHBOARD_HOST');
  if (host) out.server.host = host;
  const port = envValue('DSH_MA_DASHBOARD_PORT');
  if (port) out.server.port = clampInt(port, out.server.port, 0, 65535);
  out.dsh.trustStoredCredentials = envFlag(
    'DSH_MA_TRUST_STORED_CREDENTIALS',
    out.dsh.trustStoredCredentials,
  );
  out.runs.maxConcurrency = envInt('DSH_MA_MAX_CONCURRENCY', out.runs.maxConcurrency);
  out.runs.timeoutMs = envInt('DSH_MA_RUN_TIMEOUT_MS', out.runs.timeoutMs);
  return out;
}

/** Directory that holds dashboard state; exported for the CLI banner. */
export function stateDirectory(): string {
  mkdirSync(stateRoot, { recursive: true });
  return path.resolve(stateRoot);
}

/** Convenience used by the API: the provider entry for a model choice. */
export function findProvider(catalogue: ProviderCatalogue, name: string): ProviderSpec | undefined {
  return catalogue[name];
}

/**
 * Read `$DSH_HOME/profiles/<profile>/cordis.patch.yml` and pull out provider
 * definitions and the default model, so the dashboard can offer exactly the
 * routes the Harness app already uses.
 */
export function importFromProfilePatch(file: string): {
  catalogue: ProviderCatalogue;
  defaultModel: ModelChoice | null;
  warnings: string[];
} {
  const catalogue: ProviderCatalogue = {};
  const warnings: string[] = [];
  let defaultModel: ModelChoice | null = null;
  let parsed: YamlValue;
  try {
    parsed = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    return { catalogue, defaultModel, warnings: [`${file}: ${String(error)}`] };
  }

  const visit = (node: YamlValue): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const name = typeof node.name === 'string' ? node.name : '';
    const config = node.config;
    if (name.includes('dsh-llm-pi-ai') && config !== null && typeof config === 'object' && !Array.isArray(config)) {
      const providers = (config as Record<string, YamlValue>).providers;
      if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [key, value] of Object.entries(providers)) {
          const normalized = normalizeCatalogue({ [key]: value });
          if (normalized[key]) catalogue[key] = normalized[key]!;
          else warnings.push(`${file}: provider "${key}" has no usable model list.`);
        }
      }
    }
    if (node.id === 'agent-default-model' && config !== null && typeof config === 'object' && !Array.isArray(config)) {
      const cfg = config as Record<string, YamlValue>;
      if (typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
        defaultModel = {
          provider: cfg.provider,
          model: cfg.model,
          ...(typeof cfg.reasoningEffort === 'string' ? { reasoningEffort: cfg.reasoningEffort } : {}),
        };
      }
    }
    for (const value of Object.values(node)) visit(value as YamlValue);
  };

  visit(parsed);
  return { catalogue, defaultModel, warnings };
}