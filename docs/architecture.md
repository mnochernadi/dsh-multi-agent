# Technical Architecture

This document describes the design decisions, process lifecycle, and integration points between `dsh-multi-agent` and DeepSeek Harness (DSH).

---

## 1. Process Isolation Model

DeepSeek Harness profiles (such as `desktop`, `web`, `headless`, `sdk`) compose an interconnected Cordis plugin tree.
The desktop profile is exclusively managed by the Electron application and cannot be booted directly from external CLIs.

To achieve clean orchestration without interfering with the user's running GUI session, `dsh-multi-agent` launches individual agent tasks as isolated subprocesses running:

```bash
dsh --profile headless --patch <generated-patch.yml> --json -
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
