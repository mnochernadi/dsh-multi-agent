import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getParser, OUTPUT_FORMATS } from '../src/engines/parsers.ts';
import { emptyParserState } from '../src/engines/types.ts';
import { renderArgs, renderString, templateUses } from '../src/engines/template.ts';
import { expandPathPattern, extractVersion, resolveOnPath } from '../src/engines/detect.ts';
import { builtinEngines } from '../src/engines/presets.ts';
import { normalizeEngine, hiddenPresets, resolveEngines, validateEngine, slugifyEngineId } from '../src/engines/registry.ts';
import type { AgentStreamEvent } from '../src/types.ts';

/** Feed lines through a parser and collect the normalized events. */
function run(format: string, lines: string[]) {
  const parser = getParser(format as never);
  const state = emptyParserState();
  const events: AgentStreamEvent[] = [];
  for (const line of lines) {
    const parsed = parser.parse(line, state);
    if (parsed.event) events.push(parsed.event);
  }
  for (const event of parser.finish?.(state) ?? []) events.push(event);
  return { events, state };
}

/* ------------------------------------------------------------------ parsers */

test('parser: decodes a real Claude Code stream-json transcript', () => {
  // Shapes captured from Claude Code 2.1.299 (`-p --output-format stream-json`).
  const lines = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: 'C:\\work',
      session_id: 'session-abc',
      tools: ['Read', 'Edit'],
      model: 'claude-sonnet-4-5',
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me look at the file.' }],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      session_id: 'session-abc',
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'file body' }] }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The file looks fine.' }] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'The file looks fine.',
      session_id: 'session-abc',
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      num_turns: 2,
    }),
  ];

  const { events, state } = run('claude-stream-json', lines);
  const kinds = events.map((event) => event.type);
  assert.deepEqual(kinds, ['session', 'thinking', 'tool_call', 'tool_result', 'text', 'final']);

  const session = events[0] as Extract<AgentStreamEvent, { type: 'session' }>;
  assert.equal(session.sessionId, 'session-abc');
  assert.equal(session.cwd, 'C:\\work');

  const call = events[2] as Extract<AgentStreamEvent, { type: 'tool_call' }>;
  assert.equal(call.callId, 'toolu_1');
  assert.equal(call.tool, 'Read');
  assert.deepEqual(call.input, { file_path: 'a.ts' });

  const result = events[3] as Extract<AgentStreamEvent, { type: 'tool_result' }>;
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'file body');

  assert.equal(state.finalText, 'The file looks fine.');
  assert.equal(state.failed, false);
  assert.deepEqual(state.usage, { inputTokens: 150, outputTokens: 20, totalTokens: 170 });
});

test('parser: surfaces the engine’s own failure text (not signed in)', () => {
  // Exactly what Claude Code emits when it is installed but not authenticated.
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      terminal_reason: 'api_error',
      session_id: 's1',
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  ];
  const { events, state } = run('claude-stream-json', lines);
  assert.equal(state.failed, true);
  assert.equal(state.error, 'Not logged in · Please run /login');
  const error = events.find((event) => event.type === 'error') as Extract<AgentStreamEvent, { type: 'error' }>;
  assert.equal(error.message, 'Not logged in · Please run /login');
  assert.equal(error.code, 'api_error');
  assert.equal(events.some((event) => event.type === 'final'), false, 'a failed run emits no final answer');
});

test('parser: decodes the DSH event vocabulary', () => {
  const lines = [
    JSON.stringify({ type: 'session', sessionId: 'session-1', cwd: '/w' }),
    JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    JSON.stringify({ type: 'thinking', text: 'thinking hard' }),
    JSON.stringify({ type: 'text', text: 'answer' }),
    JSON.stringify({ type: 'final', text: 'answer' }),
  ];
  const { events, state } = run('dsh-json', lines);
  assert.deepEqual(events.map((event) => event.type), ['session', 'status', 'thinking', 'text', 'final']);
  assert.equal(state.finalText, 'answer');
  assert.equal(state.usage.totalTokens, 15);
  assert.equal(state.sessionId, 'session-1');
});

test('parser: plain text becomes one final answer', () => {
  const { events, state } = run('text', ['line one', 'line two', '']);
  assert.equal(state.finalText, 'line one\nline two');
  const final = events.at(-1) as Extract<AgentStreamEvent, { type: 'final' }>;
  assert.equal(final.type, 'final');
  assert.equal(final.text, 'line one\nline two');
});

test('parser: unknown JSON lines never throw and are reported as raw', () => {
  const parser = getParser('json-lines');
  const state = emptyParserState();
  const parsed = parser.parse('{"unexpected":true}', state);
  assert.equal(parsed.event, null);
  assert.equal(parsed.raw, '{"unexpected":true}');
  const broken = parser.parse('not json at all', state);
  assert.equal(broken.event?.type, 'text', 'unparseable text is still shown to the operator');
});

test('parser: a Claude line this build does not understand is kept as raw', () => {
  const parser = getParser('claude-stream-json');
  const state = emptyParserState();

  const partial = '{"type":"stream_event","event":{"delta":"par"}}';
  const unknownType = parser.parse(partial, state);
  assert.equal(unknownType.event, null);
  assert.equal(unknownType.raw, partial, 'an unknown event type is shown instead of vanishing');

  const unknownBlocks = '{"type":"assistant","message":{"content":[{"type":"mystery_block"}]}}';
  const empty = parser.parse(unknownBlocks, state);
  assert.equal(empty.event, null);
  assert.equal(empty.raw, unknownBlocks, 'a message whose blocks are all unknown is still visible');
});

test('parser: every advertised output format resolves', () => {
  for (const format of OUTPUT_FORMATS) {
    assert.equal(getParser(format).format, format);
  }
});

/* ----------------------------------------------------------------- templates */

test('template: substitutes placeholders and keeps unknown ones visible', () => {
  const args = renderArgs(['-p', '{prompt}', '--model', '{model}', '{missing}'], {
    prompt: 'do it',
    model: 'sonnet',
    cwd: '/w',
    sessionId: '',
  });
  assert.deepEqual(args, ['-p', 'do it', '--model', 'sonnet', '{missing}']);
});

test('template: an empty value removes its token and the flag before it', () => {
  const withoutModel = renderArgs(['-p', '--model', '{model}'], {
    prompt: 'x',
    model: '',
    cwd: '/w',
    sessionId: '',
  });
  assert.deepEqual(withoutModel, ['-p'], 'a dangling --model would break the CLI');

  const withModel = renderArgs(['-p', '--model', '{model}'], {
    prompt: 'x',
    model: 'opus',
    cwd: '/w',
    sessionId: '',
  });
  assert.deepEqual(withModel, ['-p', '--model', 'opus']);
});

test('template: {extra} expands in place and helpers report usage', () => {
  const args = renderArgs(['exec', '{extra}', '{prompt}'], {
    prompt: 'go',
    model: '',
    cwd: '',
    sessionId: '',
    extra: ['--json', '--model', 'gpt-5'],
  });
  assert.deepEqual(args, ['exec', '--json', '--model', 'gpt-5', 'go']);
  assert.equal(templateUses(['--model', '{model}'], 'model'), true);
  assert.equal(templateUses(['--model', '{model}'], 'cwd'), false);
  assert.equal(renderString('open {cwd} now', { prompt: '', model: '', sessionId: '', cwd: '/tmp/x' }), 'open /tmp/x now');
});

/* --------------------------------------------------------------- detection */

test('detect: expands environment patterns and a home prefix', () => {
  process.env.DSH_MA_TEST_ROOT = process.platform === 'win32' ? 'C:\\root' : '/root';
  const expanded = expandPathPattern('%DSH_MA_TEST_ROOT%/bin/agent.exe');
  assert.ok(expanded.startsWith(process.platform === 'win32' ? 'C:\\root' : '/root'));
  assert.ok(!expanded.includes('%DSH_MA_TEST_ROOT%'));
  const tilde = expandPathPattern('~/x');
  assert.ok(!tilde.startsWith('~'));
  delete process.env.DSH_MA_TEST_ROOT;
});

test('detect: resolves a command through PATH', () => {
  const node = resolveOnPath('node');
  assert.ok(node, 'node must be findable while the tests run with node');
  assert.ok(resolveOnPath('definitely-not-a-real-command-xyz') === null);
});

test('detect: extracts a version with and without a pattern', () => {
  assert.equal(extractVersion('2.1.299 (Claude Code)'), '2.1.299');
  assert.equal(extractVersion('claude 1.2.3\nmore text'), '1.2.3');
  assert.equal(extractVersion('v10.2', 'v([0-9.]+)'), '10.2');
  assert.equal(extractVersion(''), null);
});

/* ---------------------------------------------------------------- registry */

test('registry: presets are visible with no stored overrides', () => {
  const engines = resolveEngines({});
  assert.ok(engines.length >= 8);
  const ids = engines.map((engine) => engine.id);
  assert.ok(ids.includes('dsh'));
  assert.ok(ids.includes('claude-code'));
  assert.equal(engines.find((engine) => engine.id === 'dsh')!.builtin, true);
});

test('registry: a stored override merges over the preset without losing other fields', () => {
  const engines = resolveEngines({
    'claude-code': { run: { extraArgs: ['--permission-mode', 'acceptEdits'] } },
  });
  const claude = engines.find((engine) => engine.id === 'claude-code')!;
  assert.deepEqual(claude.run.extraArgs, ['--permission-mode', 'acceptEdits']);
  assert.equal(claude.run.outputFormat, 'claude-stream-json', 'untouched preset fields survive');
  assert.equal(claude.run.promptViaStdin, true);
  assert.ok(claude.detect.searchGlobs && claude.detect.searchGlobs.length > 0);
});

test('registry: a custom engine is added, and removed:true hides a preset', () => {
  const engines = resolveEngines({
    'my-agent': {
      label: 'My Agent',
      kind: 'cli',
      detect: { commands: ['my-agent'] },
      run: { argsTemplate: ['{prompt}'], outputFormat: 'text', promptViaStdin: false },
    },
    'vscode': { removed: true },
  });
  const custom = engines.find((engine) => engine.id === 'my-agent');
  assert.ok(custom);
  assert.equal(custom!.builtin, false);
  assert.equal(custom!.label, 'My Agent');
  assert.equal(engines.find((engine) => engine.id === 'vscode'), undefined, 'a hidden preset disappears');
});

test('registry: user input is sanitised instead of trusted', () => {
  const engine = normalizeEngine({
    id: 'Weird Name!!',
    label: 'x',
    kind: 'nonsense',
    detect: { commands: 'one\ntwo\n\nthree' },
    run: { argsTemplate: 'a\nb', outputFormat: 'not-a-format', promptViaStdin: 'yes' },
  })!;
  assert.equal(engine.id, 'weird-name');
  assert.equal(engine.kind, 'cli', 'an unknown kind falls back to cli');
  assert.deepEqual(engine.detect.commands, ['one', 'two', 'three']);
  assert.deepEqual(engine.run.argsTemplate, ['a', 'b']);
  assert.equal(engine.run.outputFormat, 'json-lines', 'an unknown format falls back');
  assert.equal(engine.run.promptViaStdin, false, 'a non-boolean falls back');
  assert.equal(slugifyEngineId('Claude Code!'), 'claude-code');
});

test('registry: validation catches an unusable template', () => {
  const noPrompt = normalizeEngine({
    id: 'broken',
    kind: 'cli',
    detect: { commands: ['x'] },
    run: { argsTemplate: ['--json'], outputFormat: 'text', promptViaStdin: false },
  })!;
  const problems = validateEngine(noPrompt);
  assert.ok(problems.some((problem) => problem.field === 'run.argsTemplate'));

  const noDetect = normalizeEngine({
    id: 'no-detect',
    kind: 'cli',
    detect: { commands: [] },
    run: { argsTemplate: ['{prompt}'], outputFormat: 'text', promptViaStdin: false },
  })!;
  assert.ok(validateEngine(noDetect).some((problem) => problem.field === 'detect'));
});

test('registry: every built-in preset is structurally valid', () => {
  for (const engine of builtinEngines) {
    assert.deepEqual(validateEngine(engine), [], `${engine.id} has problems`);
    if (engine.kind !== 'ide') {
      assert.ok(engine.run.outputFormat, `${engine.id} needs an output format`);
    }
  }
});

test('registry: a hidden preset is reported so it can be restored', () => {
  assert.deepEqual(hiddenPresets({}), [], 'nothing is hidden by default');
  assert.deepEqual(hiddenPresets(undefined), []);

  const hidden = hiddenPresets({ 'gemini-cli': { removed: true }, 'my-agent': { removed: true } });
  assert.deepEqual(
    hidden.map((entry) => entry.id),
    ['gemini-cli'],
    'only built-in presets can be "hidden"; a custom engine is deleted outright',
  );
  assert.equal(hidden[0]!.label.length > 0, true, 'the label is shown in the restore list');

  // Restoring is simply dropping the override, so the preset resolves again.
  const restored = resolveEngines({ 'gemini-cli': { removed: true } }).map((engine) => engine.id);
  assert.equal(restored.includes('gemini-cli'), false);
  const afterRestore = resolveEngines({}).map((engine) => engine.id);
  assert.equal(afterRestore.includes('gemini-cli'), true);
  assert.deepEqual(hiddenPresets({}), []);
});

test('registry: the CodeBuddy / WorkBuddy preset is a real headless contract', () => {
  const workbuddy = builtinEngines.find((engine) => engine.id === 'workbuddy');
  assert.ok(workbuddy, 'the preset exists');
  assert.equal(workbuddy!.kind, 'cli');
  assert.deepEqual(
    workbuddy!.detect.commands,
    ['workbuddy', 'codebuddy', 'cbc'],
    'the international (WorkBuddy), China (CodeBuddy) and short names all resolve',
  );
  assert.ok(workbuddy!.run.argsTemplate.includes('-p'), 'print mode is what makes it non-interactive');
  assert.ok(workbuddy!.run.argsTemplate.includes('stream-json'));
  assert.equal(workbuddy!.run.promptViaStdin, true, 'the prompt travels over stdin, not argv');
  assert.equal(
    getParser(workbuddy!.run.outputFormat).format,
    'claude-stream-json',
    'its stream is Claude-Code shaped, so a parser for that dialect must exist',
  );
});

test('registry: Freebuff is a handoff engine, not a runnable agent', () => {
  const freebuff = builtinEngines.find((engine) => engine.id === 'freebuff');
  assert.ok(freebuff, 'the preset exists');
  assert.equal(freebuff!.kind, 'ide', 'its CLI refuses a prompt argument and has no print mode');
  assert.deepEqual(freebuff!.run.argsTemplate, [], 'so it declares no agent argument template');
  assert.deepEqual(freebuff!.handoff?.argsTemplate, ['{cwd}'], 'the useful part is opening a workspace');
  assert.deepEqual(validateEngine(freebuff!), [], 'a handoff-only engine still validates');
});

test('registry: a pinned executable path survives the round trip', () => {
  const pinned = normalizeEngine({
    id: 'pinned',
    kind: 'cli',
    detect: { commands: ['agent'], executablePath: '  C:\\tools\\agent.exe  ' },
    run: { argsTemplate: ['{prompt}'], outputFormat: 'text', promptViaStdin: false },
  })!;
  assert.equal(pinned.detect.executablePath, 'C:\\tools\\agent.exe', 'the pin is trimmed and kept');

  // Every save sends only the fields the form knows about, so an override that
  // omits the pin must not erase the one stored on the preset.
  const overridden = normalizeEngine(
    { id: 'pinned', label: 'Pinned again', detect: { commands: ['agent'] } },
    pinned,
  )!;
  assert.equal(overridden.detect.executablePath, 'C:\\tools\\agent.exe');
  assert.equal(overridden.label, 'Pinned again', 'the rest of the override still applies');

  const unpinned = normalizeEngine({
    id: 'unpinned',
    kind: 'cli',
    detect: { commands: ['x'] },
    run: { argsTemplate: ['{prompt}'], outputFormat: 'text', promptViaStdin: false },
  })!;
  assert.equal(unpinned.detect.executablePath, undefined, 'no pin stays unpinned');
});