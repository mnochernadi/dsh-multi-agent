import { spawn, type ChildProcess } from 'node:child_process';

/**
 * One place where child processes are started, streamed, timed out and killed.
 *
 * Both the DSH runner and every external CLI engine go through this, so abort
 * behaviour (which must kill a whole process tree on Windows) and line framing
 * are implemented once.
 */

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Spawn through a shell. Only used for wrappers that cannot be resolved. */
  shell?: boolean;
  /** Wall-clock limit; 0 disables it. */
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  /** Cap for the retained stderr text. */
  maxStderrBytes?: number;
}

export interface ProcessRunOutcome {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  spawnError: string | null;
}

export interface ProcessHandle {
  abort(): void;
  readonly pid: number | null;
  readonly done: Promise<ProcessRunOutcome>;
  /** Write and close stdin in one step (the common case). */
  sendStdin(text: string): void;
  /** Close stdin without writing anything. */
  closeStdin(): void;
}

export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      // Electron-based and wrapper-launched agents can have children.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      child.kill();
    }
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 5000).unref?.();
}

export function runProcess(options: ProcessRunOptions): ProcessHandle {
  const startedAt = Date.now();
  const maxStderr = options.maxStderrBytes ?? 256 * 1024;

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderr = '';
  let aborted = false;
  let timedOut = false;
  let settled = false;

  const timer =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree(child);
        }, options.timeoutMs)
      : null;

  const flushLine = (line: string): void => {
    if (line === '') return;
    options.onStdoutLine?.(line);
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf('\n');
    while (index !== -1) {
      flushLine(stdoutBuffer.slice(0, index));
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      index = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < maxStderr) stderr += chunk;
    options.onStderr?.(chunk);
  });

  child.stdin?.on('error', () => {
    // A CLI may exit before reading stdin; that is not fatal by itself.
  });

  const done = new Promise<ProcessRunOutcome>((resolve) => {
    let spawnError: string | null = null;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Flush a final line that arrived without a trailing newline.
      if (stdoutBuffer !== '') flushLine(stdoutBuffer.replace(/\r$/, ''));
      resolve({
        exitCode,
        stderr: stderr.trim(),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        spawnError,
      });
    };
    child.on('error', (error) => {
      spawnError = String(error);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

  return {
    pid: child.pid ?? null,
    abort: () => {
      if (settled) return;
      aborted = true;
      killProcessTree(child);
    },
    sendStdin: (text: string) => {
      if (!child.stdin) return;
      child.stdin.end(text, 'utf8');
    },
    closeStdin: () => {
      child.stdin?.end();
    },
    done,
  };
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

/** Run a short command and collect its output (version probes, health checks). */
export async function captureProcess(
  options: ProcessRunOptions & { stdin?: string },
): Promise<CaptureResult> {
  const lines: string[] = [];
  const handle = runProcess({
    ...options,
    onStdoutLine: (line) => lines.push(line),
  });
  if (options.stdin !== undefined) handle.sendStdin(options.stdin);
  else handle.closeStdin();
  const outcome = await handle.done;
  return {
    code: outcome.exitCode,
    stdout: lines.join('\n'),
    stderr: outcome.stderr,
    timedOut: outcome.timedOut,
    spawnError: outcome.spawnError,
  };
}