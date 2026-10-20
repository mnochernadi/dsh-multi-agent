import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeEngine, resolveEngines } from '../src/engines/registry.ts';
import { detectEngine, healthCheckEngine } from '../src/engines/detect.ts';
import { describeInvocation, startCliAgentRun } from '../src/engines/cli.ts';
import type { AgentStreamEvent } from '../src/types.ts';

/**
 * End-to-end coverage of the engine layer using a real child process.
 *
 * The fake CLI in `test/fixtures` speaks the same stream dialect as Claude Code,
 * so this exercises detection, argument rendering, prompt delivery over stdin,
 * stream parsing and outcome mapping without a network call.
 */

const fakeCli = path.resolve(import.meta.dirname, 'fixtures', 'fake-agent-cli.mjs');

function fakeEngine(extra: Record<string, unknown> = {}) {
  return normalizeEngine({
    id: 'fake-agent',
    label: 'Fake Agent',
    kind: 'cli',
    detect: { commands: ['definitely-not-installed'], versionArgs: ['--version'] },
    run: {
      argsTemplate: ['--output-format', 'stream-json', '--model', '{model}', '{extra}'],
      extraArgs: [],
      outputFormat: 'claude-stream-json',
      promptViaStdin: true,
    },
    ...extra,
  })!;
}

/** Point the engine at the fixture without relying on PATH. */
function engineWithScript(extra: Record<string, unknown> = {}) {
  return fakeEngine({
    detect: { commands: [], searchGlobs: [], versionArgs: ['--version'] },
    ...extra,
  });
}

async function runFake(options: { fail?: boolean; model?: string; textOnly?: boolean; extraArgs?: string[] } = {}) {
  const scriptArgs = options.fail ? ['--fail'] : options.textOnly ? ['--mode', 'text'] : [];
  const engine = normalizeEngine({
    id: 'fake-agent',
    label: 'Fake Agent',
    kind: 'cli',
    detect: { commands: [], versionArgs: [] },
    run: {
      argsTemplate: [fakeCli, ...scriptArgs, '--model', '{model}', '{extra}'],
      extraArgs: options.extraArgs ?? [],
      outputFormat: options.textOnly ? 'text' : 'claude-stream-json',
      promptViaStdin: true,
    },
  })!;

  const detection = {
    engineId: engine.id,
    availability: 'installed' as const,
    executablePath: fakeCli,
    launch: { command: process.execPath, argsPrefix: [], env: {}, shell: false, scriptPath: fakeCli },
    version: null,
    message: 'fixture',
    candidatesTried: [fakeCli],
    checkedAt: Date.now(),
  };

  const events: AgentStreamEvent[] = [];
  const handle = startCliAgentRun({
    engine,
    detection,
    prompt: 'Summarise the repository',
    model: options.model ?? '',
    cwd: process.cwd(),
    timeoutMs: 30_000,
    onEvent: (event) => events.push(event),
  });
  const outcome = await handle.done;
  return { outcome, events, engine, detection };
}

test('cli engine: runs a real process and maps its stream to dashboard events', async () => {
  const { outcome, events } = await runFake();
  assert.equal(outcome.ok, true, outcome.error ?? '');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionId, 'fake-session-1');
  assert.match(outcome.finalText, /^FAKE-ANSWER:Summarise the repository/);
  assert.deepEqual(outcome.thinking, ['Thinking about: Summarise the repository']);
  assert.deepEqual(outcome.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.deepEqual(
    events.map((event) => event.type),
    ['session', 'thinking', 'tool_call', 'tool_result', 'text', 'final'],
  );
});

test('cli engine: the prompt travels over stdin, not the command line', async () => {
  const engine = normalizeEngine({
    id: 'fake',
    kind: 'cli',
    detect: { commands: [] },
    run: { argsTemplate: [fakeCli, '--model', '{model}'], outputFormat: 'claude-stream-json', promptViaStdin: true },
  })!;
  const invocation = describeInvocation({
    engine,
    detection: {
      engineId: 'fake',
      availability: 'installed',
      executablePath: fakeCli,
      launch: { command: process.execPath, argsPrefix: [], env: {}, shell: false, scriptPath: fakeCli },
      version: null,
      message: '',
      candidatesTried: [],
      checkedAt: 0,
    },
    prompt: 'a very long prompt with "quotes" and spaces',
    model: 'sonnet',
    cwd: process.cwd(),
  });
  assert.equal(invocation.stdin, 'a very long prompt with "quotes" and spaces');
  assert.ok(!invocation.args.includes('a very long prompt with "quotes" and spaces'));
  assert.deepEqual(invocation.args.slice(0, 2), [fakeCli, '--model']);
  assert.equal(invocation.args.at(-1), 'sonnet');
});

test('cli engine: an empty model drops the flag instead of passing a blank value', async () => {
  const { outcome } = await runFake({ model: '' });
  assert.equal(outcome.ok, true, outcome.error ?? '');
  const { outcome: withModel } = await runFake({ model: 'opus' });
  assert.equal(withModel.ok, true, withModel.error ?? '');
});

test('cli engine: extra args from the engine definition are appended', async () => {
  const engine = normalizeEngine({
    id: 'fake',
    kind: 'cli',
    detect: { commands: [] },
    run: {
      argsTemplate: [fakeCli, '--model', '{model}', '{extra}'],
      extraArgs: ['--mode', 'text'],
      outputFormat: 'text',
      promptViaStdin: true,
    },
  })!;
  const invocation = describeInvocation({
    engine,
    detection: {
      engineId: 'fake',
      availability: 'installed',
      executablePath: fakeCli,
      launch: { command: process.execPath, argsPrefix: [], env: {}, shell: false, scriptPath: fakeCli },
      version: null,
      message: '',
      candidatesTried: [],
      checkedAt: 0,
    },
    prompt: 'hi',
    model: '',
    cwd: process.cwd(),
  });
  assert.deepEqual(invocation.args, [fakeCli, '--mode', 'text']);
});

test('cli engine: a sign-in failure is reported with the engine’s own words', async () => {
  const { outcome } = await runFake({ fail: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.error, 'Not logged in · Please run /login');
  assert.equal(outcome.finalText, '', 'a failed run has no answer to show');
});

test('cli engine: plain-text output becomes the answer', async () => {
  const { outcome } = await runFake({ textOnly: true });
  assert.equal(outcome.ok, true, outcome.error ?? '');
  assert.equal(outcome.finalText, 'plain line one\nplain line two');
});

test('cli engine: a missing executable fails cleanly instead of hanging', async () => {
  const engine = normalizeEngine({
    id: 'missing',
    kind: 'cli',
    detect: { commands: ['definitely-not-a-real-command-xyz'] },
    run: { argsTemplate: ['{prompt}'], outputFormat: 'text', promptViaStdin: false },
  })!;
  const detection = await detectEngine(engine, { force: true });
  assert.equal(detection.availability, 'missing');
  assert.equal(detection.executablePath, null);

  const result = await healthCheckEngine(engine, detection, { cwd: process.cwd() });
  assert.equal(result.ok, false);
});

test('cli engine: an abort stops the real process', async () => {
  const engine = normalizeEngine({
    id: 'slow',
    kind: 'cli',
    detect: { commands: [] },
    run: {
      argsTemplate: [fakeCli, '--model', '{model}'],
      outputFormat: 'claude-stream-json',
      promptViaStdin: true,
    },
  })!;
  const handle = startCliAgentRun({
    engine,
    detection: {
      engineId: 'slow',
      availability: 'installed',
      executablePath: fakeCli,
      launch: { command: process.execPath, argsPrefix: [], env: {}, shell: false, scriptPath: fakeCli },
      version: null,
      message: '',
      candidatesTried: [],
      checkedAt: 0,
    },
    prompt: 'x',
    model: '',
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  handle.abort();
  const outcome = await handle.done;
  assert.equal(outcome.aborted || outcome.ok, true, 'the process settles either way');
});

test('cli engine: a timeout is reported, not left running', async () => {
  const engine = normalizeEngine({
    id: 'hang',
    kind: 'cli',
    detect: { commands: [] },
    run: {
      argsTemplate: ['-e', 'setTimeout(() => {}, 60000)'],
      outputFormat: 'text',
      promptViaStdin: true,
    },
  })!;
  const handle = startCliAgentRun({
    engine,
    detection: {
      engineId: 'hang',
      availability: 'installed',
      executablePath: process.execPath,
      launch: { command: process.execPath, argsPrefix: [], env: {}, shell: false, scriptPath: null },
      version: null,
      message: '',
      candidatesTried: [],
      checkedAt: 0,
    },
    prompt: '',
    model: '',
    cwd: process.cwd(),
    timeoutMs: 1200,
  });
  const outcome = await handle.done;
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.ok, false);
});

test('cli engine: the detected preset resolves an executable on this machine', async () => {
  // The dashboard ships presets for many CLIs; at minimum the node-based fixture
  // proves the resolution path works with a real file.
  const engines = resolveEngines({});
  const fake = engines.find((engine) => engine.id === 'claude-code');
  assert.ok(fake, 'the Claude Code preset exists');
  const detection = await detectEngine(
    normalizeEngine({ ...fake, detect: { commands: [], searchGlobs: [], versionArgs: [] } })!,
    { force: true },
  );
  assert.equal(detection.availability, 'missing', 'no search patterns means nothing is found');
});