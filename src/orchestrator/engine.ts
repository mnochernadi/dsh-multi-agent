import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runsDir } from '../config/paths.ts';
import { buildRunPatch, writeRunPatch } from '../dsh/patch.ts';
import { startAgentRun, type AgentRunHandle, type AgentRunOutcome } from '../dsh/runner.ts';
import type { Launcher } from '../dsh/launcher.ts';
import { startCliAgentRun } from '../engines/cli.ts';
import { detectEngine } from '../engines/detect.ts';
import { DSH_ENGINE_ID } from '../engines/presets.ts';
import { findEngine, resolveEngines } from '../engines/registry.ts';
import { createLogger, type Logger } from '../util/log.ts';
import { newId } from '../util/ids.ts';
import { isSkipped, manualPlan, resolvePlan } from './plan.ts';
import {
  buildNativePrompt,
  buildPlannerPrompt,
  buildSubAgentPrompt,
  buildSynthesisPrompt,
} from './prompts.ts';
import type {
  AgentRunState,
  AgentSpec,
  AgentStreamEvent,
  DashboardEvent,
  DashboardSettings,
  PlanResult,
  RunRecord,
  RunRequest,
} from '../types.ts';

export type EventSink = (event: Omit<DashboardEvent, 'seq'>) => void;

export interface OrchestratorDeps {
  getSettings(): DashboardSettings;
  /** Resolve the launcher for the current settings; throws when none is found. */
  getLauncher(): Launcher;
  emit: EventSink;
}

const MAX_HISTORY = 60;

interface RunContext {
  record: RunRecord;
  settings: DashboardSettings;
  launcher: Launcher;
  handles: Map<string, AgentRunHandle>;
  aborted: boolean;
  logger: Logger;
}

/**
 * Drives multi-agent work on top of real `dsh` processes.
 *
 * Two modes:
 *  - `pipeline` — the dashboard owns the orchestration: the main agent plans,
 *    each sub-agent runs as its own `dsh` process with its own model, then the
 *    main agent synthesises. Per-agent model choice is exact.
 *  - `native` — one `dsh` process whose agent delegates through DSH's own
 *    sub-agent tools. Children share the root model, but the orchestration
 *    decisions are the model's.
 */
export class Orchestrator {
  private readonly runs = new Map<string, RunRecord>();
  private readonly contexts = new Map<string, RunContext>();
  private readonly logger = createLogger('orchestrator');
  private readonly deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /* ------------------------------------------------------------- public API */

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** Create a run record and start executing it in the background. */
  start(request: RunRequest): RunRecord {
    const settings = this.deps.getSettings();
    const launcher = this.deps.getLauncher();
    const record = this.createRecord(request, settings);
    const context: RunContext = {
      record,
      settings,
      launcher,
      handles: new Map(),
      aborted: false,
      logger: this.logger.child(record.id),
    };
    this.runs.set(record.id, record);
    this.contexts.set(record.id, context);
    this.persist(record);
    this.emit(record.id, 'run_created', { mode: record.mode, agents: record.agents.length });

    void this.execute(context).catch((error: unknown) => {
      record.status = 'failed';
      record.error = String(error);
      record.finishedAt = Date.now();
      this.emit(record.id, 'error', { message: String(error) });
      this.emit(record.id, 'run_finished', { status: record.status });
      this.persist(record);
    });

    return record;
  }

  /** Abort every live agent of a run and stop scheduling new ones. */
  abort(runId: string): boolean {
    const context = this.contexts.get(runId);
    if (!context) return false;
    context.aborted = true;
    for (const handle of context.handles.values()) handle.abort();
    this.logger.info(`run ${runId} aborted by operator`);
    return true;
  }

  /** Load persisted runs from previous sessions (history only; not resumable). */
  loadHistory(): void {
    let files: string[] = [];
    try {
      files = readdirSync(runsDir).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    for (const file of files.slice(-MAX_HISTORY)) {
      try {
        const record = JSON.parse(readFileSync(path.join(runsDir, file), 'utf8')) as RunRecord;
        if (record && typeof record.id === 'string') this.runs.set(record.id, record);
      } catch {
        /* ignore unreadable history */
      }
    }
  }

  /* -------------------------------------------------------------- internals */

  private createRecord(request: RunRequest, settings: DashboardSettings): RunRecord {
    const now = Date.now();
    const mode = request.mode === 'native' ? 'native' : 'pipeline';
    const main = request.main;
    const subs = (request.subs ?? []).filter((sub) => sub.enabled !== false);

    const agents: AgentRunState[] = [];
    if (mode === 'pipeline') {
      agents.push(makeAgentState(main, 'plan', 'Planning the work'));
      for (const sub of subs) agents.push(makeAgentState(sub, 'work', sub.name));
      agents.push(makeAgentState(main, 'synthesis', 'Synthesising the result'));
    } else {
      agents.push(makeAgentState(main, 'native', request.task));
      for (const sub of subs) {
        agents.push({
          ...makeAgentState(sub, 'native-helper', sub.name),
          status: 'skipped',
          output: 'In native mode, helpers are created by the lead agent itself.',
        });
      }
    }

    return {
      id: newId('run'),
      status: 'queued',
      mode,
      task: request.task,
      cwd: request.cwd?.trim() ? path.resolve(request.cwd.trim()) : settings.dsh.runCwd,
      createdAt: now,
      agents,
      options: {
        concurrency: Math.max(1, Math.min(request.concurrency ?? settings.runs.maxConcurrency, 32)),
        timeoutMs: request.timeoutMs ?? settings.runs.timeoutMs,
        planning: request.planning === 'manual' ? 'manual' : 'auto',
        includeDependencyOutput: request.includeDependencyOutput !== false,
        ...(request.synthesisInstructions ? { synthesisInstructions: request.synthesisInstructions } : {}),
      },
    };
  }

  private async execute(context: RunContext): Promise<void> {
    const { record } = context;
    record.status = 'running';
    record.startedAt = Date.now();
    try {
      mkdirSync(record.cwd, { recursive: true });
    } catch (error) {
      this.logger.warn(`cannot create run cwd ${record.cwd}`, { error: String(error) });
    }
    this.emit(record.id, 'run_started', { task: record.task, cwd: record.cwd, mode: record.mode });
    this.persist(record);

    if (record.mode === 'native') await this.executeNative(context);
    else await this.executePipeline(context);

    record.finishedAt = Date.now();
    const finalAgent = finalAgentState(record);
    if (context.aborted) record.status = 'aborted';
    else if (record.error) record.status = 'failed';
    else if (!finalAgent || finalAgent.status !== 'succeeded') {
      record.status = 'failed';
      record.error =
        record.error ??
        finalAgent?.error ??
        (finalAgent?.status === 'skipped'
          ? 'No agent produced a final answer.'
          : 'The run did not produce a final answer.');
    } else {
      record.status = 'succeeded';
    }
    this.emit(record.id, 'run_finished', {
      status: record.status,
      result: record.result ?? '',
      error: record.error ?? null,
      durationMs: (record.finishedAt ?? Date.now()) - (record.startedAt ?? record.createdAt),
    });
    this.persist(record);
    this.contexts.delete(record.id);
    this.pruneHistory();
  }

  /* ------------------------------------------------------------ pipeline mode */

  private async executePipeline(context: RunContext): Promise<void> {
    const { record, settings } = context;
    const mainState = record.agents.find((agent) => agent.stage === 'plan')!;
    const subs = record.agents.filter((agent) => agent.stage === 'work');

    const subSpecs = subs.map((state) => ({
      id: state.id,
      name: state.name,
      role: 'sub' as const,
      model: state.model,
      instructions: originalInstructions(record, state.id),
    }));

    /* 1. plan */
    let plan: PlanResult;
    if (record.options.planning === 'manual' || subSpecs.length === 0) {
      plan = manualPlan(subSpecs);
      // The lead is never asked to plan here, so the stage must not sit in the
      // timeline pretending it is still pending.
      mainState.status = 'skipped';
      mainState.output =
        subSpecs.length === 0
          ? 'No sub-agents are configured, so there was nothing to plan.'
          : 'Manual planning: each agent ran from its own brief.';
      mainState.finishedAt = Date.now();
      this.emit(record.id, 'agent_finished', { agentId: mainState.id, status: 'skipped' });
    } else {
      const outcome = await this.runAgent(context, mainState, {
        stage: 'plan',
        prompt: buildPlannerPrompt({ task: record.task, subs: subSpecs, cwd: record.cwd }),
      });
      if (context.aborted) return;
      if (outcome?.ok) {
        plan = resolvePlan({ raw: outcome.finalText, subs: subSpecs });
        if (plan.tasks.filter((task) => !isSkipped(task)).length === 0) {
          const fallback = manualPlan(subSpecs);
          plan = {
            source: 'manual',
            tasks: fallback.tasks,
            raw: plan.raw,
            warnings: [...(plan.warnings ?? []), 'The plan was unusable; falling back to each agent\'s own brief.'],
          };
        }
      } else {
        plan = {
          ...manualPlan(subSpecs),
          warnings: [`Planning failed (${outcome?.error ?? 'unknown error'}); using each agent's own brief.`],
        };
      }
    }

    record.plan = plan;
    this.emit(record.id, 'plan_ready', {
      source: plan.source,
      warnings: plan.warnings ?? [],
      tasks: plan.tasks,
    });
    this.persist(record);

    /* 2. sub-agents, honouring dependencies within a concurrency bound */
    const outputs = new Map<string, { name: string; task: string; output: string; error?: string }>();
    const pending = new Map(subs.map((state) => [state.id, state]));
    const planByAgent = new Map(plan.tasks.map((task) => [task.agentId ?? task.id, task]));

    while (pending.size > 0 && !context.aborted) {
      const ready: AgentRunState[] = [];
      for (const [id, state] of pending) {
        if (isSkipped(planByAgent.get(id) ?? { id, title: '', instructions: '' })) {
          state.status = 'skipped';
          state.output = 'The planner decided this agent was not needed.';
          state.finishedAt = Date.now();
          pending.delete(id);
          this.emit(record.id, 'agent_finished', { agentId: id, status: 'skipped' });
        }
      }
      if (pending.size === 0) break;

      const settled = new Set(outputs.keys());
      for (const [id, state] of pending) {
        const dependencies = state.dependsOn ?? [];
        if (dependencies.every((dependency) => settled.has(dependency))) ready.push(state);
      }

      if (ready.length === 0) {
        for (const [id, state] of pending) {
          state.status = 'skipped';
          state.error = 'Unresolved dependency; the agent never became runnable.';
          state.output = state.output || '(skipped)';
          state.finishedAt = Date.now();
          this.emit(record.id, 'agent_finished', { agentId: id, status: 'skipped', error: state.error });
        }
        pending.clear();
        break;
      }

      await runPool(ready, record.options.concurrency, async (state) => {
        if (context.aborted) return;
        const planTask = planByAgent.get(state.id) ?? {
          id: state.id,
          title: state.name,
          instructions: state.instructions ?? '',
          agentId: state.id,
        };
        try {
          const dependencyOutputs = (state.dependsOn ?? [])
            .map((dependency) => outputs.get(dependency))
            .filter((value): value is { name: string; task: string; output: string } => Boolean(value));
          const prompt = buildSubAgentPrompt({
            task: record.task,
            agent: {
              id: state.id,
              name: state.name,
              role: 'sub',
              model: state.model,
              ...(state.instructions ? { instructions: state.instructions } : {}),
            },
            planTask,
            dependencyOutputs,
            includeDependencyOutput: record.options.includeDependencyOutput,
          });
          const outcome = await this.runAgent(context, state, { stage: 'work', prompt });
          outputs.set(state.id, {
            name: state.name,
            task: planTask.title,
            output: outcome?.finalText ?? '',
            ...(outcome && !outcome.ok ? { error: outcome.error ?? 'failed' } : {}),
          });
        } catch (error) {
          state.status = 'failed';
          state.error = `The agent could not be started: ${String(error)}`;
          state.finishedAt = Date.now();
          this.emit(record.id, 'agent_finished', {
            agentId: state.id,
            status: 'failed',
            error: state.error,
          });
          outputs.set(state.id, { name: state.name, task: planTask.title, output: '', error: state.error });
        } finally {
          // Always release the slot, even when the agent threw.
          pending.delete(state.id);
        }
      });
    }

    if (context.aborted) return;

    /* 3. synthesis */
    const synthesisState = record.agents.find((agent) => agent.stage === 'synthesis')!;
    const reports = [...outputs.values()];
    const synthesisPrompt = buildSynthesisPrompt({
      task: record.task,
      plan,
      results: reports,
      instructions: record.options.synthesisInstructions,
      cwd: record.cwd,
    });

    const mainSession = mainState.sessionId;
    let outcome = mainSession
      ? await this.runAgent(context, synthesisState, {
          stage: 'synthesis',
          prompt: synthesisPrompt,
          continueSession: mainSession,
        })
      : null;

    if (outcome && !outcome.ok && mainSession && looksLikeSessionRejection(outcome)) {
      this.logger.warn('session adoption failed; retrying synthesis in a fresh session', {
        runId: record.id,
        error: outcome.error,
      });
      this.emit(record.id, 'log', {
        message: 'The lead agent could not resume its planning session; synthesising in a fresh session.',
      });
      resetAgentState(synthesisState);
      outcome = await this.runAgent(context, synthesisState, { stage: 'synthesis', prompt: synthesisPrompt });
    } else if (!outcome) {
      outcome = await this.runAgent(context, synthesisState, { stage: 'synthesis', prompt: synthesisPrompt });
    }

    record.result = synthesisState.output;
    if (!outcome?.ok && !record.error) record.error = outcome?.error ?? 'Synthesis failed.';
  }

  /* -------------------------------------------------------------- native mode */

  private async executeNative(context: RunContext): Promise<void> {
    const { record } = context;
    const mainState = record.agents.find((agent) => agent.stage === 'native')!;
    const helpers = record.agents.filter((agent) => agent.stage === 'native-helper');
    const prompt = buildNativePrompt({
      task: record.task,
      subs: helpers.map((state) => ({
        id: state.id,
        name: state.name,
        role: 'sub',
        model: state.model,
        instructions: originalInstructions(record, state.id),
      })),
      cwd: record.cwd,
    });
    const outcome = await this.runAgent(context, mainState, { stage: 'native', prompt });
    record.result = mainState.output;
    if (!outcome?.ok && !record.error) record.error = outcome?.error ?? 'The run failed.';
  }

  /* ------------------------------------------------------------------ one agent */

  private async runAgent(
    context: RunContext,
    state: AgentRunState,
    options: { stage: string; prompt: string; continueSession?: string },
  ): Promise<AgentRunOutcome | null> {
    if (context.aborted) {
      state.status = 'aborted';
      return null;
    }
const { record, settings, launcher } = context;
    state.status = 'running';
    state.startedAt = Date.now();
    state.task = options.prompt;

    /* Which engine runs this agent? `dsh` unless the operator chose another. */
    const engines = resolveEngines(settings.engines);
    const requested = state.engine ?? DSH_ENGINE_ID;
    const engine = findEngine(engines, requested) ?? findEngine(engines, DSH_ENGINE_ID);
    if (!engine) {
      return this.failAgent(context, state, `Engine "${requested}" is not defined in settings.`);
    }
    if (!engine.enabled) {
      return this.failAgent(context, state, `Engine "${engine.label}" is disabled in settings.`);
    }
    if (engine.kind === 'ide') {
      return this.failAgent(
        context,
        state,
        `${engine.label} is an IDE, not a headless agent. Detect it for the workspace handoff, or pick a command-line engine for this agent.`,
      );
    }
    state.engine = engine.id;

    let handle: AgentRunHandle;

    if (engine.kind === 'dsh') {
      const built = buildRunPatch({
        model: state.model,
        catalogue: settings.providers,
        trustStoredCredentials: settings.dsh.trustStoredCredentials,
        ...(state.personaPrefix ? { personaPrefix: state.personaPrefix } : {}),
      });
      if (built.warnings.length > 0) {
        this.emit(record.id, 'log', { agentId: state.id, message: built.warnings.join(' ') });
      }
      if (built.problems.length > 0) {
        return this.failAgent(context, state, built.problems.join(' '));
      }

      const patchPath = writeRunPatch(record.id, `${state.id}.${options.stage}`, built.yaml);
      state.patchPath = patchPath;
      state.model = built.resolved;
      this.emit(record.id, 'agent_started', {
        agentId: state.id,
        name: state.name,
        stage: options.stage,
        engine: engine.id,
        engineLabel: engine.label,
        model: state.model,
        patchPath,
      });
      this.persist(record);

      handle = startAgentRun({
        launcher,
        patchPath,
        task: options.prompt,
        cwd: record.cwd,
        timeoutMs: record.options.timeoutMs,
        profile: settings.dsh.profile,
        ...(options.continueSession ? { extraArgs: ['--session-id', options.continueSession] } : {}),
        onEvent: (event) => {
          applyStreamEvent(state, event);
          this.emit(record.id, 'agent_event', { agentId: state.id, stage: options.stage, event });
        },
        onStderr: (chunk) => {
          this.emit(record.id, 'agent_stderr', { agentId: state.id, chunk });
        },
        onDiagnostic: (line) => {
          this.emit(record.id, 'log', { agentId: state.id, message: line });
        },
      });
    } else {
      const detection = await detectEngine(engine, { dshBin: settings.dsh.bin });
      if (!detection.executablePath || !detection.launch) {
        return this.failAgent(context, state, detection.message);
      }
      this.emit(record.id, 'agent_started', {
        agentId: state.id,
        name: state.name,
        stage: options.stage,
        engine: engine.id,
        engineLabel: engine.label,
        cliModel: state.cliModel ?? '',
        executablePath: detection.executablePath,
        version: detection.version,
      });
      this.persist(record);

      handle = startCliAgentRun({
        engine,
        detection,
        prompt: options.prompt,
        model: state.cliModel ?? '',
        cwd: record.cwd,
        timeoutMs: record.options.timeoutMs,
        ...(options.continueSession ? { sessionId: options.continueSession } : {}),
        onEvent: (event) => {
          applyStreamEvent(state, event);
          this.emit(record.id, 'agent_event', { agentId: state.id, stage: options.stage, event });
        },
        onStderr: (chunk) => {
          this.emit(record.id, 'agent_stderr', { agentId: state.id, chunk });
        },
        onDiagnostic: (line) => {
          this.emit(record.id, 'log', { agentId: state.id, message: line });
        },
      });
    }

    context.handles.set(`${state.id}:${options.stage}`, handle);

    const outcome = await handle.done;
    context.handles.delete(`${state.id}:${options.stage}`);

    state.finishedAt = Date.now();
    state.durationMs = outcome.durationMs;
    state.exitCode = outcome.exitCode;
    state.output = outcome.finalText;
    state.messages = outcome.messages;
    state.thinking = outcome.thinking;
    state.sessionId = outcome.sessionId ?? state.sessionId;
    state.usage = outcome.usage;
    if (outcome.stderr !== '') state.stderr = outcome.stderr;
    if (outcome.ok) state.status = 'succeeded';
    else if (outcome.aborted) state.status = 'aborted';
    else {
      state.status = 'failed';
      state.error = outcome.error ?? 'The agent failed.';
    }

    this.emit(record.id, 'agent_finished', {
      agentId: state.id,
      status: state.status,
      error: state.error ?? null,
      durationMs: state.durationMs,
      sessionId: state.sessionId ?? null,
      usage: state.usage,
    });
    this.persist(record);
    return outcome;
  }

  /* ------------------------------------------------------------------ helpers */

  /**
   * Record an agent that could not start at all — an unconfigured model, a
   * missing engine, a disabled one — without spawning anything.
   */
  private failAgent(context: RunContext, state: AgentRunState, message: string): AgentRunOutcome {
    state.status = 'failed';
    state.error = message;
    state.finishedAt = Date.now();
    this.emit(context.record.id, 'agent_finished', {
      agentId: state.id,
      status: 'failed',
      error: message,
    });
    this.logger.warn(`agent ${state.id} could not start`, { runId: context.record.id, message });
    this.persist(context.record);
    return {
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
    };
  }

  private emit(runId: string, type: DashboardEvent['type'], data: Record<string, unknown>): void {
    this.deps.emit({ runId, type, ts: Date.now(), data });
  }

  private persist(record: RunRecord): void {
    try {
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(path.join(runsDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.logger.warn('cannot persist run record', { runId: record.id, error: String(error) });
    }
  }

  private pruneHistory(): void {
    const extra = this.listRuns().slice(MAX_HISTORY);
    for (const record of extra) this.runs.delete(record.id);
  }
}

/* --------------------------------------------------------------- free helpers */

function makeAgentState(spec: AgentSpec, stage: string, task: string): AgentRunState {
  return {
    id: spec.id,
    name: spec.name,
    role: stage === 'work' ? 'sub' : 'main',
    stage,
    ...(spec.engine !== undefined ? { engine: spec.engine } : {}),
    ...(spec.cliModel !== undefined ? { cliModel: spec.cliModel } : {}),
    model: spec.model,
    status: 'pending',
    task,
    messages: [],
    thinking: [],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    output: '',
    ...(spec.instructions !== undefined ? { instructions: spec.instructions } : {}),
    ...(spec.personaPrefix !== undefined ? { personaPrefix: spec.personaPrefix } : {}),
    ...(spec.dependsOn !== undefined ? { dependsOn: spec.dependsOn } : {}),
  };
}

function resetAgentState(state: AgentRunState): void {
  state.status = 'pending';
  state.messages = [];
  state.thinking = [];
  state.toolCalls = [];
  state.output = '';
  state.stderr = undefined;
  state.error = undefined;
  state.sessionId = undefined;
  state.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function originalInstructions(record: RunRecord, agentId: string): string | undefined {
  return record.agents.find((agent) => agent.id === agentId)?.instructions;
}

/** The agent whose output is the run's answer: synthesis, or the native lead. */
function finalAgentState(record: RunRecord): AgentRunState | undefined {
  return (
    record.agents.find((agent) => agent.stage === 'synthesis') ??
    record.agents.find((agent) => agent.stage === 'native')
  );
}

/** Apply one projected agent event to an agent's live state. */
function applyStreamEvent(state: AgentRunState, event: AgentStreamEvent): void {
  switch (event.type) {
    case 'session':
      if (typeof event.sessionId === 'string') state.sessionId = event.sessionId;
      break;
    case 'text':
      if (typeof event.text === 'string' && event.text.trim() !== '') state.messages.push(event.text);
      break;
    case 'thinking':
      if (typeof event.text === 'string' && event.text.trim() !== '') state.thinking.push(event.text);
      break;
    case 'tool_call': {
      const callId = String(event.callId ?? '');
      if (callId === '') break;
      if (!state.toolCalls.some((call) => call.callId === callId)) {
        state.toolCalls.push({
          callId,
          tool: String(event.tool ?? 'tool'),
          input: event.input,
          status: 'running',
        });
      }
      break;
    }
    case 'tool_result': {
      const callId = String(event.callId ?? '');
      const call = state.toolCalls.find((entry) => entry.callId === callId);
      if (call) {
        call.status = event.status === 'error' ? 'error' : 'completed';
        if (typeof event.result === 'string') call.result = event.result;
      }
      break;
    }
    case 'status':
      if (event.phase === 'step_end' && event.usage) {
        state.usage.inputTokens += Number(event.usage.inputTokens) || 0;
        state.usage.outputTokens += Number(event.usage.outputTokens) || 0;
        state.usage.totalTokens += Number(event.usage.totalTokens) || 0;
      }
      break;
    default:
      break;
  }
}

/** A DSH session-adoption refusal is worth one retry in a fresh session. */
function looksLikeSessionRejection(outcome: AgentRunOutcome): boolean {
  const haystack = `${outcome.error ?? ''}\n${outcome.stderr}`.toLowerCase();
  return (
    haystack.includes('session') &&
    (haystack.includes('no stored') ||
      haystack.includes('unknown') ||
      haystack.includes('adopt') ||
      haystack.includes('refus') ||
      haystack.includes('working directory') ||
      haystack.includes('preset'))
  );
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await worker(item);
      } catch (error) {
        // A failing worker must not stall the pool.
        // The agent state already carries the error when this happens.
        void error;
      }
    }
  });
  await Promise.all(runners);
}
