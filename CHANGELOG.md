# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
