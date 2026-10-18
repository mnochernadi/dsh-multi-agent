import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toYaml, type YamlValue } from '../util/yaml.ts';
import { patchesDir } from '../config/paths.ts';
import type { ModelChoice, ModelSpec, ProviderCatalogue, ProviderSpec } from '../types.ts';

export interface BuildPatchInput {
  model: ModelChoice;
  catalogue: ProviderCatalogue;
  /** Re-enable DSH's managed credential store inside the run. */
  trustStoredCredentials: boolean;
  /** Optional `system-prompt.personaPrefix` override (`{{model}}` is interpolated by DSH). */
  personaPrefix?: string;
  /** Raw extra loader entries appended verbatim. */
  extraEntries?: YamlValue[];
}

export interface BuildPatchResult {
  entries: YamlValue[];
  yaml: string;
  problems: string[];
  warnings: string[];
  /** The provider/model actually written once effort mapping is applied. */
  resolved: ModelChoice;
}

/**
 * Build the Cordis loader overlay for one agent run.
 *
 * The overlay does three things and nothing else:
 *  1. states which provider/model/effort the run's default agent uses,
 *  2. carries the provider definition from the user's catalogue, so a headless
 *     profile that never saw the desktop app's config can still reach it,
 *  3. optionally restores the credential store so saved sign-ins and API keys
 *     resolve inside the run.
 */
export function buildRunPatch(input: BuildPatchInput): BuildPatchResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { model, catalogue } = input;

  const provider: ProviderSpec | undefined = catalogue[model.provider];
  let resolvedEffort: string | null | undefined = model.reasoningEffort ?? undefined;

  if (!provider) {
    problems.push(
      `Provider "${model.provider}" is not in the catalogue. Import providers from your DSH profile, or add one in Settings.`,
    );
  }

  let modelSpec: ModelSpec | undefined;
  if (provider) {
    modelSpec = provider.models.find((entry) => entry.id === model.model);
    if (!modelSpec) {
      problems.push(
        `Provider "${model.provider}" has no model "${model.model}". Known models: ${
          provider.models.map((entry) => entry.id).join(', ') || '(none)'
        }.`,
      );
    }
    if (!provider.baseURL) warnings.push(`Provider "${model.provider}" declares no baseURL.`);
    if (!provider.api) warnings.push(`Provider "${model.provider}" declares no api adapter.`);
    if (!provider.apiKeyEnv) warnings.push(`Provider "${model.provider}" declares no apiKeyEnv.`);
  }

  if (modelSpec) {
    const efforts = modelSpec.reasoningEfforts;
    if (resolvedEffort) {
      if (!efforts || Object.keys(efforts).length === 0) {
        problems.push(
          `Model "${model.model}" declares no reasoning efforts, so "${resolvedEffort}" cannot be requested. Pick "model default" instead.`,
        );
      } else if (!(resolvedEffort in efforts)) {
        problems.push(
          `Model "${model.model}" does not support reasoning effort "${resolvedEffort}". Supported: ${Object.keys(efforts).join(', ')}.`,
        );
      } else {
        const mapped = efforts[resolvedEffort];
        if (mapped === null || mapped === undefined || mapped === '') {
          warnings.push(
            `Reasoning effort "${resolvedEffort}" maps to no adapter identifier; the run uses the model default.`,
          );
          resolvedEffort = undefined;
        } else {
          resolvedEffort = mapped;
        }
      }
    }
  }

  const entries: YamlValue[] = [];

  if (input.trustStoredCredentials) {
    // Headless disables these by default; a dashboard agent should see the same
    // sign-ins the Harness app already stored.
    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      entries.push({ id, disabled: false });
    }
  }

  if (provider) {
    const modelEntry: { [key: string]: YamlValue } = {};
    for (const [key, value] of Object.entries(modelSpec ?? { id: model.model })) {
      modelEntry[key] = value as YamlValue;
    }
    const providerEntry: { [key: string]: YamlValue } = {};
    for (const [key, value] of Object.entries(provider)) {
      if (key === 'models') continue;
      providerEntry[key] = value as YamlValue;
    }
    providerEntry.models = [modelEntry];
    entries.push({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [model.provider]: providerEntry } } });
  }

  const defaultModel: { [key: string]: YamlValue } = {
    provider: model.provider,
    model: model.model,
  };
  if (resolvedEffort) defaultModel.reasoningEffort = resolvedEffort;
  entries.push({ id: 'agent-default-model', config: defaultModel });

  if (input.personaPrefix && input.personaPrefix.trim() !== '') {
    entries.push({
      id: 'system-prompt',
      name: '@deepseek-ai/dsh-system-prompt',
      config: { personaPrefix: input.personaPrefix },
    });
  }

  if (input.extraEntries) entries.push(...input.extraEntries);

  return {
    entries,
    yaml: `${toYaml(entries)}\n`,
    problems,
    warnings,
    resolved: {
      provider: model.provider,
      model: model.model,
      ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}),
    },
  };
}

/** Write a run patch under the dashboard's state directory. */
export function writeRunPatch(runId: string, agentId: string, yaml: string): string {
  mkdirSync(patchesDir, { recursive: true });
  const file = path.join(patchesDir, `${runId}.${agentId}.patch.yml`);
  writeFileSync(file, yaml, 'utf8');
  return file;
}