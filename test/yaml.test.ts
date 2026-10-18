import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, toYaml, type YamlValue } from '../src/util/yaml.ts';

test('yaml: parses a DSH profile patch with comments, nesting, and quoted scalars', () => {
  const text = [
    '# your patch layer',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: omni',
    '    model: deepseek-v4.1-flash:free',
    '    reasoningEffort: max',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      omni:',
    '        displayName: omni # inline comment',
    '        apiKeyEnv: OMNI_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://example.invalid/v1',
    '        models:',
    '          - id: deepseek-v4.1-flash:free',
    '            contextWindow: 1000000',
    '            input:',
    '              - text',
    '              - image',
    '            reasoningEfforts:',
    '              off: null',
    '              max: max',
    '          - id: plain-model',
    '- id: disabled-row',
    '  disabled: true',
    '',
  ].join('\n');

  const parsed = parseYaml(text) as YamlValue[];
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 3);

  const first = parsed[0] as Record<string, YamlValue>;
  assert.equal(first.id, 'agent-default-model');
  assert.deepEqual(first.config, {
    provider: 'omni',
    model: 'deepseek-v4.1-flash:free',
    reasoningEffort: 'max',
  });

  const providers = (parsed[1] as Record<string, YamlValue>).config as Record<string, YamlValue>;
  const omni = (providers.providers as Record<string, YamlValue>).omni as Record<string, YamlValue>;
  assert.equal(omni.displayName, 'omni', 'inline comments are stripped');
  assert.equal(omni.baseURL, 'https://example.invalid/v1', 'a colon inside a URL is not a key');

  const models = omni.models as YamlValue[];
  assert.equal(models.length, 2);
  const model = models[0] as Record<string, YamlValue>;
  assert.equal(model.contextWindow, 1000000);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.deepEqual(model.reasoningEfforts, { off: null, max: 'max' });
  assert.equal((parsed[2] as Record<string, YamlValue>).disabled, true);
});

test('yaml: keeps !!js expressions as inert text', () => {
  const parsed = parseYaml('mode: !!js process.env.DSH_TOOLS_MODE\n') as Record<string, YamlValue>;
  assert.equal(parsed.mode, 'process.env.DSH_TOOLS_MODE');
});

test('yaml: reads flow collections and block scalars', () => {
  const parsed = parseYaml(
    ['input: [text, image]', 'empty: []', 'obj: {a: 1, b: two}', 'script: |', '  line one', '  line two', ''].join('\n'),
  ) as Record<string, YamlValue>;
  assert.deepEqual(parsed.input, ['text', 'image']);
  assert.deepEqual(parsed.empty, []);
  assert.deepEqual(parsed.obj, { a: 1, b: 'two' });
  assert.equal(parsed.script, 'line one\nline two\n');
});

test('yaml: emits block style and round-trips through the parser', () => {
  const value: YamlValue = [
    { id: 'credentials', disabled: false },
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          omni: {
            displayName: 'omni',
            apiKeyEnv: 'OMNI_API_KEY',
            baseURL: 'https://example.invalid/v1',
            models: [{ id: 'm:free', name: 'm', contextWindow: 1000, reasoningEfforts: { off: null, max: 'max' } }],
          },
        },
      },
    },
    { id: 'agent-default-model', config: { provider: 'omni', model: 'm:free' } },
  ];

  const yaml = toYaml(value);
  assert.match(yaml, /^- id: credentials$/m);
  assert.match(yaml, /disabled: false/);
  assert.match(yaml, /"off": null|off: null/);
  assert.deepEqual(parseYaml(yaml), value);
});

test('yaml: quotes values that would otherwise change type', () => {
  const yaml = toYaml({ a: 'true', b: '123', c: 'null', d: 'plain text', e: 'has: colon', f: '' });
  const parsed = parseYaml(yaml) as Record<string, YamlValue>;
  assert.deepEqual(parsed, { a: 'true', b: '123', c: 'null', d: 'plain text', e: 'has: colon', f: '' });
});