# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-20

### Added
- **Multi-engine architecture**: an agent is no longer required to run on DeepSeek Harness. Any headless agent CLI can be an engine.
- Built-in engine presets: `claude-code`, `gemini-cli`, `codex-cli`, `cursor-agent`, `opencode`, `aider`, `qwen-code`, `goose`, `workbuddy`, plus `antigravity-ide`, `vscode` and `freebuff` for the workspace handoff.
- Automatic engine detection with five availability states (`ready` / `installed` / `missing` / `disabled` / `broken`), machine-expanded search globs, version probing, and version-aware ordering so the newest install wins.
- Real health checks: an engine proves it can answer before it is called ready, and reports its own error text verbatim (`Not logged in · Please run /login`).
- Full manual engine management in the UI and API: add, edit, enable/disable, hide a built-in preset, re-scan, test, and open a workspace in an IDE engine.
- Per-agent engine selection alongside provider/model; a single run may mix engines.
- Stream parsers for the DSH, Claude Code, Gemini, generic JSON-lines and plain-text dialects, all mapping into one event vocabulary.
- Argument templates with `{prompt}`, `{model}`, `{cwd}`, `{sessionId}` and `{extra}`, where an empty value also removes its leading flag.
- Shared process layer (`util/process.ts`) and Windows wrapper rewriting (`util/winwrap.ts`), removing duplicated spawn logic and the need for a shell.
- Thirty-three new tests covering parsers, templates, detection, registry merging, and real-child-process engine runs (65 total).
- **Liquid Glass interface**: the dashboard is rebuilt on a refractive glass material — moving ambient light field, `backdrop-filter` lens, an SVG displacement pass that bends the backdrop at the rim (real refraction, not just blur), and a specular highlight that tracks the pointer. Light and dark themes, RTL and LTR, plus honest fallbacks for `prefers-reduced-transparency`, `prefers-contrast`, `prefers-reduced-motion`, forced-colors and engines without `backdrop-filter`.
- **WorkBuddy / CodeBuddy Code preset** (`workbuddy`): Tencent's agent CLI, detected under its international (`workbuddy`), China (`codebuddy`) and short (`cbc`) names. Headless mode is `-p --output-format stream-json` with the prompt on stdin and `--permission-mode acceptEdits` for tool use; its stream is Claude-Code shaped, so the existing parser decodes it.
- **Freebuff preset** (`freebuff`): registered as a workspace handoff, not a runnable agent, because its CLI has no non-interactive mode (verified in `cli/src/cli-args.ts` — no prompt argument, no print flag). The desktop install is detected and can be opened against a run workspace.

### Fixed
- Mojibake in user-facing and comment text (`â€”` / `â€™`) left by a mis-encoded write: em dashes and apostrophes in engine descriptions, the orchestrator and launcher docs, and the test entrypoint now read correctly.
- The Freebuff preset probes no version: `Freebuff.exe --version` prints its bundled Node version (`v20.18.3`), not the app version, so reporting it as the engine version was misleading.

### Changed
- The DSH runner now uses the shared process layer and the shared DSH parser.
- Manual planning marks the unused plan stage as `skipped` instead of leaving it pending.

## [0.1.0] - 2026-10-19

### Added
- Multi-agent orchestration dashboard connected to DeepSeek Harness (`dsh`).
- Per-agent provider, model, and reasoning effort configuration.
- Dynamic Cordis patch overlay generation for headless profile runs.
- Dashboard Pipeline orchestration mode (Lead planning -> DAG sub-agents -> Lead synthesis).
- Native DSH mode with internal subagent tool delegation.
- Automatic provider and model discovery from DSH user profiles.
- Secure credential reuse via DSH local credential store without web exposure.
- Real-time Server-Sent Events (SSE) telemetry for model reasoning, messages, tool calls, and tokens.
- Complete Persian (RTL) and English (LTR) bilingual user interface with instant toggle.
- Zero runtime dependencies architecture powered by Node.js native TypeScript stripping.
- Automated diagnostic probe (`scripts/probe.ts`).
- Comprehensive unit test suite with 32 automated tests.
