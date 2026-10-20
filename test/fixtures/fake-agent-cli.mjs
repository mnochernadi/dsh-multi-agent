#!/usr/bin/env node
/**
 * A fake agent CLI used by the test suite.
 *
 * It speaks the Claude Code `stream-json` dialect — including the failure shape
 * a real, unauthenticated install produces — so the engine layer can be tested
 * end to end without a network call or a paid model.
 *
 *   node test/fixtures/fake-agent-cli.mjs --fail
 *   node test/fixtures/fake-agent-cli.mjs --mode text
 */
const args = process.argv.slice(2);
const fail = args.includes('--fail');
const textOnly = args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'text';

// Read the prompt from stdin, exactly as a real headless CLI would.
let prompt = '';
if (!args.some((arg) => arg.startsWith('--prompt='))) {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) prompt += chunk;
}

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (textOnly) {
  process.stdout.write('plain line one\n');
  process.stdout.write('plain line two\n');
  process.exit(0);
}

emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'fake-session-1', tools: ['Read'] });

if (fail) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Not logged in · Please run /login',
    terminal_reason: 'api_error',
    session_id: 'fake-session-1',
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  process.exit(1);
}

emit({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: `Thinking about: ${prompt.trim().slice(0, 40)}` }],
  },
});
emit({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: 'x' } }] },
});
emit({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [{ type: 'text', text: 'ok' }] }],
  },
});
const answer = `FAKE-ANSWER:${prompt.trim().replace(/\s+/g, ' ').slice(0, 40)}`;
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: answer,
  session_id: 'fake-session-1',
  total_cost_usd: 0,
  usage: { input_tokens: 11, output_tokens: 7 },
  num_turns: 2,
});
process.exit(0);