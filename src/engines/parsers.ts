import type { AgentStreamEvent, UsageTotals } from '../types.ts';
import type { OutputFormat, ParserState, ParsedLine } from './types.ts';

/**
 * Stream parsers: vendor output → the dashboard's event vocabulary.
 *
 * Every parser is defensive. A CLI version may add fields or change a subtype,
 * and a dashboard that throws on an unexpected shape would lose a run that is
 * actually progressing, so unknown input becomes a `raw` diagnostic instead.
 */

export interface StreamParser {
  format: OutputFormat;
  parse(line: string, state: ParserState): ParsedLine;
  /** Emit anything still pending once stdout closes. */
  finish?(state: ParserState): AgentStreamEvent[];
}

function tryJson(line: string): unknown | null {
  const text = line.trim();
  if (text === '' || (text[0] !== '{' && text[0] !== '[')) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function addUsage(target: UsageTotals, input: number, output: number): void {
  target.inputTokens += input;
  target.outputTokens += output;
  target.totalTokens += input + output;
}

/* ------------------------------------------------------------------ DSH */

/**
 * `dsh headless --patch <patch> --json -`.
 *
 * Usage arrives per committed step (`status`/`step_end`), so it accumulates.
 */
export const dshParser: StreamParser = {
  format: 'dsh-json',
  parse(line, state): ParsedLine {
    const parsed = asRecord(tryJson(line));
    if (!parsed) return { event: null, raw: line };
    const type = str(parsed.type);
    switch (type) {
      case 'session': {
        state.sessionId = str(parsed.sessionId) || state.sessionId;
        return { event: { type: 'session', sessionId: state.sessionId ?? '', cwd: str(parsed.cwd) } };
      }
      case 'text': {
        const text = str(parsed.text);
        if (text.trim() !== '') state.messages.push(text);
        return { event: { type: 'text', text } };
      }
      case 'thinking': {
        const text = str(parsed.text);
        if (text.trim() !== '') state.thinking.push(text);
        return { event: { type: 'thinking', text } };
      }
      case 'tool_call':
        return {
          event: {
            type: 'tool_call',
            callId: str(parsed.callId),
            tool: str(parsed.tool) || 'tool',
            input: parsed.input,
          },
        };
      case 'tool_result':
        return {
          event: {
            type: 'tool_result',
            callId: str(parsed.callId),
            status: str(parsed.status) || 'completed',
            result: str(parsed.result),
          },
        };
      case 'status': {
        const phase = str(parsed.phase);
        const usage = asRecord(parsed.usage);
        if (phase === 'step_end' && usage) {
          addUsage(state.usage, num(usage.inputTokens), num(usage.outputTokens));
        }
        if (phase === 'turn_end') {
          const reason = asRecord(parsed.reason);
          const kind = reason ? str(reason.kind) : '';
          if (kind === 'error') {
            state.failed = true;
            const error = asRecord(reason?.error);
            const message = error ? str(error.message) : 'the turn failed';
            const code = error ? str(error.code) : '';
            state.error = code ? `${code}: ${message}` : message;
          }
        }
        return {
          event: {
            type: 'status',
            phase,
            ...(usage ? { usage } : {}),
            ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
          } as AgentStreamEvent,
        };
      }
      case 'final': {
        state.finalText = str(parsed.text);
        return { event: { type: 'final', text: state.finalText } };
      }
      case 'error': {
        state.failed = true;
        const code = str(parsed.code);
        const message = str(parsed.message);
        state.error = code ? `${code}: ${message}` : message;
        return { event: { type: 'error', message, ...(code ? { code } : {}) } };
      }
      default:
        return { event: null, raw: line };
    }
  },
};

/* -------------------------------------------------------- Claude Code */

function claudeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const record = asRecord(block);
        if (!record) return typeof block === 'string' ? block : '';
        return str(record.text) || str(record.content);
      })
      .filter((part) => part !== '')
      .join('\n');
  }
  const record = asRecord(content);
  return record ? str(record.text) : '';
}

/**
 * `claude -p --output-format stream-json --verbose`.
 *
 * Events observed from Claude Code 2.x: `system/init`, `assistant`, `user`
 * (tool results) and `result`. The `result` event carries session-cumulative
 * usage, so per-message usage is deliberately not summed here.
 */
export const claudeParser: StreamParser = {
  format: 'claude-stream-json',
  parse(line, state): ParsedLine {
    const parsed = asRecord(tryJson(line));
    if (!parsed) return { event: null, raw: line };
    const type = str(parsed.type);
    if (type === 'system') {
      state.sessionId = str(parsed.session_id) || state.sessionId;
      return { event: { type: 'session', sessionId: state.sessionId ?? '', cwd: str(parsed.cwd) } };
    }
    if (type === 'assistant' || type === 'user') {
      const message = asRecord(parsed.message);
      const content = message?.content;
      const blocks = Array.isArray(content) ? content : [];
      // One message commonly carries several blocks (text + tool_use, or more
      // than one tool_result). Every block is emitted: returning after the first
      // would hide tool calls from the timeline and from the run record.
      const produced: AgentStreamEvent[] = [];
      for (const block of blocks) {
        const record = asRecord(block);
        if (!record) continue;
        const blockType = str(record.type);
        if (blockType === 'text') {
          const text = str(record.text);
          if (text.trim() !== '') {
            state.messages.push(text);
            produced.push({ type: 'text', text });
          }
          continue;
        }
        if (blockType === 'thinking' || blockType === 'reasoning') {
          const text = str(record.thinking) || str(record.text);
          if (text.trim() !== '') {
            state.thinking.push(text);
            produced.push({ type: 'thinking', text });
          }
          continue;
        }
        if (blockType === 'tool_use' || blockType === 'tool_call') {
          produced.push({
            type: 'tool_call',
            callId: str(record.id) || str(record.tool_use_id),
            tool: str(record.name) || str(record.tool) || 'tool',
            input: record.input,
          });
          continue;
        }
        if (blockType === 'tool_result') {
          produced.push({
            type: 'tool_result',
            callId: str(record.tool_use_id) || str(record.tool_call_id),
            status: record.is_error === true ? 'error' : 'completed',
            result: claudeToolResultText(record.content) || claudeToolResultText(record.result),
          });
        }
      }
      if (produced.length === 0) return { event: null, raw: line };
      return { event: produced[0]!, events: produced };
    }
    if (type === 'result') {
      const usage = asRecord(parsed.usage);
      if (usage) {
        state.usage = {
          inputTokens:
            num(usage.input_tokens) +
            num(usage.cache_creation_input_tokens) +
            num(usage.cache_read_input_tokens),
          outputTokens: num(usage.output_tokens),
          totalTokens: 0,
        };
        state.usage.totalTokens = state.usage.inputTokens + state.usage.outputTokens;
      }
      const resultText = str(parsed.result);
      const subtype = str(parsed.subtype);
      if (parsed.is_error === true || subtype.startsWith('error')) {
        state.failed = true;
        const reason = str(parsed.terminal_reason);
        state.error = resultText !== '' ? resultText : reason !== '' ? `run failed (${reason})` : 'the run failed';
        return {
          event: { type: 'error', message: state.error, ...(reason ? { code: reason } : {}) },
        };
      }
      state.finalText = resultText;
      return { event: { type: 'final', text: resultText } };
    }
    // `stream_event` (partial messages) and anything new: keep the text visible.
    return { event: null, raw: line };
  },
};

/* ------------------------------------------------------------ Gemini CLI */

/**
 * Gemini CLI `--output-format stream-json` / `json`.
 *
 * Shapes differ between releases, so this reads the response text from any of
 * the documented spellings. Confirm with the engine's "test" action before
 * trusting it in a pipeline.
 */
export const geminiParser: StreamParser = {
  format: 'gemini-stream-json',
  parse(line, state): ParsedLine {
    const parsed = tryJson(line);
    const record = asRecord(parsed);
    if (!record) {
      if (line.trim() !== '') {
        state.messages.push(line);
        return { event: { type: 'text', text: line } };
      }
      return { event: null, raw: line };
    }
    const type = str(record.type);
    const text = str(record.response) || str(record.text) || str(record.content) || str(record.output);
    const stats = asRecord(record.stats) ?? asRecord(record.usage);
    if (stats) {
      const input = num(stats.input_tokens) || num(stats.inputTokens) || num(stats.promptTokenCount);
      const output = num(stats.output_tokens) || num(stats.outputTokens) || num(stats.candidatesTokenCount);
      // Gemini-style stats are session totals, not per-step deltas, so they
      // replace the running figure instead of adding to it.
      if (input || output) {
        state.usage = { inputTokens: input, outputTokens: output, totalTokens: input + output };
      }
    }
    if (type === 'init' || type === 'system') {
      state.sessionId = str(record.session_id) || str(record.sessionId) || state.sessionId;
      return { event: { type: 'session', sessionId: state.sessionId ?? '' } };
    }
    if (record.error !== undefined && record.error !== null && record.error !== false) {
      const errorRecord = asRecord(record.error);
      const message = errorRecord ? str(errorRecord.message) : str(record.error);
      state.failed = true;
      state.error = message || 'the engine reported an error';
      return { event: { type: 'error', message: state.error } };
    }
    if (type === 'tool_call' || type === 'tool_use') {
      return {
        event: {
          type: 'tool_call',
          callId: str(record.callId) || str(record.id),
          tool: str(record.name) || str(record.tool) || 'tool',
          input: record.input ?? record.args,
        },
      };
    }
    if (text !== '') {
      state.messages.push(text);
      if (type === 'result' || type === 'final') {
        state.finalText = text;
        return { event: { type: 'final', text } };
      }
      return { event: { type: 'text', text } };
    }
    return { event: null, raw: line };
  },
};

/* --------------------------------------------------------- generic JSONL */

/**
 * Best-effort parser for CLIs whose exact schema we cannot pin down.
 *
 * It recognises the common field names used for assistant text, tool calls and
 * totals, and keeps anything unrecognised visible as a diagnostic.
 */
export const jsonLinesParser: StreamParser = {
  format: 'json-lines',
  parse(line, state): ParsedLine {
    const record = asRecord(tryJson(line));
    if (!record) {
      if (line.trim() === '') return { event: null };
      state.messages.push(line);
      return { event: { type: 'text', text: line } };
    }
    const type = str(record.type) || str(record.role);

    const usage = asRecord(record.usage) ?? asRecord(record.stats) ?? asRecord(record.tokens);
    if (usage) {
      const input = num(usage.input_tokens) || num(usage.inputTokens) || num(usage.prompt_tokens);
      const output = num(usage.output_tokens) || num(usage.outputTokens) || num(usage.completion_tokens);
      if (input || output) addUsage(state.usage, input, output);
    }

    const callId = str(record.callId) || str(record.tool_use_id) || str(record.tool_call_id);
    // A tool signal must be explicit. A bare `name` field is usually just model
    // metadata (`{"role":"assistant","name":"gpt-5","content":"…”}`), and treating
    // that as a tool call used to discard the answer entirely.
    const isToolCall =
      type === 'tool_use' ||
      type === 'tool_call' ||
      type === 'function_call' ||
      (record.tool !== undefined && record.tool !== null);
    if (isToolCall) {
      const tool = str(record.tool) || str(record.name) || str(record.function);
      if (tool !== '') {
        return {
          event: {
            type: 'tool_call',
            callId: callId || `call-${state.messages.length}-${tool}`,
            tool,
            input: record.input ?? record.arguments ?? record.args,
          },
        };
      }
    }
    const isToolResult =
      type === 'tool_result' ||
      type === 'function_result' ||
      callId !== '' && (record.is_error !== undefined || record.tool_use_id !== undefined);
    if (isToolResult) {
      return {
        event: {
          type: 'tool_result',
          callId,
          status: record.is_error === true || record.error === true ? 'error' : 'completed',
          result: str(record.content) || str(record.result) || str(record.output),
        },
      };
    }

    const sessions = str(record.session_id) || str(record.sessionId);
    if (sessions !== '' && (type === 'init' || type === 'system')) {
      state.sessionId = sessions;
      return { event: { type: 'session', sessionId: sessions, cwd: str(record.cwd) } };
    }

    // Nested payloads (codex-style `{msg:{...}}`) still carry their text.
    const nested = asRecord(record.msg) ?? asRecord(record.message);
    const text =
      str(record.text) ||
      str(record.response) ||
      str(record.content) ||
      str(record.result) ||
      str(record.output) ||
      (nested ? str(nested.text) || str(nested.content) || str(nested.result) : '');

    if (record.error !== undefined && record.error !== null && record.error !== false && str(record.error) !== '') {
      state.failed = true;
      state.error = str(record.error);
      return { event: { type: 'error', message: state.error } };
    }

    if (text === '') return { event: null, raw: line };
    state.messages.push(text);
    if (type === 'result' || type === 'final' || type === 'done' || type === 'completion') {
      state.finalText = text;
      return { event: { type: 'final', text } };
    }
    return { event: { type: 'text', text } };
  },
};

/* ---------------------------------------------------------------- plain text */

/**
 * Plain-text output. Nothing can be streamed as structure, so each line is
 * echoed as text and the whole transcript becomes the final answer.
 */
export const textParser: StreamParser = {
  format: 'text',
  parse(line, state): ParsedLine {
    if (line.trim() === '') return { event: null };
    state.messages.push(line);
    return { event: { type: 'text', text: line } };
  },
  finish(state) {
    const text = state.messages.join('\n');
    state.finalText = text;
    return [{ type: 'final', text }];
  },
};

const PARSERS: Record<OutputFormat, StreamParser> = {
  'dsh-json': dshParser,
  'claude-stream-json': claudeParser,
  'gemini-stream-json': geminiParser,
  'json-lines': jsonLinesParser,
  text: textParser,
};

export function getParser(format: OutputFormat): StreamParser {
  return PARSERS[format] ?? jsonLinesParser;
}

export const OUTPUT_FORMATS: OutputFormat[] = [
  'dsh-json',
  'claude-stream-json',
  'gemini-stream-json',
  'json-lines',
  'text',
];