import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { envValue } from '../util/env.ts';

/** `<repo root>` — the directory that contains `package.json`. */
export const projectRoot = path.resolve(import.meta.dirname, '..', '..');

/**
 * Dashboard state lives outside the tracked tree (see .gitignore): settings,
 * run records, generated patches, and per-run workspaces.
 */
export const stateRoot = envValue('DSH_MA_HOME')
  ? path.resolve(envValue('DSH_MA_HOME')!)
  : path.join(projectRoot, '.dsh-multi-agent');

export const settingsFile = path.join(stateRoot, 'settings.json');
export const runsDir = path.join(stateRoot, 'runs');
export const patchesDir = path.join(stateRoot, 'patches');
export const workspacesDir = path.join(stateRoot, 'workspaces');
export const defaultWorkspaceDir = path.join(workspacesDir, 'default');
export const publicDir = path.join(projectRoot, 'public');

export function ensureStateDirs(): void {
  for (const dir of [stateRoot, runsDir, patchesDir, workspacesDir, defaultWorkspaceDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** DSH home: profiles, credential store and session logs live here. */
export function resolveDshHome(): string {
  return envValue('DSH_HOME') ?? path.join(homedir(), '.dsh');
}

export function resolveRunCwd(): string {
  const configured = envValue('DSH_MA_RUN_CWD');
  if (configured) return path.resolve(configured);
  return path.join(workspacesDir, 'default');
}
