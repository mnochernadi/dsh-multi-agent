import { launcherArgs, ensureCwd, runLauncher, type Launcher } from './launcher.ts';
import { runProcess } from '../util/process.ts';
import { dshParser } from '../engines/parsers.ts';
import { emptyParserState } from '../engines/types.ts';
import type { AgentRunOutcome, AgentStreamEvent } from '../types.ts';

export type { AgentRunOutcome } from '../types.ts';

export interface AgentRunOptions {
  launcher: Launcher;
  /** Path of the generated run patch. */
  patchPath: string;
  /** Task text; written to the runner's stdin, never to a command line. */
  task: string;
  cwd: string;
  timeoutMs: number;
  /** DSH profile to boot (defaults to `headless`). */
  profile?: string;
  /** Extra launcher/app arguments inserted before the task marker. */
  extraArgs?: string[];
  env?: Record<string, string>;
  onEvent?: (event: AgentStreamEvent) => void;
  onStderr?: (chunk: string) => void;
  onDiagnostic?: (line: string) => void;
}

export interface AgentRunHandle {
  abort(reason?: string): void;
  readonly pid: number | null;
  readonly done: Promise<AgentRunOutcome>;
}

/**
 * Start one agent as a real `dsh --profile headless --json` process.
 *
 * The task travels over stdin, so prompt text never has to survive command-line
 * quoting. Output is newline-delimited JSON, decoded by the shared DSH parser —
 * the same event vocabulary every other engine maps into.
 */
export function startAgentRun(options: AgentRunOptions): AgentRunHandle {
  const profile = options.profile ?? 'headless';
  // Order matters: the launcher parses its own options (`--patch`) until it
  // meets one it does not know (`--json`), after which every remaining argument
  // is forwarded to the booted app. Launcher flags must therefore come first.
  const args = launcherArgs(options.launcher, [
    profile,
    '--patch',
    options.patchPath,
    '--json',
    ...(options.extraArgs ?? []),
    '-',
  ]);

  const state = emptyParserState();

  const handle = runProcess({
    command: options.launcher.command,
    args,
    cwd: ensureCwd(options.cwd),
    env: { ...process.env, ...options.launcher.env, ...(options.env ?? {}) },
    timeoutMs: options.timeoutMs,
    onStdoutLine: (line) => {
      const parsed = dshParser.parse(line, state);
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

  handle.sendStdin(options.task);

  const done = handle.done.then((outcome): AgentRunOutcome => {
    for (const event of dshParser.finish?.(state) ?? []) options.onEvent?.(event);

    // Prefer the specific cause: a provider failure carries it in
    // `turn_end.reason.error`, and the runner repeats it on stderr as `dsh: …`.
    let error = state.error;
    if (!error) {
      const diagnostic = outcome.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('dsh:'))
        .pop();
      if (diagnostic) error = diagnostic.replace(/^dsh:\s*/, '');
    }
    if (!error && !outcome.aborted && !outcome.timedOut && outcome.exitCode !== 0) {
      error = `dsh exited with code ${outcome.exitCode ?? 'null'}`;
    }

    const finalText = state.finalText !== '' ? state.finalText : state.messages.join('\n\n');
    const ok = error === null && !outcome.aborted && !outcome.timedOut && outcome.exitCode === 0;

    return {
      ok,
      exitCode: outcome.exitCode,
      finalText,
      messages: state.messages,
      thinking: state.thinking,
      sessionId: state.sessionId,
      turnEndReason: state.failed ? { kind: 'error' } : { kind: 'completed' },
      usage: state.usage,
      error: ok ? null : (error ?? 'the run failed'),
      stderr: outcome.stderr,
      aborted: outcome.aborted,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
    };
  });

  return { abort: handle.abort, pid: handle.pid, done };
}

/**
 * Validate a run patch without spending tokens: `--dump-config` composes the
 * loader tree, so a bad provider/model/effort is reported here rather than
 * mid-run.
 */
export async function verifyPatch(
  launcher: Launcher,
  patchPath: string,
  options: { profile?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; message: string }> {
  const result = await runLauncher(
    launcher,
    [options.profile ?? 'headless', '--patch', patchPath, '--dump-config'],
    { timeoutMs: options.timeoutMs ?? 60_000, cwd: options.cwd },
  );
  if (result.timedOut) return { ok: false, message: 'Composing the profile timed out.' };
  if (result.code === 0) return { ok: true, message: 'Profile composed successfully.' };
  const message = (result.stderr || result.stdout).trim().split('\n').slice(0, 6).join('\n');
  return { ok: false, message: message || `dsh exited with code ${result.code}` };
}