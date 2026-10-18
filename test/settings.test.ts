import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSettings, importFromProfilePatch } from '../src/config/settings.ts';
import { buildLauncherFromFile } from '../src/dsh/launcher.ts';

test('settings: unknown input falls back to defaults', () => {
  const settings = normalizeSettings(null);
  assert.equal(settings.dsh.profile, 'headless');
  assert.equal(settings.dsh.trustStoredCredentials, true);
  assert.ok(settings.roster.main.id);
  assert.ok(settings.roster.subs.length >= 1);
});

test('settings: partial input is merged field by field and clamped', () => {
  const settings = normalizeSettings({
    dsh: { bin: 'C:/dsh.cmd', trustStoredCredentials: false },
    runs: { maxConcurrency: 999, timeoutMs: -5 },
    server: { port: 0 },
    ui: { language: 'en' },
    providers: { p: { models: [{ id: 'm1' }, { id: '' }, 'garbage'] } },
  });
  assert.equal(settings.dsh.bin, 'C:/dsh.cmd');
  assert.equal(settings.dsh.trustStoredCredentials, false);
  assert.equal(settings.dsh.profile, 'headless');
  assert.equal(settings.runs.maxConcurrency, 32, 'clamped to the maximum');
  assert.equal(settings.runs.timeoutMs, 0, 'clamped to zero rather than negative');
  assert.equal(settings.ui.language, 'en');
  assert.equal(settings.ui.direction, 'ltr', 'direction follows the language');
  assert.deepEqual(settings.providers.p!.models, [{ id: 'm1' }], 'invalid models are dropped');
});

test('settings: imports providers and the default model from a real profile patch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ma-'));
  const file = path.join(dir, 'cordis.patch.yml');
  writeFileSync(
    file,
    [
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: omni',
      '    model: deepseek-v4.1-flash:free',
      '    reasoningEffort: max',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      omni:',
      '        displayName: omni',
      '        apiKeyEnv: OMNI_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://omni.example/v1',
      '        models:',
      '          - id: deepseek-v4.1-flash:free',
      '            contextWindow: 1000000',
      '          - id: other-model',
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    const result = importFromProfilePatch(file);
    assert.deepEqual(Object.keys(result.catalogue), ['omni']);
    assert.equal(result.catalogue.omni!.baseURL, 'https://omni.example/v1');
    assert.deepEqual(
      result.catalogue.omni!.models.map((model) => model.id),
      ['deepseek-v4.1-flash:free', 'other-model'],
    );
    assert.deepEqual(result.defaultModel, {
      provider: 'omni',
      model: 'deepseek-v4.1-flash:free',
      reasoningEffort: 'max',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: a missing or broken patch file reports a warning instead of throwing', () => {
  const missing = importFromProfilePatch(path.join(tmpdir(), 'definitely-not-here.yml'));
  assert.deepEqual(missing.catalogue, {});
  assert.equal(missing.warnings.length, 1);
});

test('launcher: reads the shipped dsh.cmd wrapper and spawns the app directly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ma-cmd-'));
  const cmd = path.join(dir, 'dsh.cmd');
  const cli = path.join(dir, 'cli.js');
  writeFileSync(cli, '// fake cli', 'utf8');
  writeFileSync(
    cmd,
    [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"%~dp0fake-app.exe" --expose-internals "%~dp0cli.js" %*`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n'),
    'utf8',
  );
  // The wrapper points at a file that does not exist yet, which must fail closed.
  assert.equal(buildLauncherFromFile(cmd, 'test'), null);

  try {
    writeFileSync(path.join(dir, 'fake-app.exe'), 'placeholder', 'utf8');
    const launcher = buildLauncherFromFile(cmd, 'test');
    assert.ok(launcher, 'a complete wrapper resolves');
    assert.equal(launcher!.kind, 'electron-asar');
    assert.equal(launcher!.command, path.join(dir, 'fake-app.exe'));
    assert.deepEqual(launcher!.argsPrefix, ['--expose-internals', cli]);
    assert.equal(launcher!.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(launcher!.launcherPath, path.resolve(cmd));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});