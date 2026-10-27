# dsh-multi-agent 🤖⚡

> **Multi-Agent Orchestration Dashboard for DeepSeek Harness (DSH)**  
> Run coordinated teams of AI agents where each agent can use a completely different LLM provider and model, with real-time streaming telemetry and zero build steps.

[![Node.js CI](https://github.com/mnochernadi/dsh-multi-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/mnochernadi/dsh-multi-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18.0-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg)](package.json)

**[راهنمای فارسی (Persian README)](README.fa.md)**

---

## 🌟 Highlights

- **🧩 Multi-engine, not DeepSeek-only**: every agent runs on a chosen *engine* — DeepSeek Harness, Claude Code, Gemini CLI, Codex, Cursor Agent, OpenCode, Aider, Qwen Code, Goose — or any command you define yourself. Installed programs are detected automatically, and anything can be added, edited, or overridden by hand.
- **🎯 True Per-Agent Model Selection**: Assign different models to your Lead, Researcher, Critic, or Writer (e.g. DeepSeek-V3 for planning, Claude Haiku for fast drafting, GPT-4o for critical review).
- **🔌 Native DeepSeek Harness Integration**: Spawns real, isolated `dsh headless --patch <generated-patch.yml> --json -` processes using dynamic Cordis patch overlays.
- **🔐 Automatic Credential Reuse**: Safely leverages your existing DSH credentials store and `.env` chains without exposing private API keys to the browser.
- **⚡ Two Powerful Orchestration Modes**:
  - **Dashboard Pipeline**: The lead agent designs a DAG plan, sub-agents run in parallel or sequentially based on dependencies, and the lead synthesizes the final outcome.
  - **Native DSH Mode**: Runs a single agent team session where the lead uses DSH's built-in `subagent` tools dynamically.
- **📡 Real-Time SSE Event Stream**: Watch thought reasoning (`thinking`), streaming output, tool invocations, execution time, and token counts live — whichever engine produced them.
- **🩺 Honest engine status**: five states — *ready*, *installed* (found but not proven), *missing*, *disabled*, or *broken* (a wrapper that cannot be read, or a health check that failed). A CLI that is installed but not signed in reports its own words verbatim (`Not logged in · Please run /login`) instead of a generic failure.
- **🌍 Bilingual & RTL-Ready**: Seamless one-click switch between English (LTR) and Persian (RTL).
- **🧊 Liquid Glass interface**: a refractive glass material over a drifting ambient light field — rim refraction through an SVG displacement pass, a specular highlight that tracks the pointer, and honest fallbacks for reduced transparency, high contrast, reduced motion and engines without `backdrop-filter`.
- **📦 Zero Build & Zero Dependencies**: Modern Node.js native TypeScript stripping + vanilla modern Web frontend. No Vite/Webpack build steps required.

---

## 🧩 Engines

An **engine** is any program that can run one agent to completion. The dashboard normalizes every engine's output into one event vocabulary, so the pipeline, the timeline, and per-agent choices behave identically no matter what produced the events.

| Engine | Kind | Headless interface | Status |
|---|---|---|---|
| `dsh` | DeepSeek Harness | `dsh headless --patch <generated-patch.yml> --json -` + generated Cordis patch | Verified |
| `claude-code` | CLI | `claude -p --output-format stream-json --verbose`, prompt on stdin | Verified against Claude Code 2.1.299 |
| `gemini-cli` | CLI | `gemini -p … --output-format stream-json` | Flags follow the docs; confirm with **Test** |
| `codex-cli` | CLI | `codex exec --json …` | Flags follow the docs; confirm with **Test** |
| `cursor-agent` | CLI | `cursor-agent -p …` | Flags follow the docs; confirm with **Test** |
| `opencode` | CLI | `opencode run …` | Flags follow the docs; confirm with **Test** |
| `aider` | CLI | `aider --message … --yes` | Flags follow the docs; confirm with **Test** |
| `qwen-code` | CLI | `qwen -p … --output-format json` | Flags follow the docs; confirm with **Test** |
| `goose` | CLI | `goose run -t …` | Flags follow the docs; confirm with **Test** |
| `workbuddy` | CLI | `codebuddy -p --output-format stream-json --permission-mode acceptEdits`, prompt on stdin | Tencent's CodeBuddy Code; the same CLI ships as WorkBuddy (international) and CodeBuddy (China). Flags per the official CLI reference; confirm with **Test** |
| `antigravity-ide`, `vscode`, `freebuff` | IDE | none — detected for the *open workspace* handoff only | Detected, not runnable as an agent |

**WorkBuddy / CodeBuddy Code** is Tencent's agent CLI, shipped as `codebuddy` (China, copilot.tencent.com) and as WorkBuddy internationally (workbuddy.ai). Its `--output-format stream-json` dialect is Claude-Code shaped — an init system message, then assistant/user messages, then a final result — so the existing `claude-stream-json` parser decodes it with no new parser. Note the rule Tencent documents for automation: `-p/--print` alone is not enough for tool use; a permitted mode (`--permission-mode acceptEdits`, preset here) or `-y`/`--dangerously-skip-permissions` is required, otherwise file and shell tools are blocked.

**Freebuff** is deliberately registered as a handoff, not an engine. Its CLI has no non-interactive mode: the parser takes only `login`, `--continue`, `--cwd` and `--trust-agents`, and returns `initialPrompt: null` for the Freebuff build (`cli/src/cli-args.ts`), so there is no print flag to drive. The dashboard detects Freebuff Desktop and can open a run workspace in it. To spend Freebuff's included models on DSH runs instead, put an OpenAI-compatible bridge in front of it (for example `freebuff2api`) and add that endpoint as a provider.

### Detection

Detection is automatic and five-valued, because "the binary exists", "this works", and "you switched it off" are different facts:

| Availability | Meaning |
|---|---|
| `missing` | Nothing matched the engine's command names or search patterns |
| `installed` | Found (with a version), but a real run has not succeeded yet |
| `ready` | A health check actually got an answer out of it |
| `disabled` | The engine is switched off in settings, so it is never used |
| `broken` | Found, but unusable — an unreadable wrapper, or a health check that failed; the reason is attached |

Search patterns are expanded against the real machine (`%VAR%`, `$VAR`, and `~`); `*` matches one path segment and `**` matches any depth — which is how a versioned layout such as `%LOCALAPPDATA%/Claude-3p/claude-code/*/*/claude.exe` is found. Candidates are tried in a fixed order: a pinned **Exact program path**, then the command names on `PATH`, then the search patterns. Within a single search pattern the newest version wins, so pin the path when that order picks the wrong program.

### Adding or overriding an engine

Everything is editable from **Settings → Execution engines**, and each field is stored as a *difference* over the built-in preset, so later preset improvements still reach you. The block below is the body of `PUT /api/engines`; on disk the same object is stored in `.dsh-multi-agent/settings.json` as `{ "engines": { "my-agent": { ... } } }`, keyed by engine id.

```jsonc
{
  "engine": {
    "id": "my-agent",
    "label": "My Agent",
    "kind": "cli",                       // cli | dsh | ide
    "enabled": true,
    "detect": {
      "commands": ["my-agent"],          // names on PATH, or absolute paths
      "searchGlobs": ["~/.my-agent/bin/my-agent"],
      "versionArgs": ["--version"]
    },
    "run": {
      "argsTemplate": ["-p", "{prompt}", "--model", "{model}"],
      "outputFormat": "json-lines",      // dsh-json | claude-stream-json | gemini-stream-json | json-lines | text
      "promptViaStdin": false,
      "extraArgs": ["--yes"]
    }
  }
}
```

Template placeholders: `{prompt}`, `{model}`, `{cwd}`, `{sessionId}`, `{extra}`. An empty value removes its own token **and the flag before it**, so `["--model", "{model}"]` with no model chosen produces no arguments rather than a dangling `--model`. Unknown placeholders are deliberately left in place, so a typo in a hand-edited template shows up in the command line instead of silently vanishing.

Prefer `promptViaStdin: true` where the CLI supports it — prompts get long, and argv has hard limits on Windows.

### Engine API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/engines` | Every engine with its live detection state |
| `PUT` | `/api/engines` | Add or edit an engine (`{ engine: { … } }`) |
| `GET` | `/api/engines/:id` | One engine, re-detected |
| `DELETE` | `/api/engines/:id` | Delete a custom engine, or hide a built-in preset |
| `POST` | `/api/engines/:id/restore` | Bring back a built-in preset hidden with `DELETE` |
| `POST` | `/api/engines/:id/detect` | Re-scan for the executable |
| `POST` | `/api/engines/:id/test` | Run the health check (a real, tiny invocation) |
| `POST` | `/api/engines/:id/handoff` | Open a workspace in an IDE engine |

---

## 🏗️ Architecture

```
                       ┌──────────────────────────────┐
                       │   Browser Dashboard (UI)     │
                       │  Vanilla JS + SSE + RTL/LTR  │
                       └──────────────┬───────────────┘
                                      │ HTTP / SSE
                       ┌──────────────▼───────────────┐
                       │   Node.js Dashboard Server   │
                       │   (src/index.ts, Port 7317)  │
                       └──────────────┬───────────────┘
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
        ┌───────────────────────┐             ┌─────────────────────┐
        │  Pipeline Controller  │             │   Native Launcher   │
        └──────────┬────────────┘             └──────────┬──────────┘
                   │                                     │
      ┌────────────┼────────────┐                        │
      ▼            ▼            ▼                        ▼
┌───────────┐┌───────────┐┌───────────┐        ┌───────────────────┐
│dsh headless│claude -p  │my-agent   │        │   dsh headless    │
│(Lead model││(Sub model ││(Sub model │        │ (Lead Agent with  │
│  @ Patch) ││  @ flags) ││  @ flags) │        │  subagent tools)  │
└───────────┘└───────────┘└───────────┘        └───────────────────┘
        └───────── one run, mixed engines ─────────┘
```

Each DSH agent run receives an on-the-fly generated Cordis YAML overlay:
```yaml
- id: agent-default-model
  config:
    provider: omni
    model: deepseek-v4.1-flash:free
    reasoningEffort: max
- id: credentials
  disabled: false
- id: llm-pi-ai
  config:
    providers:
      omni:
        models: [...]
```

CLI engines are launched without a shell wherever possible: a `.cmd`/`.bat` wrapper (including the DSH launcher itself) is read and rewritten into its real `node <script>` or bundled-binary command line, which keeps paths and prompts containing spaces safe.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js**: `>= 22.18.0` (or `24.x` recommended)
- **DeepSeek Harness (DSH)**: Desktop app installed on Windows, macOS, or Linux.

### Installation

```bash
git clone https://github.com/mnochernadi/dsh-multi-agent.git
cd dsh-multi-agent
npm start
```

Open your browser at **`http://127.0.0.1:7317`**.

Server flags: `-p, --port <port>`, `-H, --host <host>`, `--open` (open the browser), `--log-level <debug|info|warn|error>`, `-V, --version`, `-h, --help`.

### Verifying Environment (`npm run probe`)

Run the diagnostic probe to automatically check DSH binary detection and validate model routes:

```bash
npm run probe
```

To dry-run test a specific provider and model without consuming tokens:
```bash
npm run probe -- --provider omni --model deepseek-v4.1-flash:free --effort max
```

---

## ⚙️ Configuration

Copy `.env.example` to `.env` to customize settings:

```ini
DSH_MA_DASHBOARD_HOST=127.0.0.1
DSH_MA_DASHBOARD_PORT=7317
DSH_MA_DSH_BIN=
DSH_MA_DSH_HOME=
DSH_MA_RUN_CWD=
DSH_MA_RUN_TIMEOUT_MS=1800000
DSH_MA_MAX_CONCURRENCY=4
DSH_MA_TRUST_STORED_CREDENTIALS=true
DSH_MA_LANGUAGE=fa
```

All settings can also be modified interactively in the **Settings** tab of the web dashboard.

---

## 🧪 Testing

Run the zero-dependency test suite:

```bash
npm test
```

Check TypeScript types:
```bash
npm run typecheck
```

---

## 📂 Project Structure

```
dsh-multi-agent/
├── src/
│   ├── index.ts               # CLI entry point & server bootstrap
│   ├── config/
│   │   ├── paths.ts           # DSH_HOME & filesystem path resolutions
│   │   ├── settings.ts        # Dashboard settings store
│   │   └── discover.ts        # Provider & model scanner from DSH profile patches
│   ├── engines/               # <- multi-engine layer
│   │   ├── types.ts           # Engine definitions, detection & parser contracts
│   │   ├── presets.ts         # Built-in engines (dsh, claude-code, gemini-cli, …)
│   │   ├── registry.ts        # Preset + user-override merging and validation
│   │   ├── detect.ts          # Executable resolution, version probe, health check
│   │   ├── template.ts        # {prompt}/{model}/… argument templates
│   │   ├── parsers.ts         # Vendor stream → one event vocabulary
│   │   └── cli.ts             # Runs one agent through any CLI engine
│   ├── dsh/
│   │   ├── launcher.ts        # Electron/asar launcher resolution
│   │   ├── patch.ts           # Cordis YAML patch generator
│   │   └── runner.ts          # `dsh headless` runner
│   ├── orchestrator/
│   │   ├── engine.ts          # Multi-agent orchestrator & concurrency pool
│   │   ├── plan.ts            # Dynamic task planner & resolver
│   │   └── prompts.ts         # High-fidelity prompt templates
│   ├── server/
│   │   ├── http-server.ts     # REST API & static file server
│   │   └── events.ts          # Server-Sent Events (SSE) hub
│   └── util/
│       ├── yaml.ts            # Fast, dependency-free YAML subset parser/emitter
│       ├── process.ts         # One place for spawning, streaming, timeout, kill
│       ├── winwrap.ts         # .cmd/.bat wrapper rewriting (no shell needed)
│       ├── env.ts             # Environment parser
│       ├── log.ts             # Levelled logger for the server
│       └── ids.ts             # Collision-free ID generators
├── public/                    # No-build web interface
│   ├── index.html
│   ├── styles.css             # Responsive theme with full RTL/LTR support
│   ├── app.js                 # State & reactive timeline renderer
│   ├── api.js                 # Client API & SSE connection
│   ├── i18n.js                # Complete English & Persian dictionary
│   └── favicon.svg
├── test/                      # 65 unit + integration tests
│   └── fixtures/fake-agent-cli.mjs   # A fake CLI that speaks a real dialect
├── docs/                      # Technical documentation
└── scripts/probe.ts           # Diagnostic CLI tool
```

---

## 📜 License

[MIT](LICENSE) © 2026 [mnochernadi](https://github.com/mnochernadi)
