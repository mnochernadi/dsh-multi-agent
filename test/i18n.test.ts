import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { STRINGS, direction } from '../public/i18n.js';

const projectRoot = path.resolve(import.meta.dirname, '..');

test('i18n: Persian and English expose exactly the same keys', () => {
  const fa = Object.keys(STRINGS.fa).sort();
  const en = Object.keys(STRINGS.en).sort();
  const missingInEn = fa.filter((key) => !(key in STRINGS.en));
  const missingInFa = en.filter((key) => !(key in STRINGS.fa));
  assert.deepEqual(missingInEn, [], 'English is missing keys');
  assert.deepEqual(missingInFa, [], 'Persian is missing keys');
  assert.deepEqual(fa, en);
});

test('i18n: no translation is empty', () => {
  for (const [lang, table] of Object.entries(STRINGS as Record<string, Record<string, string>>)) {
    for (const [key, value] of Object.entries(table)) {
      assert.ok(String(value).trim() !== '', `${lang}.${key} is empty`);
    }
  }
});

test('i18n: every key used by the frontend exists', () => {
  const sources = ['public/app.js'].map((file) => readFileSync(path.join(projectRoot, file), 'utf8'));
  const used = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(match[1]!);
  }
  assert.ok(used.size > 40, `expected the UI to use many keys, found ${used.size}`);
  const unknown = [...used].filter((key) => !(key in STRINGS.en) && !(key in STRINGS.fa));
  assert.deepEqual(unknown, [], 'the frontend references keys that do not exist');
});

test('i18n: dynamic key families used by the frontend are complete', () => {
  const families = [
    ['run.status.', ['queued', 'running', 'succeeded', 'failed', 'aborted']],
    ['agent.status.', ['pending', 'waiting', 'running', 'succeeded', 'failed', 'skipped', 'aborted']],
    ['stage.', ['plan', 'work', 'synthesis', 'native', 'nativeHelper']],
    ['providers.key.', ['environment', 'env-file', 'credential-store', 'missing', 'unknown']],
    ['result.planSource.', ['main-agent', 'manual']],
    ['run.mode.', ['pipeline', 'native']],
    ['run.planning.', ['auto', 'manual']],
  ];
  for (const [prefix, suffixes] of families) {
    for (const suffix of suffixes as string[]) {
      for (const lang of ['fa', 'en'] as const) {
        const key = `${prefix}${suffix}`;
        assert.ok(key in STRINGS[lang], `${lang} is missing ${key}`);
      }
    }
  }
});

test('i18n: direction follows the language', () => {
  assert.equal(direction('fa'), 'rtl');
  assert.equal(direction('en'), 'ltr');
});