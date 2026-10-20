import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { envValue } from '../util/env.ts';
import { resolveDshHome } from '../config/paths.ts';
import { createLogger } from '../util/log.ts';
import { looksLikePath, parseCommandWrapper } from '../util/winwrap.ts';

const log = createLogger('dsh:launcher');

export type LaunchKind = 'electron-asar' | 'node-script' | 'executable' | 'shell';

export interface Launcher {
  /** How the command line is assembled. */
  kind: LaunchKind;
  /** Executable to spawn. */
  command: string;
  /** Arguments placed before the app arguments (`headless`, `--patch`, ...). */
  argsPrefix: string[];
  /** Extra environment for the child. */
  env: Record<string, string>;
  /** Where this launcher was found. */
  source: string;
  /** The launcher file the user would run by hand. */
  launcherPath: string;
}

export interface LauncherProbe {
  launcher: Launcher | null;
  version: string | null;
  error: string | null;
  candidatesTried: string[];
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isRunnable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return isFile(candidate);
  }
}

/** Platform-specific places the DeepSeek Harness desktop app installs its CLI. */
export function defaultLauncherCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];
  if (process.platform === 'win32') {
    const local = envValue('LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local');
    out.push(
      path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'),
    );
  } else if (process.platform === 'darwin') {
    out.push(
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
    );
  } else {
    out.push(
      path.join(home, '.local', 'share', 'deepseek-harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'),
      '/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
      '/usr/local/bin/dsh',
    );
  }
  return out;
}

/** Every entry named `dsh` on PATH (`.cmd`/`.exe` variants on Windows). */
function pathCandidates(): string[] {
  const dirs = (envValue('PATH') ?? '').split(path.delimiter).filter(Boolean);
  const names =
    process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh'] : ['dsh'];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) out.push(candidate);
    }
  }
  return out;
}


/**
 * Turn a launcher file into an exact command line.
 *
 * The shipped `dsh.cmd` is a two-line wrapper around
 * `<app>.exe --expose-internals <app.asar>/dsh/.../cli.js`, so we read it and
 * spawn the executable directly. That avoids a shell entirely â€” which matters
 * because run patches live under paths that routinely contain spaces.
 */
export function buildLauncherFromFile(launcherPath: string, source: string): Launcher | null {
  const resolved = path.resolve(launcherPath);
  if (!isFile(resolved)) return null;
  const ext = path.extname(resolved).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    const wrapper = parseCommandWrapper(resolved);
    if (!wrapper || wrapper.shell) {
      log.warn(`cannot take apart the launcher wrapper ${resolved}`);
      return null;
    }
    if (looksLikePath(wrapper.command) && !existsSync(wrapper.command)) {
      log.warn(`launcher ${resolved} points at a missing executable`, { command: wrapper.command });
      return null;
    }
    return {
      kind: 'electron-asar',
      command: wrapper.command,
      argsPrefix: wrapper.argsPrefix,
      env: { ELECTRON_RUN_AS_NODE: '1', ...wrapper.env },
      source,
      launcherPath: resolved,
    };
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return {
      kind: 'node-script',
      command: process.execPath,
      argsPrefix: [resolved],
      env: {},
      source,
      launcherPath: resolved,
    };
  }

  if (process.platform !== 'win32' && isRunnable(resolved)) {
    return { kind: 'executable', command: resolved, argsPrefix: [], env: {}, source, launcherPath: resolved };
  }

  if (process.platform === 'win32' && (ext === '.exe' || ext === '')) {
    return { kind: 'executable', command: resolved, argsPrefix: [], env: {}, source, launcherPath: resolved };
  }

  return { kind: 'shell', command: resolved, argsPrefix: [], env: {}, source, launcherPath: resolved };
}

/**
 * Locate the `dsh` launcher. Order: explicit setting/environment, then PATH,
 * then the platform's standard installation directories.
 */
export function resolveLauncher(configured?: string): { launcher: Launcher | null; candidatesTried: string[] } {
  const candidates: string[] = [];
  const explicit = configured?.trim() || envValue('DSH_MA_DSH_BIN') || envValue('DSH_BIN');
  if (explicit) candidates.push(explicit);
  candidates.push(...pathCandidates(), ...defaultLauncherCandidates());

  for (const candidate of candidates) {
    const built = buildLauncherFromFile(candidate, explicit && candidate === explicit ? 'configured' : 'auto-detected');
    if (built) return { launcher: built, candidatesTried: candidates };
  }
  return { launcher: null, candidatesTried: candidates };
}

/** Full argument list for one invocation. */
export function launcherArgs(launcher: Launcher, appArgs: string[]): string[] {
  return [...launcher.argsPrefix, ...appArgs];
}

/**
 * A usable working directory for a child process.
 *
 * `spawn` reports a missing `cwd` as ENOENT on the *command*, which is
 * misleading, so the directory is created first and any failure falls back to
 * inheriting the dashboard's own directory.
 */
export function ensureCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    mkdirSync(cwd, { recursive: true });
    return cwd;
  } catch (error) {
    log.warn(`cannot use ${cwd} as a working directory`, { error: String(error) });
    return undefined;
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a short-lived command and capture its output (used for probing only). */
export function runLauncher(
  launcher: Launcher,
  appArgs: string[],
  options: { timeoutMs?: number; env?: Record<string, string>; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(launcher.command, launcherArgs(launcher, appArgs), {
      cwd: ensureCwd(options.cwd),
      env: { ...process.env, ...launcher.env, ...(options.env ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : null;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Confirm a launcher works and report its version. */
export async function probeLauncher(configured?: string): Promise<LauncherProbe> {
  const { launcher, candidatesTried } = resolveLauncher(configured);
  if (!launcher) {
    return {
      launcher: null,
      version: null,
      error: 'No `dsh` launcher found. Install DeepSeek Harness or set DSH_MA_DSH_BIN.',
      candidatesTried,
    };
  }
  const result = await runLauncher(launcher, ['--version'], { timeoutMs: 30_000 });
  const version = result.stdout.trim().split('\n')[0]?.trim() ?? '';
  if (result.code !== 0 || version === '') {
    return {
      launcher,
      version: null,
      error: result.stderr.trim() || `launcher exited with code ${result.code}`,
      candidatesTried,
    };
  }
  return { launcher, version, error: null, candidatesTried };
}

/** Profile names present in `$DSH_HOME/profiles`. */
export function listProfiles(dshHome = resolveDshHome()): string[] {
  const profilesDir = path.join(dshHome, 'profiles');
  try {
    return readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Patch files a profile composes, most specific last. */
export function profilePatchFiles(profile: string, dshHome = resolveDshHome()): string[] {
  const dir = path.join(dshHome, 'profiles', profile);
  return ['cordis.patch.yml', 'cordis.yml', 'package.json']
    .map((name) => path.join(dir, name))
    .filter((file) => isFile(file));
}
