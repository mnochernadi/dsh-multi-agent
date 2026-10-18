#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { projectRoot, ensureStateDirs, resolveDshHome } from './config/paths.ts';
import { applyEnvOverrides, loadSettings, saveSettings } from './config/settings.ts';
import { discoverFromDsh } from './config/discover.ts';
import { listProfiles, probeLauncher, type Launcher } from './dsh/launcher.ts';
import { Orchestrator } from './orchestrator/engine.ts';
import { EventHub } from './server/events.ts';
import { createDashboardServer } from './server/http-server.ts';
import { loadDotEnv, envValue } from './util/env.ts';
import { createLogger, setLogLevel } from './util/log.ts';
import type { DashboardSettings, DshInfo } from './types.ts';

const log = createLogger('main');

interface CliOptions {
  host?: string;
  port?: number;
  open: boolean;
  help: boolean;
  version: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { open: false, help: false, version: false, logLevel: 'info' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string | undefined => argv[++i];
    if (arg === '--host' || arg === '-H') options.host = next();
    else if (arg === '--port' || arg === '-p') {
      const value = Number.parseInt(next() ?? '', 10);
      if (Number.isFinite(value)) options.port = value;
    } else if (arg === '--open') options.open = true;
    else if (arg === '--log-level') {
      const value = next();
      if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
        options.logLevel = value;
      }
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-V') options.version = true;
  }
  return options;
}

function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'dsh-multi-agent — a multi-agent dashboard for DeepSeek Harness',
      '',
      'Usage: dsh-multi-agent [options]',
      '',
      'Options:',
      '  -H, --host <host>       bind address          (default 127.0.0.1)',
      '  -p, --port <port>       port                  (default 7317)',
      '      --open              open the dashboard in your browser',
      '      --log-level <level> debug | info | warn | error',
      '  -V, --version           print the dashboard version',
      '  -h, --help              print this help',
      '',
      'Environment (see .env.example): DSH_MA_DSH_BIN, DSH_MA_DASHBOARD_PORT,',
      'DSH_MA_RUN_CWD, DSH_MA_MAX_CONCURRENCY, DSH_MA_TRUST_STORED_CREDENTIALS.',
      '',
      'Each agent runs as a real `dsh --profile headless` process, so the model,',
      'tools, and credentials are exactly the ones DeepSeek Harness uses.',
      '',
    ].join('\n'),
  );
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (error) {
    log.warn(`could not open a browser for ${url}`, { error: String(error) });
  }
}

async function main(): Promise<void> {
  const envFile = loadDotEnv(path.join(projectRoot, '.env'));
  const options = parseArgs(process.argv.slice(2));
  setLogLevel(options.logLevel);
  const version = packageVersion();

  if (options.help) {
    printHelp();
    return;
  }
  if (options.version) {
    process.stdout.write(`${version}\n`);
    return;
  }

  ensureStateDirs();
  let settings: DashboardSettings = applyEnvOverrides(loadSettings());
  if (options.host) settings.server.host = options.host;
  if (options.port !== undefined) settings.server.port = options.port;

  // A first run with no catalogue imports whatever the Harness app configured,
  // so the UI opens with real, selectable providers.
  if (Object.keys(settings.providers).length === 0) {
    const discovery = discoverFromDsh(settings.dsh.home || resolveDshHome());
    if (Object.keys(discovery.catalogue).length > 0) {
      settings = saveSettings({ ...settings, providers: discovery.catalogue });
      log.info(`imported ${Object.keys(discovery.catalogue).length} provider(s) from your DSH profiles`);
    }
  }

  let launcherCache: { launcher: Launcher | null; at: number; info: DshInfo } | null = null;
  const probe = async (force = false): Promise<{ launcher: Launcher | null; info: DshInfo }> => {
    if (!force && launcherCache && Date.now() - launcherCache.at < 15_000) return launcherCache;
    const result = await probeLauncher(settings.dsh.bin);
    const info: DshInfo = {
      launcherFound: result.launcher !== null,
      launcherPath: result.launcher?.launcherPath ?? null,
      launchKind: result.launcher?.kind ?? null,
      source: result.launcher?.source ?? null,
      version: result.version,
      error: result.error,
      dshHome: settings.dsh.home || resolveDshHome(),
      profiles: listProfiles(settings.dsh.home || resolveDshHome()),
      candidatesTried: result.candidatesTried.slice(0, 6),
    };
    launcherCache = { launcher: result.launcher, at: Date.now(), info };
    return launcherCache;
  };

  const initial = await probe(true);
  if (!initial.launcher) {
    log.error(initial.info.error ?? 'No DSH launcher found.');
    log.error('Set DSH_MA_DSH_BIN to your dsh launcher, or install DeepSeek Harness.');
  } else {
    log.info(`launcher: ${initial.info.launcherPath} (${initial.info.launchKind}, dsh ${initial.info.version})`);
  }

  const hub = new EventHub();
  const orchestrator = new Orchestrator({
    getSettings: () => settings,
    getLauncher: () => {
      if (!launcherCache?.launcher) {
        throw new Error(
          launcherCache?.info.error ??
            'No DSH launcher is available. Set DSH_MA_DSH_BIN or install DeepSeek Harness.',
        );
      }
      return launcherCache.launcher;
    },
    emit: (event) => {
      hub.emit(event);
    },
  });
  orchestrator.loadHistory();

  const dashboard = createDashboardServer({
    getSettings: () => settings,
    saveSettings: (next) => {
      settings = saveSettings(next);
      return settings;
    },
    getLauncher: () => {
      if (!launcherCache?.launcher) {
        throw new Error(
          launcherCache?.info.error ??
            'No DSH launcher is available. Set DSH_MA_DSH_BIN or install DeepSeek Harness.',
        );
      }
      return launcherCache.launcher;
    },
    getInfo: async () => (await probe(false)).info,
    importProviders: () => {
      const discovery = discoverFromDsh(settings.dsh.home || resolveDshHome());
      return {
        catalogue: discovery.catalogue,
        defaultModel: discovery.defaultModel,
        sources: discovery.sources,
        warnings: discovery.warnings,
      };
    },
    orchestrator,
    hub,
    version,
  });

  const address = await dashboard.listen();
  if (envFile.loaded) log.debug(`loaded ${envFile.keys.length} value(s) from .env`);
  process.stdout.write(
    [
      '',
      `  dsh-multi-agent ${version}`,
      `  dashboard   ${address.url}`,
      `  dsh         ${initial.info.launcherPath ?? 'not found'}`,
      `  providers   ${Object.keys(settings.providers).length}`,
      `  state       ${path.join(projectRoot, '.dsh-multi-agent')}`,
      '',
      '  Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );

  if (options.open) openBrowser(address.url);

  const shutdown = (): void => {
    log.info('shutting down');
    void dashboard.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1]);
if (isMain || envValue('DSH_MA_FORCE_MAIN') === '1') {
  main().catch((error: unknown) => {
    log.error('fatal', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
    process.exitCode = 1;
  });
}