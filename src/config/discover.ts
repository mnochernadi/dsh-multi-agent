import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { importFromProfilePatch } from './settings.ts';
import type { ModelChoice, ProviderCatalogue } from '../types.ts';

export interface DiscoverySource {
  file: string;
  providers: number;
}

export interface DiscoveryResult {
  catalogue: ProviderCatalogue;
  defaultModel: ModelChoice | null;
  sources: DiscoverySource[];
  warnings: string[];
}

const PATCH_FILES = ['cordis.patch.yml', 'cordis.yml'];

/**
 * Import the provider/model catalogue the user already configured in the
 * DeepSeek Harness app.
 *
 * Provider definitions live in the profile patch layer, so this reads those
 * files directly. Profiles are visited in a stable order with `desktop` last,
 * because that is where the app keeps a user's own provider config.
 */
export function discoverFromDsh(dshHome: string, profiles?: string[]): DiscoveryResult {
  const profilesDir = path.join(dshHome, 'profiles');
  let names = profiles ?? [];
  if (names.length === 0) {
    try {
      names = readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return {
        catalogue: {},
        defaultModel: null,
        sources: [],
        warnings: [`No DSH profiles directory at ${profilesDir}.`],
      };
    }
  }

  const ordered = [...names].sort((a, b) => {
    if (a === b) return 0;
    if (a === 'desktop') return 1;
    if (b === 'desktop') return -1;
    return a.localeCompare(b);
  });

  const catalogue: ProviderCatalogue = {};
  const sources: DiscoverySource[] = [];
  const warnings: string[] = [];
  let defaultModel: ModelChoice | null = null;

  for (const profile of ordered) {
    for (const fileName of PATCH_FILES) {
      const file = path.join(profilesDir, profile, fileName);
      if (!existsSync(file)) continue;
      const result = importFromProfilePatch(file);
      const providerNames = Object.keys(result.catalogue);
      if (providerNames.length > 0) {
        for (const [name, spec] of Object.entries(result.catalogue)) {
          const existing = catalogue[name];
          // Later profiles win, but never lose models an earlier profile declared.
          catalogue[name] = existing
            ? { ...existing, ...spec, models: mergeModels(existing.models, spec.models) }
            : spec;
        }
        sources.push({ file, providers: providerNames.length });
      }
      warnings.push(...result.warnings);
      if (result.defaultModel) defaultModel = result.defaultModel;
    }
  }

  return { catalogue, defaultModel, sources, warnings };
}

function mergeModels<T extends { id: string }>(a: T[], b: T[]): T[] {
  const byId = new Map<string, T>();
  for (const model of a) byId.set(model.id, model);
  for (const model of b) byId.set(model.id, { ...byId.get(model.id), ...model });
  return [...byId.values()];
}

/** .env files a DSH headless run consults, in resolution order. */
export function credentialSources(dshHome: string, runCwd: string): string[] {
  return [
    path.join(runCwd, '.env'),
    path.join(dshHome, '.env'),
  ];
}

/**
 * Whether a provider's `apiKeyEnv` resolves to a non-empty value.
 *
 * Only presence is reported — never the value — so the UI can tell the user
 * "key found" without any credential entering a browser response.
 */
export function keyAvailability(
  apiKeyEnv: string | undefined,
  dshHome: string,
  runCwd: string,
): 'environment' | 'env-file' | 'missing' | 'unknown' {
  if (!apiKeyEnv) return 'unknown';
  const fromEnv = process.env[apiKeyEnv];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return 'environment';
  for (const file of credentialSources(dshHome, runCwd)) {
    const parsed = readEnvFileKeys(file);
    if (parsed.get(apiKeyEnv) === true) return 'env-file';
  }
  return 'missing';
}

function readEnvFileKeys(file: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!existsSync(file)) return out;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value !== '');
  }
  return out;
}