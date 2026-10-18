#!/usr/bin/env node
/**
 * Diagnostics: check that the dashboard can see DeepSeek Harness, list the
 * provider/model catalogue it imported, and optionally validate one run patch
 * end to end with `--dump-config` (no tokens spent).
 *
 *   npm run probe
 *   npm run probe -- --provider omni --model deepseek-v4.1-flash:free --effort max
 */
import path from 'node:path';
import { loadDotEnv } from '../src/util/env.ts';
import { projectRoot, resolveDshHome } from '../src/config/paths.ts';
import { applyEnvOverrides, loadSettings } from '../src/config/settings.ts';
import { discoverFromDsh, keyAvailability } from '../src/config/discover.ts';
import { listProfiles, probeLauncher } from '../src/dsh/launcher.ts';
import { buildRunPatch, writeRunPatch } from '../src/dsh/patch.ts';
import { verifyPatch } from '../src/dsh/runner.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  loadDotEnv(path.join(projectRoot, '.env'));
  const settings = applyEnvOverrides(loadSettings());
  const dshHome = settings.dsh.home || resolveDshHome();

  process.stdout.write(`\nDSH home      ${dshHome}\n`);
  process.stdout.write(`profiles      ${listProfiles(dshHome).join(', ') || '(none)'}\n`);

  const probe = await probeLauncher(settings.dsh.bin);
  if (!probe.launcher) {
    process.stdout.write(`launcher      NOT FOUND\n  ${probe.error ?? ''}\n`);
    process.stdout.write(`  tried: ${probe.candidatesTried.join('\n         ')}\n`);
    process.stdout.write('\nSet DSH_MA_DSH_BIN to your dsh launcher path and retry.\n\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`launcher      ${probe.launcher.launcherPath}\n`);
  process.stdout.write(`launch mode   ${probe.launcher.kind}\n`);
  process.stdout.write(`dsh version   ${probe.version ?? '(unknown)'}\n`);

  const discovery = discoverFromDsh(dshHome);
  const names = Object.keys(discovery.catalogue);
  process.stdout.write(`\nproviders imported: ${names.length}\n`);
  for (const name of names) {
    const spec = discovery.catalogue[name]!;
    process.stdout.write(
      `\n  ${name} — ${spec.displayName ?? name}\n` +
        `    api         ${spec.api ?? '(unset)'}\n` +
        `    baseURL     ${spec.baseURL ?? '(unset)'}\n` +
        `    apiKeyEnv   ${spec.apiKeyEnv ?? '(unset)'} [${keyAvailability(spec.apiKeyEnv, dshHome, settings.dsh.runCwd)}]\n` +
        `    models      ${spec.models.map((model) => model.id).join(', ') || '(none)'}\n`,
    );
  }
  if (discovery.warnings.length > 0) {
    process.stdout.write(`\nwarnings:\n  ${discovery.warnings.join('\n  ')}\n`);
  }
  if (discovery.defaultModel) {
    process.stdout.write(`\ndefault model in your profile: ${JSON.stringify(discovery.defaultModel)}\n`);
  }

  const provider = arg('provider') ?? discovery.defaultModel?.provider ?? names[0];
  const catalogue = names.length > 0 ? discovery.catalogue : settings.providers;
  const spec = provider ? catalogue[provider] : undefined;
  const model = arg('model') ?? discovery.defaultModel?.model ?? spec?.models[0]?.id;
  if (!provider || !model) {
    process.stdout.write('\nNo provider/model to validate. Import providers first.\n\n');
    return;
  }

  const effort = arg('effort');
  const built = buildRunPatch({
    model: { provider, model, ...(effort ? { reasoningEffort: effort } : {}) },
    catalogue,
    trustStoredCredentials: settings.dsh.trustStoredCredentials,
  });
  process.stdout.write(`\nvalidating ${provider} / ${model}${effort ? ` @ ${effort}` : ''}\n`);
  if (built.problems.length > 0) {
    process.stdout.write(`  PROBLEMS\n    ${built.problems.join('\n    ')}\n`);
    process.exitCode = 1;
    return;
  }
  if (built.warnings.length > 0) process.stdout.write(`  warnings\n    ${built.warnings.join('\n    ')}\n`);

  const patchPath = writeRunPatch('probe', `${provider}.${model}`.replace(/[^\w.-]+/g, '_'), built.yaml);
  const verification = await verifyPatch(probe.launcher, patchPath, {
    profile: settings.dsh.profile,
    cwd: settings.dsh.runCwd,
  });
  process.stdout.write(`  patch        ${patchPath}\n`);
  process.stdout.write(`  dump-config  ${verification.ok ? 'OK' : 'FAILED'}\n`);
  if (!verification.ok) {
    process.stdout.write(`\n${verification.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nEverything is ready. Start the dashboard with: npm start\n\n');
  }
}

await main();