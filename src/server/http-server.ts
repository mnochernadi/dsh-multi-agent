import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { publicDir, stateRoot } from '../config/paths.ts';
import { keyAvailability } from '../config/discover.ts';
import { createLogger } from '../util/log.ts';
import type { Launcher } from '../dsh/launcher.ts';
import type { AgentSpec, DashboardSettings, RunRequest } from '../types.ts';
import type { Orchestrator } from '../orchestrator/engine.ts';
import type { EventHub } from './events.ts';
import { buildRunPatch, writeRunPatch } from '../dsh/patch.ts';
import { verifyPatch } from '../dsh/runner.ts';
import { newId } from '../util/ids.ts';
import { detectEngine, healthCheckEngine, handoffToIde, invalidateDetection } from '../engines/detect.ts';
import { builtinEngines, DSH_ENGINE_ID } from '../engines/presets.ts';
import { normalizeEngine, hiddenPresets, resolveEngines, slugifyEngineId, validateEngine } from '../engines/registry.ts';
import { OUTPUT_FORMATS } from '../engines/parsers.ts';
import type { EngineDetection, EngineDefinition } from '../engines/types.ts';

const log = createLogger('server');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface ServerDeps {
  /** Current settings (already merged with environment overrides). */
  getSettings(): DashboardSettings;
  saveSettings(next: DashboardSettings): DashboardSettings;
  getLauncher(): Launcher;
  /** Re-probe the launcher and report what the dashboard can see. */
  getInfo(): Promise<unknown>;
  /** Import providers/models from the DSH profile layer. */
  importProviders(): { catalogue: unknown; defaultModel: unknown; sources: unknown; warnings: string[] };
  orchestrator: Orchestrator;
  hub: EventHub;
  version: string;
}

export interface DashboardServer {
  server: Server;
  listen(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

export function createDashboardServer(deps: ServerDeps): DashboardServer {
  const server = createServer((req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      log.error('unhandled request error', { url: req.url, error: String(error) });
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      else res.end();
    });
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        const settings = deps.getSettings();
        const host = settings.server.host || '127.0.0.1';
        const port = settings.server.port;
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const actualPort = typeof address === 'object' && address ? address.port : port;
          resolve({ host, port: actualPort, url: `http://${host}:${actualPort}` });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        deps.hub.close();
        server.close(() => resolve());
        // Do not wait for keep-alive sockets that never close.
        setTimeout(() => resolve(), 2000).unref?.();
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, deps, pathname, url);
    return;
  }
  serveStatic(res, pathname);
}

/* --------------------------------------------------------------------- routes */

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  pathname: string,
  url: URL,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  if (pathname === '/api/health' && method === 'GET') {
    sendJson(res, 200, { ok: true, version: deps.version, uptimeMs: Math.round(process.uptime() * 1000) });
    return;
  }

  if (pathname === '/api/info' && method === 'GET') {
    const settings = deps.getSettings();
    sendJson(res, 200, {
      info: await deps.getInfo(),
      version: deps.version,
      stateDir: stateRoot,
      node: process.version,
      platform: process.platform,
      settingsPath: path.join(stateRoot, 'settings.json'),
      defaults: {
        runCwd: settings.dsh.runCwd,
        profile: settings.dsh.profile,
        maxConcurrency: settings.runs.maxConcurrency,
        timeoutMs: settings.runs.timeoutMs,
      },
    });
    return;
  }

  if (pathname === '/api/settings') {
    if (method === 'GET') {
      sendJson(res, 200, { settings: deps.getSettings() });
      return;
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readJsonBody(req);
      const saved = deps.saveSettings(body as DashboardSettings);
      sendJson(res, 200, { settings: saved });
      return;
    }
    sendMethodNotAllowed(res, ['GET', 'PUT']);
    return;
  }

  if (pathname === '/api/engines') {
    if (method === 'GET') {
      sendJson(res, 200, {
        engines: await describeEngines(deps),
        hidden: hiddenPresets(deps.getSettings().engines),
        outputFormats: OUTPUT_FORMATS,
      });
      return;
    }
    if (method === 'PUT' || method === 'POST') {
      const body = (await readJsonBody(req)) as { id?: unknown; engine?: unknown };
      const raw = (body.engine ?? body) as Record<string, unknown>;
      const settings = deps.getSettings();
      const id = slugifyEngineId(String(raw.id ?? ''));
      if (id === '') {
        sendJson(res, 400, { error: 'An engine needs an id.' });
        return;
      }
      const existing = resolveEngines(settings.engines).find((engine) => engine.id === id);
      const normalized = normalizeEngine({ ...raw, id }, existing);
      if (!normalized) {
        sendJson(res, 400, { error: 'The engine definition could not be read.' });
        return;
      }
      const problems = validateEngine(normalized);
      const saved = deps.saveSettings({
        ...settings,
        engines: { ...settings.engines, [id]: normalized },
      });
      invalidateDetection(id);
      sendJson(res, 200, { settings: saved, engines: await describeEngines(deps), problems });
      return;
    }
    sendMethodNotAllowed(res, ['GET', 'PUT']);
    return;
  }

  const engineRestoreMatch = /^\/api\/engines\/([^/]+)\/restore$/.exec(pathname);
  if (engineRestoreMatch && method === 'POST') {
    const id = engineRestoreMatch[1]!;
    const settings = deps.getSettings();
    const engines = { ...settings.engines };
    delete engines[id];
    const saved = deps.saveSettings({ ...settings, engines });
    invalidateDetection(id);
    sendJson(res, 200, {
      settings: saved,
      engines: await describeEngines(deps),
      hidden: hiddenPresets(saved.engines),
    });
    return;
  }

  const engineDetectMatch = /^\/api\/engines\/([^/]+)\/detect$/.exec(pathname);
  if (engineDetectMatch && method === 'POST') {
    const settings = deps.getSettings();
    const engine = resolveEngines(settings.engines).find((entry) => entry.id === engineDetectMatch[1]!);
    if (!engine) {
      sendJson(res, 404, { error: 'Unknown engine.' });
      return;
    }
    const detection = await detectEngine(engine, { dshBin: settings.dsh.bin, force: true });
    sendJson(res, 200, { detection });
    return;
  }

  const engineTestMatch = /^\/api\/engines\/([^/]+)\/test$/.exec(pathname);
  if (engineTestMatch && method === 'POST') {
    const settings = deps.getSettings();
    const engine = resolveEngines(settings.engines).find((entry) => entry.id === engineTestMatch[1]!);
    if (!engine) {
      sendJson(res, 404, { error: 'Unknown engine.' });
      return;
    }
    const detection = await detectEngine(engine, { dshBin: settings.dsh.bin, force: true });
    const result = await healthCheckEngine(engine, detection, {
      cwd: settings.dsh.runCwd,
      dshBin: settings.dsh.bin,
    });
    sendJson(res, 200, { detection, result });
    return;
  }

  const engineHandoffMatch = /^\/api\/engines\/([^/]+)\/handoff$/.exec(pathname);
  if (engineHandoffMatch && method === 'POST') {
    const body = (await readJsonBody(req)) as { cwd?: unknown };
    const settings = deps.getSettings();
    const engine = resolveEngines(settings.engines).find((entry) => entry.id === engineHandoffMatch[1]!);
    if (!engine) {
      sendJson(res, 404, { error: 'Unknown engine.' });
      return;
    }
    const detection = await detectEngine(engine, { dshBin: settings.dsh.bin });
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd.trim() : settings.dsh.runCwd;
    const result = handoffToIde(engine, detection, cwd);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  const engineMatch = /^\/api\/engines\/([^/]+)$/.exec(pathname);
  if (engineMatch) {
    const id = engineMatch[1]!;
    const settings = deps.getSettings();
    if (method === 'GET') {
      const engine = resolveEngines(settings.engines).find((entry) => entry.id === id);
      if (!engine) {
        sendJson(res, 404, { error: 'Unknown engine.' });
        return;
      }
      const detection = await detectEngine(engine, { dshBin: settings.dsh.bin, force: true });
      sendJson(res, 200, { engine, detection });
      return;
    }
    if (method === 'DELETE') {
      const engines = { ...settings.engines };
      const isBuiltin = builtinEngines.some((engine) => engine.id === id);
      // A built-in preset is hidden rather than deleted, so it can come back.
      if (isBuiltin) engines[id] = { removed: true };
      else delete engines[id];
      const saved = deps.saveSettings({ ...settings, engines });
      invalidateDetection(id);
      sendJson(res, 200, {
        settings: saved,
        engines: await describeEngines(deps),
        hidden: hiddenPresets(saved.engines),
      });
      return;
    }
    sendMethodNotAllowed(res, ['GET', 'DELETE']);
    return;
  }

  if (pathname === '/api/providers') {
    if (method === 'GET') {
      const settings = deps.getSettings();
      sendJson(res, 200, { providers: describeProviders(settings) });
      return;
    }
    if (method === 'PUT' || method === 'POST') {
      const body = (await readJsonBody(req)) as { name?: unknown; spec?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '' || body.spec === null || typeof body.spec !== 'object') {
        sendJson(res, 400, { error: 'Expected { name: string, spec: object }.' });
        return;
      }
      const settings = deps.getSettings();
      const next: DashboardSettings = {
        ...settings,
        providers: { ...settings.providers, [name]: body.spec as DashboardSettings['providers'][string] },
      };
      const saved = deps.saveSettings(next);
      sendJson(res, 200, { settings: saved, providers: describeProviders(saved) });
      return;
    }
    sendMethodNotAllowed(res, ['GET', 'PUT']);
    return;
  }

  const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(pathname);
  if (providerMatch && method === 'DELETE') {
    const name = providerMatch[1]!;
    const settings = deps.getSettings();
    const providers = { ...settings.providers };
    delete providers[name];
    const saved = deps.saveSettings({ ...settings, providers });
    sendJson(res, 200, { settings: saved, providers: describeProviders(saved) });
    return;
  }

  if (pathname === '/api/providers/import' && method === 'POST') {
    const result = deps.importProviders();
    const settings = deps.getSettings();
    const saved = deps.saveSettings({
      ...settings,
      providers: result.catalogue as DashboardSettings['providers'],
    });
    sendJson(res, 200, { ...result, providers: describeProviders(saved), settings: saved });
    return;
  }

  if (pathname === '/api/validate' && method === 'POST') {
    const body = (await readJsonBody(req)) as {
      provider?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
      personaPrefix?: unknown;
    };
    const settings = deps.getSettings();
    const built = buildRunPatch({
      model: {
        provider: String(body.provider ?? ''),
        model: String(body.model ?? ''),
        ...(typeof body.reasoningEffort === 'string' && body.reasoningEffort !== ''
          ? { reasoningEffort: body.reasoningEffort }
          : {}),
      },
      catalogue: settings.providers,
      trustStoredCredentials: settings.dsh.trustStoredCredentials,
      ...(typeof body.personaPrefix === 'string' && body.personaPrefix !== ''
        ? { personaPrefix: body.personaPrefix }
        : {}),
    });
    if (built.problems.length > 0) {
      sendJson(res, 200, {
        ok: false,
        problems: built.problems,
        warnings: built.warnings,
        yaml: built.yaml,
        stage: 'catalogue',
      });
      return;
    }
    const patchPath = writeRunPatch('validate', newId('check'), built.yaml);
    const launcher = deps.getLauncher();
    const verification = await verifyPatch(launcher, patchPath, {
      profile: settings.dsh.profile,
      cwd: settings.dsh.runCwd,
    });
    sendJson(res, 200, {
      ok: verification.ok,
      problems: verification.ok ? [] : [verification.message],
      warnings: built.warnings,
      yaml: built.yaml,
      stage: 'dump-config',
      patchPath,
    });
    return;
  }

  if (pathname === '/api/runs') {
    if (method === 'GET') {
      const summaries = deps.orchestrator.listRuns().map((record) => ({
        id: record.id,
        status: record.status,
        mode: record.mode,
        task: record.task.slice(0, 400),
        cwd: record.cwd,
        createdAt: record.createdAt,
        startedAt: record.startedAt ?? null,
        finishedAt: record.finishedAt ?? null,
        agents: record.agents.length,
        result: record.result ? record.result.slice(0, 400) : null,
        error: record.error ?? null,
      }));
      sendJson(res, 200, { runs: summaries });
      return;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req)) as Partial<RunRequest> & { dryRun?: boolean };
      const problem = validateRunRequest(body);
      if (problem) {
        sendJson(res, 400, { error: problem });
        return;
      }
      const request = normalizeRunRequest(body as RunRequest, deps.getSettings());
      const record = deps.orchestrator.start(request);
      sendJson(res, 202, { run: record });
      return;
    }
    sendMethodNotAllowed(res, ['GET', 'POST']);
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  if (runMatch && method === 'GET') {
    const record = deps.orchestrator.getRun(runMatch[1]!);
    if (!record) {
      sendJson(res, 404, { error: 'Unknown run.' });
      return;
    }
    const since = Number.parseInt(url.searchParams.get('sinceSeq') ?? '0', 10);
    sendJson(res, 200, {
      run: record,
      events: deps.hub.history(Number.isFinite(since) ? since : 0, record.id),
    });
    return;
  }

  const abortMatch = /^\/api\/runs\/([^/]+)\/abort$/.exec(pathname);
  if (abortMatch && method === 'POST') {
    const ok = deps.orchestrator.abort(abortMatch[1]!);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Unknown or finished run.' });
    return;
  }

  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sinceRaw = req.headers['last-event-id'] ?? url.searchParams.get('sinceSeq');
    const since = Number.parseInt(String(sinceRaw ?? '0'), 10);
    deps.hub.subscribe(
      {
        write: (chunk) => res.write(chunk),
        onClose: (callback) => {
          req.on('close', callback);
          res.on('close', callback);
        },
      },
      Number.isFinite(since) ? since : 0,
    );
    return;
  }

  sendJson(res, 404, { error: `No API route for ${pathname}.` });
}

/* ------------------------------------------------------------------ utilities */

export interface EngineView {
  id: string;
  label: string;
  kind: EngineDefinition['kind'];
  builtin: boolean;
  enabled: boolean;
  description: string | null;
  homepage: string | null;
  availability: EngineDetection['availability'];
  executablePath: string | null;
  version: string | null;
  message: string;
  candidatesTried: string[];
  outputFormat: string;
  promptViaStdin: boolean;
  argsTemplate: string[];
  extraArgs: string[];
  models: { id: string; name?: string }[];
  commands: string[];
  searchGlobs: string[];
  healthArgsTemplate: string[];
  healthPrompt: string | null;
  handoffArgs: string[];
  canHandoff: boolean;
  canRun: boolean;
}

/** Engines plus their live detection state, for the settings UI. */
async function describeEngines(deps: ServerDeps): Promise<EngineView[]> {
  const settings = deps.getSettings();
  const engines = resolveEngines(settings.engines);
  const views: EngineView[] = [];
  for (const engine of engines) {
    const detection = await detectEngine(engine, { dshBin: settings.dsh.bin });
    views.push({
      id: engine.id,
      label: engine.label,
      kind: engine.kind,
      builtin: engine.builtin,
      enabled: engine.enabled,
      description: engine.description ?? null,
      homepage: engine.homepage ?? null,
      availability: detection.availability,
      executablePath: detection.executablePath,
      version: detection.version,
      message: detection.message,
      candidatesTried: detection.candidatesTried,
      outputFormat: engine.run.outputFormat,
      promptViaStdin: engine.run.promptViaStdin,
      argsTemplate: engine.run.argsTemplate,
      extraArgs: engine.run.extraArgs ?? [],
      models: (engine.run.models ?? []).map((model) => ({ id: model.id, name: model.name })),
      commands: engine.detect.commands,
      searchGlobs: engine.detect.searchGlobs ?? [],
      healthArgsTemplate: engine.run.healthArgsTemplate ?? [],
      healthPrompt: engine.run.healthPrompt ?? null,
      handoffArgs: engine.handoff?.argsTemplate ?? [],
      canHandoff: Boolean(engine.handoff),
      canRun: engine.enabled && engine.kind !== 'ide',
    });
  }
  return views;
}

/**
 * Where a provider's key is expected to come from.
 *
 * `environment` and `env-file` are observed directly. When neither is present
 * but the run trusts DSH's stored credentials, the answer is `credential-store`
 * — the same store the Harness app writes to, and the one a headless run reads
 * once the credential plugins are re-enabled.
 */
function describeKeyStatus(
  settings: DashboardSettings,
  apiKeyEnv: string | undefined,
): 'environment' | 'env-file' | 'credential-store' | 'missing' | 'unknown' {
  const observed = keyAvailability(apiKeyEnv, settings.dsh.home, settings.dsh.runCwd);
  if (observed !== 'missing') return observed;
  if (!apiKeyEnv) return 'unknown';
  return settings.dsh.trustStoredCredentials ? 'credential-store' : 'missing';
}

function describeProviders(settings: DashboardSettings): unknown[] {
  return Object.entries(settings.providers).map(([name, spec]) => ({
    name,
    displayName: spec.displayName ?? name,
    api: spec.api ?? null,
    baseURL: spec.baseURL ?? null,
    apiKeyEnv: spec.apiKeyEnv ?? null,
    keyStatus: describeKeyStatus(settings, spec.apiKeyEnv),
    models: spec.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? null,
      input: model.input ?? null,
      reasoningEfforts: model.reasoningEfforts ?? null,
    })),
  }));
}

function validateRunRequest(body: Partial<RunRequest>): string | null {
  if (typeof body.task !== 'string' || body.task.trim() === '') return 'A non-empty `task` is required.';
  if (!body.main || typeof body.main !== 'object') return '`main` (the lead agent) is required.';
  const mainProblem = validateAgentModel(body.main);
  if (mainProblem) return `The lead agent: ${mainProblem}`;
  if (body.subs !== undefined && !Array.isArray(body.subs)) return '`subs` must be an array.';
  for (const sub of body.subs ?? []) {
    const problem = validateAgentModel(sub);
    if (problem) return `Sub-agent "${sub?.name ?? sub?.id ?? '?'}": ${problem}`;
  }
  return null;
}

/**
 * A DSH agent needs a provider *and* a model. An agent on another engine does
 * not: its model is optional (the CLI's own default applies).
 */
function validateAgentModel(agent: Partial<AgentSpec> | undefined): string | null {
  if (!agent || typeof agent !== 'object') return 'the agent definition is missing.';
  const engine = typeof agent.engine === 'string' ? agent.engine.trim() : '';
  if (engine !== '' && engine !== DSH_ENGINE_ID) return null;
  if (!agent.model || typeof agent.model.provider !== 'string' || agent.model.provider === '') {
    return 'choose a provider (or switch this agent to a command-line engine).';
  }
  if (typeof agent.model.model !== 'string' || agent.model.model === '') {
    return 'choose a model (or switch this agent to a command-line engine).';
  }
  return null;
}

/** Fill in ids, roles, and defaults the browser may have omitted. */
function normalizeRunRequest(body: RunRequest, settings: DashboardSettings): RunRequest {
  const main = {
    ...body.main,
    id: body.main.id?.trim() || 'main',
    name: body.main.name?.trim() || 'Main',
    role: 'main' as const,
    enabled: true,
  };
  const subs = (body.subs ?? []).map((sub, index) => ({
    ...sub,
    id: sub.id?.trim() || `sub-${index + 1}`,
    name: sub.name?.trim() || `Sub ${index + 1}`,
    role: 'sub' as const,
    enabled: sub.enabled !== false,
  }));
  return {
    ...body,
    mode: body.mode === 'native' ? 'native' : 'pipeline',
    task: body.task.trim(),
    main,
    subs,
    cwd: body.cwd?.trim() || settings.dsh.runCwd,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Request body is not valid JSON.');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendMethodNotAllowed(res: ServerResponse, allowed: string[]): void {
  res.writeHead(405, { Allow: allowed.join(', '), 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Method not allowed.' }));
}

/** Serve the no-build frontend, refusing anything outside `public/`. */
function serveStatic(res: ServerResponse, pathname: string): void {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = path.resolve(publicDir);
  const target = path.resolve(root, relative);
  // A plain `startsWith(root)` would also accept a sibling directory such as
  // `/app/public-evil`, so compare the relative path instead.
  const withinRoot = path.relative(root, target);
  if (withinRoot === '' || withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) {
    if (withinRoot !== '') {
      sendJson(res, 403, { error: 'Forbidden.' });
      return;
    }
  }
  let file = target;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // Single-page fallback for extension-less navigation.
    if (path.extname(relative) === '') file = path.join(publicDir, 'index.html');
    else {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (error) {
    log.warn('static file failed', { file, error: String(error) });
    sendJson(res, 500, { error: 'Cannot read file.' });
  }
}