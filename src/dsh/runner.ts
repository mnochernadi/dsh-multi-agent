import { spawn, type ChildProcess } from 'node:child_process';
import { launcherArgs, ensureCwd, runLauncher, type Launcher } from './launcher.ts';
import type { DshStreamEvent, UsageTotals } from '../types.ts';

const MAX_STDERR_BYTES = 256 * 1024;

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
  onEvent?: (event: DshStreamEvent) => void;
  onStderr?: (chunk: string) => void;
  onDiagnostic?: (line: string) => void;
}

export interface AgentRunOutcome {
  ok: boolean;
  exitCode: number | null;
  finalText: string;
  messages: string[];
  thinking: string[];
  sessionId: string | null;
  turnEndReason: unknown;
  usage: UsageTotals;
  error: string | null;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface AgentRunHandle {
  abort(reason?: string): void;
  readonly pid: number | null;
  readonly done: Promise<AgentRunOutcome>;
}

function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(target: UsageTotals, add: UsageTotals | undefined): void {
  if (!add) return;
  target.inputTokens += Number(add.inputTokens) || 0;
  target.outputTokens += Number(add.outputTokens) || 0;
  target.totalTokens += Number(add.totalTokens) || 0;
}

/**
 * Start one agent as a real `dsh --profile headless --json` process.
 *
 * The task travels over stdin, so prompt text never has to survive command-line
 * quoting. Everything the run reports arrives as newline-delimited JSON events.
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

  const child: ChildProcess = spawn(options.launcher.command, args, {
    cwd: ensureCwd(options.cwd),
    env: { ...process.env, ...options.launcher.env, ...(options.env ?? {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const startedAt = Date.now();
  const messages: string[] = [];
  const thinking: string[] = [];
  const usage = emptyUsage();
  let sessionId: string | null = null;
  let finalText = '';
  let turnEndReason: unknown = null;
  let errorText: string | null = null;
  let stderr = '';
  let stdoutBuffer = '';
  let aborted = false;
  let timedOut = false;
  let settled = false;

  const killTree = (): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      // The Electron-based launcher can have children; kill the whole tree.
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        child.kill();
      }
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5000).unref?.();
    }
  };

  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, options.timeoutMs)
      : null;

  const handleLine = (line: string): void => {
    const text = line.trim();
    if (text === '') return;
    let parsed: DshStreamEvent;
    try {
      parsed = JSON.parse(text) as DshStreamEvent;
    } catch {
      options.onDiagnostic?.(text);
      return;
    }
    switch (parsed.type) {
      case 'session':
        sessionId = parsed.sessionId;
        break;
      case 'text':
        if (parsed.text.trim() !== '') messages.push(parsed.text);
        break;
      case 'thinking':
        if (parsed.text.trim() !== '') thinking.push(parsed.text);
        break;
      case 'status':
        if (parsed.phase === 'step_end') addUsage(usage, parsed.usage);
        if (parsed.phase === 'turn_end') turnEndReason = parsed.reason ?? null;
        break;
      case 'final':
        finalText = parsed.text;
        break;
      case 'error':
        errorText = parsed.code ? `${parsed.code}: ${parsed.message}` : parsed.message;
        break;
      default:
        break;
    }
    options.onEvent?.(parsed);
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf('\n');
    while (index !== -1) {
      handleLine(stdoutBuffer.slice(0, index));
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      index = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    options.onStderr?.(chunk);
  });

  if (child.stdin) {
    child.stdin.on('error', () => {
      /* the runner may exit before reading stdin; not fatal */
    });
    child.stdin.end(options.task, 'utf8');
  }

  const done = new Promise<AgentRunOutcome>((resolve) => {
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stdoutBuffer.trim() !== '') handleLine(stdoutBuffer);
      const reason = turnEndReason as
        | { kind?: string; error?: { message?: string; code?: string } }
        | null;
      const reasonKind = reason && typeof reason === 'object' ? reason.kind : undefined;

      // A provider failure carries the real cause in `turn_end.reason.error`;
      // prefer it over the generic "turn ended with reason error".
      if (!errorText && reason?.error?.message) {
        errorText = reason.error.code
          ? `${reason.error.code}: ${reason.error.message}`
          : reason.error.message;
      }
      if (!errorText && stderr.trim() !== '') {
        const diagnostic = stderr
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('dsh:'))
          .pop();
        if (diagnostic) errorText = diagnostic.replace(/^dsh:\s*/, '');
      }

      const ok = !aborted && !timedOut && exitCode === 0 && reasonKind !== 'error';
      const derivedError =
        errorText ??
        (ok
          ? null
          : reasonKind && reasonKind !== 'completed'
            ? `turn ended with reason "${reasonKind}"`
            : `dsh exited with code ${exitCode ?? 'null'}`);
      resolve({
        ok,
        exitCode,
        finalText: finalText !== '' ? finalText : messages.join('\n\n'),
        messages,
        thinking,
        sessionId,
        turnEndReason,
        usage,
        error: ok ? null : derivedError,
        stderr: stderr.trim(),
        aborted,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (error) => {
      errorText = errorText ?? String(error);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

  return {
    pid: child.pid ?? null,
    abort: () => {
      if (settled) return;
      aborted = true;
      killTree();
    },
    done,
  };
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