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

- **🎯 True Per-Agent Model Selection**: Assign different models to your Lead, Researcher, Critic, or Writer (e.g. DeepSeek-V3 for planning, Claude Haiku for fast drafting, GPT-4o for critical review).
- **🔌 Native DeepSeek Harness Integration**: Spawns real, isolated `dsh --profile headless --json` processes using dynamic Cordis patch overlays.
- **🔐 Automatic Credential Reuse**: Safely leverages your existing DSH credentials store and `.env` chains without exposing private API keys to the browser.
- **⚡ Two Powerful Orchestration Modes**:
  - **Dashboard Pipeline**: The lead agent designs a DAG plan, sub-agents run in parallel or sequentially based on dependencies, and the lead synthesizes the final outcome.
  - **Native DSH Mode**: Runs a single agent team session where the lead uses DSH's built-in `subagent` tools dynamically.
- **📡 Real-Time SSE Event Stream**: Watch thought reasoning (`thinking`), streaming output, tool invocations, execution time, and token counts live.
- **🌍 Bilingual & RTL-Ready**: Seamless one-click switch between English (LTR) and Persian (RTL).
- **📦 Zero Build & Zero Dependencies**: Modern Node.js native TypeScript stripping + vanilla modern Web frontend. No Vite/Webpack build steps required.

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
│dsh headless│dsh headless│dsh headless│        │   dsh headless    │
│(Lead Model││(Sub Model ││(Sub Model │        │ (Lead Agent with  │
│  @ Patch) ││  @ Patch) ││  @ Patch) │        │  subagent tools)  │
└───────────┘└───────────┘└───────────┘        └───────────────────┘
```

Each agent run receives an on-the-fly generated Cordis YAML overlay:
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
│   ├── index.ts               # CLI Entry point & launcher
│   ├── config/
│   │   ├── paths.ts           # DSH_HOME & filesystem path resolutions
│   │   ├── settings.ts        # Dashboard settings & store
│   │   └── discover.ts        # Provider & model scanner from DSH profile patches
│   ├── dsh/
│   │   ├── launcher.ts        # Direct electron/asar process executor
│   │   ├── patch.ts           # Cordis YAML patch generator
│   │   └── runner.ts          # Headless runner & NDJSON event parser
│   ├── orchestrator/
│   │   ├── engine.ts          # Multi-agent orchestrator & concurrency pool
│   │   ├── plan.ts            # Dynamic task planner & resolver
│   │   └── prompts.ts         # High-fidelity prompt templates
│   ├── server/
│   │   ├── http-server.ts     # REST API & static file server
│   │   └── events.ts          # Server-Sent Events (SSE) hub
│   └── util/
│       ├── yaml.ts            # Fast, dependency-free YAML subset parser/emitter
│       ├── env.ts             # Environment parser
│       └── ids.ts             # Collision-free ID generators
├── public/                    # No-build web interface
│   ├── index.html
│   ├── styles.css             # Responsive theme with full RTL/LTR support
│   ├── app.js                 # State & reactive timeline renderer
│   ├── api.js                 # Client API & SSE connection
│   └── i18n.js                # Complete English & Persian dictionary
├── test/                      # Comprehensive unit tests
├── docs/                      # Technical documentation
└── scripts/probe.ts           # Diagnostic CLI tool
```

---

## 📜 License

[MIT](LICENSE) © 2026 [mnochernadi](https://github.com/mnochernadi)
