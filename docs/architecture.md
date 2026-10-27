# Technical Architecture

This document describes the design decisions, process lifecycle, and integration points between `dsh-multi-agent` and the agent programs it drives.

---

## 0. The engine layer

The dashboard is built around one abstraction: an **engine** is any program that can run a single agent to completion. DeepSeek Harness is the built-in engine, not a special case.

```
orchestrator/engine.ts
   └── resolves AgentSpec.engine → EngineDefinition (engines/registry.ts)
          ├── kind 'dsh'  → dsh/patch.ts (Cordis overlay) + dsh/runner.ts
          ├── kind 'cli'  → engines/cli.ts  (template → spawn → parse)
          └── kind 'ide'  → refused for agent runs; engines/detect.ts handoff only
```

Everything downstream — the run record, the SSE timeline, the browser — consumes one normalized event vocabulary (`AgentStreamEvent`), so a sub-agent that ran as Claude Code is indistinguishable from one that ran as DSH except for the label it reports.

### Why a descriptor, not a plugin class per CLI

An `EngineDefinition` is data: detection commands, an argument template, an output format, and a model list. That is what makes every engine editable from the UI without shipping code, and what makes "add my own program" a form instead of a filesystem plugin.

### Output formats

| Format | Produced by | Notes |
|---|---|---|
| `dsh-json` | `dsh headless --patch <patch> --json -` | Usage arrives per committed step, so it accumulates |
| `claude-stream-json` | `claude -p --output-format stream-json --verbose`, and Tencent's `codebuddy`/WorkBuddy with the same flag | `system/init`, `assistant`, `user` (tool results), `result`; usage is session-cumulative on `result`, so per-message usage is deliberately **not** summed |
| `gemini-stream-json` | Gemini CLI and its forks | Tolerant: reads `response`/`text`/`content`/`output` |
| `json-lines` | anything else emitting JSON | Heuristic field matching; always falls back to showing raw text |
| `text` | plain-text CLIs | The whole transcript becomes the answer |

No parser throws on unknown input: an unrecognized line becomes a `raw` diagnostic, because losing a progressing run to an unexpected field is worse than showing a stray line.

### Exit and failure semantics

A run is `ok` only when the process exited 0 **and** the stream reported no failure **and** an answer exists. The engine's own error text is preferred over a generic message — Claude Code that is installed but not signed in yields `Not logged in · Please run /login` from its `result` event, which is exactly what the operator needs to read.

### Detection states

`missing` → `installed` → `ready` (alongside `disabled` and `broken`). Detection finds an executable (pinned `executablePath` first, PATH next, then machine-expanded search globs, newest version within a glob first) and probes `--version`. `ready` is claimed only after a real health check returns an answer. An engine that cannot authenticate or fails its health check is marked `broken` with the engine's error attached.

### Launch safety

Windows wrappers are read and rewritten rather than shelled out to: `util/winwrap.ts` parses a `.cmd`/`.bat` shim into its real command line (`node <script>`, or a bundled `.exe`), so prompts and paths containing spaces never have to survive shell quoting. `.ps1` runs through the PowerShell host, `.js` through `node`, and unparseable wrappers are reported `broken` so the user can pin the direct binary via `executablePath`.

---

## 1. Process Isolation Model

DeepSeek Harness profiles (such as `desktop`, `web`, `headless`, `sdk`) compose an interconnected Cordis plugin tree.
The desktop profile is exclusively managed by the Electron application and cannot be booted directly from external CLIs.

To achieve clean orchestration without interfering with the user's running GUI session, `dsh-multi-agent` launches individual agent tasks as isolated subprocesses running:

```bash
dsh headless --patch <generated-patch.yml> --json -
```

### Why headless?
- **Stateless & Bounded**: Starts, completes the task, emits NDJSON events, and exits cleanly.
- **Pure Stdio Interface**: The task prompt is piped through `stdin`, avoiding Windows shell quote-escaping hazards.
- **Machine-Readable Projection**: The `--json` flag emits structured lifecycle events:
  - `session`: Identity of the durable session and its working directory.
  - `thinking`: Committed reasoning blocks from the model.
  - `text`: Committed assistant output blocks.
  - `tool_call` & `tool_result`: Live tool execution progress.
  - `status`: Step start, step end, token usage metrics, and turn completion reasons.
  - `final`: Lossless final answer text.

---

## 2. Dynamic Cordis Patch Overlays

When a user selects a model for a specific agent (e.g. `omni/deepseek-v4.1-flash:free` with `reasoningEffort: max`), the dashboard generates a temporary Cordis patch file:

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      omni:
        displayName: omni
        apiKeyEnv: OMNI_API_KEY
        api: openai-completions
        baseURL: https://omni.example/v1
        models:
          - id: deepseek-v4.1-flash:free
            name: deepseek-v4.1-flash:free
            contextWindow: 1000000
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
              xhigh: xhigh
              max: max
- id: agent-default-model
  config:
    provider: omni
    model: deepseek-v4.1-flash:free
    reasoningEffort: max
```

### Security & Credentials
The headless profile disables the internal credential store by default. By selectively enabling `- id: credentials / disabled: false`, the child process gains access to the local OS keychain/credentials store without requiring plaintext secrets to ever cross the dashboard API boundary.

---

## 3. Orchestration Flow

### Mode A: Dashboard Pipeline
1. **Plan Stage**: The Lead agent analyzes the task and produces a structured JSON plan with discrete subtasks.
2. **Work Stage (Fan-Out)**: A concurrency-bounded pool (`runPool`) executes sub-agents. Agents with explicit `dependsOn` declarations wait until their upstream dependencies succeed, receiving upstream outputs as contextual input.
3. **Synthesis Stage**: The Lead agent resumes its earlier planning session (via `--session-id <lead-session-id>`), receives all sub-agent reports, reconciles differences, closes gaps, and produces the final answer.

### Mode B: Native DSH
The lead agent executes within a single `dsh` process, using native DSH subagent tools (`subagent`, `subagent_fork`, `list_agents`, `interrupt_agent`) to spawn children dynamically.

---

## 4. Real-time Telemetry (SSE)

Communication between the browser and dashboard server uses Server-Sent Events with:
- Monotonic sequence numbers (`seq`).
- In-memory event ring buffer for seamless reconnection replay (`Last-Event-ID`).
- Heartbeat pings every 20s to keep HTTP proxies from dropping idle channels.

---

## 5. Interface Material (Liquid Glass)

The web has no glass primitive, so the material is assembled in the order of fidelity the reference material describes:

| Layer | Implementation | What it buys |
|---|---|---|
| Backdrop field | `.ambient` orbs, `position: fixed`, 38–60s drift | Something real for the glass to bend; a flat background makes any blur read as grey plastic |
| Base lens | `backdrop-filter: blur() saturate()` on the panel shells | The frosted body of the material |
| Rim refraction | SVG `feTurbulence` + `feDisplacementMap` (`#lg-refract`) applied through `backdrop-filter: url(...)` | Straight lines running behind an edge visibly bend — the difference between Liquid Glass and 2020 glassmorphism. Guarded by `@supports`, so the fallback is just the plain high-quality blur |
| Specular highlight | `--mx`/`--my` written per frame by one delegated `pointermove` listener (`installGlassSpecular`), projected as a radial sheen in `.glass::after` | The highlight that travels across Apple's material as the device tilts |
| Grain | SVG turbulence tile, `soft-light` (dark) / `multiply` (light) | Keeps large panels from looking like flat vector fills |

Rules the implementation holds to:

- **Glass is a navigation-layer material.** It goes on chrome, controls and panel shells. Body copy sits on near-opaque inner surfaces (`.msg`, `.tool-args`, `.event-log`, `.agent-card-body`), because the documented failure mode of this material is text on glass over a busy background losing contrast.
- **Content lists get a darker floor.** `.engine`, `.provider` and `.agent-editor` keep the blur and the rim but pull the tint back: an adaptive tint over a bright orb was turning those rows near-white and taking label contrast with it.
- **Preferences are honoured, not decorated.** `prefers-reduced-transparency` drops every backdrop filter for solid surfaces, `prefers-contrast: more` raises the tint floor and hides the ambient field, `prefers-reduced-motion` stops the drift and the pulse, `forced-colors` falls back to `Canvas`/`CanvasText`, and a `@supports not (backdrop-filter)` block replaces translucency with opaque panels instead of leaving unreadable rectangles.
