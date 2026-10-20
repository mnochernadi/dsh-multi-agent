import { getParser } from './parsers.ts';
import { resolveLaunch } from './detect.ts';
import { renderArgs } from './template.ts';
import { runProcess } from '../util/process.ts';
import { emptyParserState, type EngineDefinition, type EngineDetection, type EngineLaunch } from './types.ts';
import type { AgentRunOutcome, AgentStreamEvent } from '../types.ts';

/**
 * Run one agent through an external CLI engine.
 *
 * The contract is deliberately identical to the DSH runner: the orchestrator
 * does not care whether a sub-agent was a `dsh` process, Claude Code, or a
 * user-defined command, so pipelines and per-agent model choice work the same
 * everywhere.
 */

export interface CliAgentRunOptions {
  engine: EngineDefinition;
  detection: EngineDetection;
  prompt: string;
  /** Model id for `{model}`; empty means "engine default". */
  model: string;
  cwd: string;
  timeoutMs: number;
  /** Passed as `{sessionId}` for engines that can resume a conversation. */
  sessionId?: string;
  onEvent?: (event: AgentStreamEvent) => void;
  onStderr?: (chunk: string) => void;
  onDiagnostic?: (line: string) => void;
}

export interface CliAgentRunHandle {
  abort(): void;
  readonly pid: number | null;
  readonly done: Promise<AgentRunOutcome>;
}

function buildEnv(engine: EngineDefinition, launch: EngineLaunch): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env, ...(engine.run.env ?? {}) };
  for (const name of engine.run.envPassthrough ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function startCliAgentRun(options: CliAgentRunOptions): CliAgentRunHandle {
  const { engine, detection } = options;
  const launch: EngineLaunch | null =
    detection.launch ?? resolveLaunch(detection.executablePath ?? engine.detect.commands[0] ?? engine.id);

  if (!launch) {
    // Refusing here is deliberate: launching an unreadable wrapper would need a
    // shell, and a shell would interpret metacharacters inside the prompt.
    const message =
      `${engine.label}: no safe command line could be built from ${detection.executablePath ?? 'its definition'}. ` +
      'Pin a real executable in the engine settings.';
    return {
      pid: null,
      abort: () => undefined,
      done: Promise.resolve({
        ok: false,
        exitCode: null,
        finalText: '',
        messages: [],
        thinking: [],
        sessionId: null,
        turnEndReason: null,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        error: message,
        stderr: '',
        aborted: false,
        timedOut: false,
        durationMs: 0,
      }),
    };
  }

  const args = [
    ...launch.argsPrefix,
    ...renderArgs(engine.run.argsTemplate, {
      prompt: options.prompt,
      model: options.model,
      cwd: options.cwd,
      sessionId: options.sessionId ?? '',
      extra: engine.run.extraArgs ?? [],
    }),
  ];

  const promptInStdin =
    engine.run.promptViaStdin && !engine.run.argsTemplate.some((token) => token.includes('{prompt}'));

  // A session id can only continue a conversation if the engine's template
  // actually forwards it; saying so beats silently starting a fresh session.
  if (options.sessionId && !engine.run.argsTemplate.some((token) => token.includes('{sessionId}'))) {
    options.onDiagnostic?.(
      `${engine.label} does not accept a session id (add {sessionId} to its argument template); this agent starts a fresh session instead of continuing.`,
    );
  }

  const state = emptyParserState();
  const parser = getParser(engine.run.outputFormat);
  const startedAt = Date.now();

  const handle = runProcess({
    command: launch.command,
    args,
    cwd: options.cwd,
    env: buildEnv(engine, launch),
    shell: launch.shell,
    timeoutMs: options.timeoutMs,
    onStdoutLine: (line) => {
      const parsed = parser.parse(line, state);
      if (parsed.events) {
        for (const event of parsed.events) options.onEvent?.(event);
      } else if (parsed.event) {
        options.onEvent?.(parsed.event);
      } else if (parsed.raw) {
        options.onDiagnostic?.(parsed.raw);
      }
    },
    onStderr: (chunk) => options.onStderr?.(chunk),
  });

  if (promptInStdin) handle.sendStdin(options.prompt);
  else handle.closeStdin();

  const done = handle.done.then((outcome): AgentRunOutcome => {
    // Some engines (plain-text ones) only produce an answer when the stream ends.
    for (const event of parser.finish?.(state) ?? []) options.onEvent?.(event);

    const finalText = state.finalText !== '' ? state.finalText : state.messages.join('\n\n');
    const stderrTail = outcome.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(-3)
      .join(' ');

    let error: string | null = null;
    if (!outcome.aborted && !outcome.timedOut) {
      if (state.failed) error = state.error ?? 'the engine reported a failed run';
      else if (outcome.spawnError) error = outcome.spawnError;
      else if (outcome.exitCode !== 0) {
        error = stderrTail || `the engine exited with code ${outcome.exitCode}`;
      } else if (finalText === '') {
        error = 'the engine produced no output';
      }
    }

    return {
      ok: error === null && !outcome.aborted && !outcome.timedOut,
      exitCode: outcome.exitCode,
      finalText,
      messages: state.messages,
      thinking: state.thinking,
      sessionId: state.sessionId,
      turnEndReason: state.failed ? { kind: 'error', error: { message: state.error } } : { kind: 'completed' },
      usage: state.usage,
      error,
      stderr: outcome.stderr,
      aborted: outcome.aborted,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs || Date.now() - startedAt,
    };
  });

  return { abort: handle.abort, pid: handle.pid, done };
}

/** Build the command line without running it (used by tests and diagnostics). */
export function describeInvocation(options: {
  engine: EngineDefinition;
  detection: EngineDetection;
  prompt: string;
  model: string;
  cwd: string;
  sessionId?: string;
}): { command: string; args: string[]; stdin: string | null; shell: boolean; error: string | null } {
  const launch: EngineLaunch | null =
    options.detection.launch ??
    resolveLaunch(options.detection.executablePath ?? options.engine.detect.commands[0] ?? options.engine.id);
  if (!launch) {
    return {
      command: '',
      args: [],
      stdin: null,
      shell: false,
      error: `No safe command line for ${options.engine.label}.`,
    };
  }
  const args = [
    ...launch.argsPrefix,
    ...renderArgs(options.engine.run.argsTemplate, {
      prompt: options.prompt,
      model: options.model,
      cwd: options.cwd,
      sessionId: options.sessionId ?? '',
      extra: options.engine.run.extraArgs ?? [],
    }),
  ];
  const promptInStdin =
    options.engine.run.promptViaStdin &&
    !options.engine.run.argsTemplate.some((token) => token.includes('{prompt}'));
  return {
    command: launch.command,
    args,
    stdin: promptInStdin ? options.prompt : null,
    shell: launch.shell,
    error: null,
  };
}