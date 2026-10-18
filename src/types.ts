/** Shared domain types for the dashboard, the DSH bridge, and the browser UI. */

/* ------------------------------------------------------- provider catalogue */

/**
 * One model exactly as DSH declares it (`llm-pi-ai` provider config). Unknown
 * fields are preserved verbatim so a run patch is a faithful copy of the
 * catalogue the Harness app already uses — including `reasoningEfforts`,
 * `contextWindow`, and `input`.
 */
export interface ModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  input?: string[];
  reasoningEfforts?: Record<string, string | null>;
  [key: string]: unknown;
}

export interface ProviderSpec {
  displayName?: string;
  apiKeyEnv?: string;
  api?: string;
  baseURL?: string;
  models: ModelSpec[];
  [key: string]: unknown;
}

export type ProviderCatalogue = Record<string, ProviderSpec>;

/* ------------------------------------------------------------ agent config */

export type ReasoningEffort = string | null;

/** A provider/model/effort triple — the unit of per-agent model selection. */
export interface ModelChoice {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export type AgentRole = 'main' | 'sub';

export interface AgentSpec {
  id: string;
  name: string;
  role: AgentRole;
  model: ModelChoice;
  /** Role text injected into the prompt for this agent. */
  instructions?: string;
  /** Optional `system-prompt.personaPrefix` override for this agent's run. */
  personaPrefix?: string;
  /** Sub-agents only: ids that must finish before this agent starts. */
  dependsOn?: string[];
  enabled?: boolean;
}

export type RunMode = 'pipeline' | 'native';

export interface RunRequest {
  mode: RunMode;
  task: string;
  /** Working directory for every agent in this run. */
  cwd?: string;
  /** `auto`: the main agent plans and assigns sub-tasks. `manual`: use `AgentSpec.instructions` as-is. */
  planning?: 'auto' | 'manual';
  main: AgentSpec;
  subs: AgentSpec[];
  /** Max agents running at once (pipeline mode). */
  concurrency?: number;
  /** Per-agent wall-clock timeout in milliseconds; 0 disables it. */
  timeoutMs?: number;
  /** Feed each sub-agent the outputs of the agents it depends on. */
  includeDependencyOutput?: boolean;
  /** Extra instructions appended to the synthesis prompt. */
  synthesisInstructions?: string;
}

/* -------------------------------------------------------------- run state */

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted';
export type AgentStatus = 'pending' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'aborted';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ToolCallView {
  callId: string;
  tool: string;
  input: unknown;
  status: 'running' | 'completed' | 'error';
  result?: string;
}

export interface AgentRunState {
  id: string;
  name: string;
  role: AgentRole;
  stage: string;
  model: ModelChoice;
  status: AgentStatus;
  task: string;
  /** The operator's original brief for this agent, kept across stages. */
  instructions?: string;
  /** Optional `system-prompt.personaPrefix` override used for this agent's run. */
  personaPrefix?: string;
  dependsOn?: string[];
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  sessionId?: string;
  /** Committed assistant text blocks, in order. */
  messages: string[];
  /** Committed reasoning blocks, in order. */
  thinking: string[];
  toolCalls: ToolCallView[];
  usage: UsageTotals;
  output: string;
  /** Raw stderr from the run, capped; carries provider diagnostics. */
  stderr?: string;
  error?: string;
  exitCode?: number | null;
  /** Path of the generated run patch, kept for debugging. */
  patchPath?: string;
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  mode: RunMode;
  task: string;
  cwd: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  agents: AgentRunState[];
  plan?: PlanResult;
  result?: string;
  error?: string;
  options: {
    concurrency: number;
    timeoutMs: number;
    planning: 'auto' | 'manual';
    includeDependencyOutput: boolean;
    synthesisInstructions?: string;
  };
}

export interface PlanTask {
  id: string;
  title: string;
  instructions: string;
  agentId?: string;
  /** The planner decided this member is not needed for the goal. */
  skipped?: boolean;
}

export interface PlanResult {
  source: 'main-agent' | 'manual';
  tasks: PlanTask[];
  raw?: string;
  warnings?: string[];
}

/* --------------------------------------------------------------- dsh events */

export interface DshSessionEvent {
  type: 'session';
  sessionId: string;
  cwd?: string;
}

export interface DshStatusEvent {
  type: 'status';
  phase: 'turn_start' | 'step_start' | 'step_end' | 'turn_end' | string;
  turn?: number;
  step?: number;
  usage?: UsageTotals;
  reason?: { kind?: string; error?: { message?: string; code?: string } } | string | null;
}

export interface DshTextEvent {
  type: 'text';
  text: string;
}

export interface DshThinkingEvent {
  type: 'thinking';
  text: string;
}

export interface DshToolCallEvent {
  type: 'tool_call';
  callId: string;
  tool: string;
  input?: unknown;
}

export interface DshToolResultEvent {
  type: 'tool_result';
  callId: string;
  status?: 'completed' | 'error' | string;
  result?: string;
}

export interface DshFinalEvent {
  type: 'final';
  text: string;
}

export interface DshErrorEvent {
  type: 'error';
  message: string;
  code?: string;
}

export type DshStreamEvent =
  | DshSessionEvent
  | DshStatusEvent
  | DshTextEvent
  | DshThinkingEvent
  | DshToolCallEvent
  | DshToolResultEvent
  | DshFinalEvent
  | DshErrorEvent;

/* ------------------------------------------------- dashboard event stream */

export type DashboardEventType =
  | 'run_created'
  | 'run_started'
  | 'run_finished'
  | 'plan_ready'
  | 'agent_created'
  | 'agent_started'
  | 'agent_status'
  | 'agent_event'
  | 'agent_stderr'
  | 'agent_finished'
  | 'log'
  | 'error';

export interface DashboardEvent {
  /** Monotonic sequence number, used by the browser for gap detection. */
  seq: number;
  runId: string;
  agentId?: string;
  stage?: string;
  type: DashboardEventType;
  ts: number;
  data: Record<string, unknown>;
}

/* ------------------------------------------------------------- settings */

export interface DashboardSettings {
  version: number;
  dsh: {
    bin: string;
    home: string;
    profile: string;
    runCwd: string;
    trustStoredCredentials: boolean;
  };
  server: {
    host: string;
    port: number;
  };
  runs: {
    maxConcurrency: number;
    timeoutMs: number;
  };
  ui: {
    language: 'fa' | 'en';
    direction: 'rtl' | 'ltr';
  };
  providers: ProviderCatalogue;
  /** Last used agent roster, restored in the UI. */
  roster: {
    main: AgentSpec;
    subs: AgentSpec[];
  };
}

export interface DshInfo {
  launcherFound: boolean;
  launcherPath: string | null;
  launchKind: string | null;
  source: string | null;
  version: string | null;
  error: string | null;
  dshHome: string;
  profiles: string[];
  candidatesTried: string[];
}