import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunPatch } from '../src/dsh/patch.ts';
import { parseYaml, type YamlValue } from '../src/util/yaml.ts';
import type { ProviderCatalogue } from '../src/types.ts';

const catalogue: ProviderCatalogue = {
  omni: {
    displayName: 'omni',
    apiKeyEnv: 'OMNI_API_KEY',
    api: 'openai-completions',
    baseURL: 'https://example.invalid/v1',
    extraField: 'preserved',
    models: [
      {
        id: 'deepseek-v4.1-flash:free',
        name: 'flash',
        contextWindow: 1000000,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', max: 'max' },
      },
      { id: 'no-effort-model' },
    ],
  },
};

test('patch: selects the provider/model and enables stored credentials', () => {
  const built = buildRunPatch({
    model: { provider: 'omni', model: 'deepseek-v4.1-flash:free', reasoningEffort: 'max' },
    catalogue,
    trustStoredCredentials: true,
  });

  assert.deepEqual(built.problems, []);
  assert.deepEqual(built.resolved, {
    provider: 'omni',
    model: 'deepseek-v4.1-flash:free',
    reasoningEffort: 'max',
  });

  const entries = parseYaml(built.yaml) as YamlValue[];
  const ids = entries.map((entry) => (entry as Record<string, YamlValue>).id);
  assert.deepEqual(ids, ['credentials', 'authorization', 'deepseek-account', 'llm-pi-ai', 'agent-default-model']);

  const piAi = entries[3] as Record<string, YamlValue>;
  const providers = (piAi.config as Record<string, YamlValue>).providers as Record<string, YamlValue>;
  const omni = providers.omni as Record<string, YamlValue>;
  assert.equal(omni.extraField, 'preserved', 'unknown provider fields survive the copy');
  assert.equal((omni.models as YamlValue[]).length, 1, 'only the selected model is written');
  assert.deepEqual((omni.models as YamlValue[])[0], {
    id: 'deepseek-v4.1-flash:free',
    name: 'flash',
    contextWindow: 1000000,
    input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', max: 'max' },
  });
});

test('patch: rejects an unsupported reasoning effort instead of failing mid-run', () => {
  const built = buildRunPatch({
    model: { provider: 'omni', model: 'deepseek-v4.1-flash:free', reasoningEffort: 'ultra' },
    catalogue,
    trustStoredCredentials: false,
  });
  assert.equal(built.problems.length, 1);
  assert.match(built.problems[0]!, /does not support reasoning effort "ultra"/);
  assert.match(built.problems[0]!, /off, low, max/);
});

test('patch: rejects an effort on a model that declares none', () => {
  const built = buildRunPatch({
    model: { provider: 'omni', model: 'no-effort-model', reasoningEffort: 'max' },
    catalogue,
    trustStoredCredentials: false,
  });
  assert.equal(built.problems.length, 1);
  assert.match(built.problems[0]!, /declares no reasoning efforts/);
});

test('patch: an effort mapping to null falls back to the model default with a warning', () => {
  const built = buildRunPatch({
    model: { provider: 'omni', model: 'deepseek-v4.1-flash:free', reasoningEffort: 'off' },
    catalogue,
    trustStoredCredentials: false,
  });
  assert.deepEqual(built.problems, []);
  assert.equal(built.warnings.length, 1);
  assert.match(built.warnings[0]!, /uses the model default/);
  assert.deepEqual(built.resolved, { provider: 'omni', model: 'deepseek-v4.1-flash:free' });

  const entries = parseYaml(built.yaml) as YamlValue[];
  const defaultModel = entries.find((entry) => (entry as Record<string, YamlValue>).id === 'agent-default-model');
  assert.deepEqual((defaultModel as Record<string, YamlValue>).config, {
    provider: 'omni',
    model: 'deepseek-v4.1-flash:free',
  });
});

test('patch: reports an unknown provider and unknown model', () => {
  const unknownProvider = buildRunPatch({
    model: { provider: 'nope', model: 'x' },
    catalogue,
    trustStoredCredentials: false,
  });
  assert.match(unknownProvider.problems[0]!, /Provider "nope" is not in the catalogue/);

  const unknownModel = buildRunPatch({
    model: { provider: 'omni', model: 'ghost' },
    catalogue,
    trustStoredCredentials: false,
  });
  assert.match(unknownModel.problems[0]!, /has no model "ghost"/);
  assert.match(unknownModel.problems[0]!, /deepseek-v4\.1-flash:free/);
});

test('patch: writes a persona override and omits credential rows when not trusted', () => {
  const built = buildRunPatch({
    model: { provider: 'omni', model: 'no-effort-model' },
    catalogue,
    trustStoredCredentials: false,
    personaPrefix: 'You are {{model}}, a careful reviewer.',
  });
  const entries = parseYaml(built.yaml) as YamlValue[];
  const ids = entries.map((entry) => (entry as Record<string, YamlValue>).id);
  assert.deepEqual(ids, ['llm-pi-ai', 'agent-default-model', 'system-prompt']);
  const prompt = entries[2] as Record<string, YamlValue>;
  assert.equal(prompt.name, '@deepseek-ai/dsh-system-prompt');
  assert.equal((prompt.config as Record<string, YamlValue>).personaPrefix, 'You are {{model}}, a careful reviewer.');
});