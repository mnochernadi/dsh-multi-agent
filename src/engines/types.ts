/**
 * Engine layer: an *engine* is a program that can run one agent.
 *
 * DeepSeek Harness is the built-in engine, but the dashboard is not tied to it:
 * any headless agent CLI (Claude Code, Gemini CLI, Codex, Aider, …) can be
 * declared here, detected on the machine, and selected per agent. Engines that
 * are installed but not usable (missing sign-in, wrong flags) report that state
 * instead of failing mid-run.
 */
import type { AgentStreamEvent, UsageTotals } from '../types.ts';

export type EngineKind = 'dsh' | 'cli' | 'ide';

/** How an engine's stdout is turned into the dashboard's event vocabulary. */
export type OutputFormat =
  | 'dsh-json'
  | 'claude-stream-json'
  | 'gemini-stream-json'
  | 'json-lines'
  | 'text';

export interface EngineModel {
  id: string;
  name?: string;
  description?: string;
}

export interface EngineDetectSpec {
  /** Executable names to look for on PATH, without extension. */
  commands: string[];
  /**
   * Extra absolute search patterns, evaluated after expanding `%VAR%` / `$VAR`
   * and a leading `~`. `*` matches one path segment — this is how versioned
   * install layouts such as Claude Code's are found.
   */
  searchGlobs?: string[];
  /** Arguments that print a version, e.g. `['--version']`. */
  versionArgs?: string[];
  /** Optional regex with one capture group; the first line is matched. */
  versionRegex?: string;
  /**
   * Pin the exact program to use, bypassing PATH and the search patterns.
   * Useful when several installs exist or the wrapper cannot be read.
   */
  executablePath?: string;
}

export interface EngineRunSpec {
  /**
   * Argument template. Placeholders: `{prompt}`, `{model}`, `{cwd}`,
   * `{sessionId}` and `{extra}`. Unknown placeholders are left untouched so a
   * user editing the template sees their own typos.
   */
  argsTemplate: string[];
  /** How this engine's stdout is decoded into dashboard events. */
  outputFormat: OutputFormat;
  /** Output format used by the health check, when it differs from a run. */
  healthOutputFormat?: OutputFormat;
  /** Arguments appended for every run (editable in the UI). */
  extraArgs?: string[];
  /**
   * Write the prompt to stdin. When false the template must place `{prompt}`
   * itself; when true `{prompt}` is removed from the rendered arguments.
   */
  promptViaStdin: boolean;
  /** Environment variables copied from the dashboard process into the run. */
  envPassthrough?: string[];
  /** Extra environment values. */
  env?: Record<string, string>;
  /** Models offered by the picker; users may also type any other id. */
  models?: EngineModel[];
  /**
   * A cheap no-tool invocation used by the "test" action to prove the engine is
   * really usable (installed, authenticated, and able to answer).
   */
  healthArgsTemplate?: string[];
  healthPrompt?: string;
  /** How long a health check may take, in milliseconds. */
  healthTimeoutMs?: number;
}

export interface EngineDefinition {
  id: string;
  label: string;
  kind: EngineKind;
  builtin: boolean;
  enabled: boolean;
  /** One-line explanation shown in the UI. */
  description?: string;
  /** Where to learn more, shown in the UI. */
  homepage?: string;
  detect: EngineDetectSpec;
  run: EngineRunSpec;
  /** IDE engines cannot run a headless agent; they hand off a workspace instead. */
  handoff?: {
    /** Opens a directory in the IDE; `{cwd}` is substituted. */
    argsTemplate: string[];
  };
}

export type EngineAvailability = 'ready' | 'installed' | 'missing' | 'disabled' | 'broken';

export interface EngineDetection {
  engineId: string;
  availability: EngineAvailability;
  /** Resolved executable, when one was found. */
  executablePath: string | null;
  /** How the executable must be launched (may differ from `executablePath`). */
  launch?: EngineLaunch;
  version: string | null;
  /** Human-readable explanation for the current state. */
  message: string;
  /** Candidates that were tried, for troubleshooting. */
  candidatesTried: string[];
  checkedAt: number;
}

/**
 * A concrete command line. A wrapper such as `claude.cmd` may resolve to
 * `node <script>` or to a bundled native binary, so the launcher is separated
 * from the file the user recognizes.
 */
export interface EngineLaunch {
  command: string;
  argsPrefix: string[];
  env: Record<string, string>;
  /** Spawn through a shell (last resort for wrappers that cannot be parsed). */
  shell: boolean;
  /** The file a user would run by hand. */
  scriptPath: string | null;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  shell: boolean;
  /** Prompt text written to stdin, or null when the prompt travels in `args`. */
  stdin: string | null;
  /** Working directory for the process. */
  cwd: string;
}

export interface EngineHealthResult {
  ok: boolean;
  /** Short human-readable outcome, e.g. a sign-in error from the CLI. */
  message: string;
  durationMs: number;
  /** Engine output, when the check produced any. */
  output?: string;
}

/** A parsed stream line plus the raw text it came from. */
export interface ParsedLine {
  /** The primary event for this line, when there is one. */
  event: AgentStreamEvent | null;
  /**
   * Every event the line produced. One engine line can carry several content
   * blocks — Claude Code routinely puts text *and* a tool call in a single
   * assistant message — and dropping the extras would hide real work.
   */
  events?: AgentStreamEvent[];
  /** Text that could not be parsed but is still worth showing. */
  raw?: string;
}

export interface ParserState {
  /** Committed assistant text blocks, used to synthesise a final answer. */
  messages: string[];
  thinking: string[];
  sessionId: string | null;
  finalText: string;
  usage: UsageTotals;
  error: string | null;
  /** True when the engine reported a failed run inside the stream. */
  failed: boolean;
}

export function emptyParserState(): ParserState {
  return {
    messages: [],
    thinking: [],
    sessionId: null,
    finalText: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    error: null,
    failed: false,
  };
}