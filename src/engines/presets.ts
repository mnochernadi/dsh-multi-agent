import type { EngineDefinition } from './types.ts';

/**
 * Built-in engine presets.
 *
 * DeepSeek Harness and Claude Code are the two engines whose headless interface
 * has been verified against a real installation. The others carry the flags
 * their documentation describes, but releases move: each preset can be tested
 * from the dashboard ("Test") and every field is editable, so a wrong flag is a
 * one-line fix rather than a dead end.
 *
 * Nothing here is required. Detection only reports what exists on the machine.
 */

function engine(definition: EngineDefinition): EngineDefinition {
  return definition;
}

export const DSH_ENGINE_ID = 'dsh';

export const builtinEngines: EngineDefinition[] = [
  engine({
    id: DSH_ENGINE_ID,
    label: 'DeepSeek Harness',
    kind: 'dsh',
    builtin: true,
    enabled: true,
    description:
      'Runs one agent as a real `dsh --profile headless` process. Provider, model and reasoning effort are injected through a generated Cordis patch, and credentials come from the DSH store.',
    homepage: 'https://github.com/deepseek-ai/deepseek-harness',
    detect: { commands: ['dsh'] },
    run: {
      argsTemplate: [],
      outputFormat: 'dsh-json',
      promptViaStdin: true,
      models: [],
    },
  }),

  engine({
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'cli',
    builtin: true,
    enabled: true,
    description:
      'Anthropic Claude Code in non-interactive mode (`claude -p --output-format stream-json`). Reads the prompt from stdin. Add tool permissions to Extra args when the agent needs to edit files, e.g. --permission-mode acceptEdits.',
    homepage: 'https://docs.claude.com/en/docs/claude-code/cli-reference',
    detect: {
      commands: ['claude', 'claude-code'],
      searchGlobs: [
        '%LOCALAPPDATA%/Claude-3p/claude-code/*/*/claude.exe',
        '%LOCALAPPDATA%/Programs/claude/claude.exe',
        '%APPDATA%/npm/claude.cmd',
        '~/.claude/local/claude',
        '~/.local/bin/claude',
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ],
      versionArgs: ['--version'],
      versionRegex: '([0-9]+\\.[0-9]+\\.[0-9]+)',
    },
    run: {
      argsTemplate: ['-p', '--output-format', 'stream-json', '--verbose', '--model', '{model}'],
      outputFormat: 'claude-stream-json',
      extraArgs: [],
      promptViaStdin: true,
      models: [
        { id: '', name: 'Account default' },
        { id: 'sonnet', name: 'sonnet (alias)' },
        { id: 'opus', name: 'opus (alias)' },
        { id: 'haiku', name: 'haiku (alias)' },
      ],
      healthArgsTemplate: ['-p', '--output-format', 'json'],
      healthPrompt: 'Reply with exactly: OK',
      healthTimeoutMs: 180_000,
    },
  }),

  engine({
    id: 'gemini-cli',
    label: 'Gemini CLI',
    kind: 'cli',
    builtin: true,
    enabled: true,
    description:
      'Google Gemini CLI in non-interactive mode. Flags follow the documented `-p` / `--output-format` interface â€” run Test after installing to confirm this release matches.',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    detect: {
      commands: ['gemini'],
      searchGlobs: ['%APPDATA%/npm/gemini.cmd', '~/.local/bin/gemini', '/usr/local/bin/gemini', '/opt/homebrew/bin/gemini'],
      versionArgs: ['--version'],
      versionRegex: '([0-9]+\\.[0-9]+\\.[0-9]+)',
    },
    run: {
      argsTemplate: ['-p', '{prompt}', '--output-format', 'stream-json', '--model', '{model}'],
      outputFormat: 'gemini-stream-json',
      promptViaStdin: false,
      models: [
        { id: '', name: 'Account default' },
        { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro' },
        { id: 'gemini-2.5-flash', name: 'gemini-2.5-flash' },
      ],
      healthArgsTemplate: ['-p', '{prompt}', '--output-format', 'json'],
      healthPrompt: 'Reply with exactly: OK',
    },
  }),

  engine({
    id: 'codex-cli',
    label: 'OpenAI Codex CLI',
    kind: 'cli',
    builtin: true,
    enabled: true,
    description:
      'OpenAI Codex in non-interactive mode (`codex exec`). Streaming JSON flags vary by release â€” verify with Test before using it in a pipeline.',
    homepage: 'https://github.com/openai/codex',
    detect: {
      commands: ['codex'],
      searchGlobs: ['%APPDATA%/npm/codex.cmd', '~/.local/bin/codex', '/usr/local/bin/codex', '/opt/homebrew/bin/codex'],
      versionArgs: ['--version'],
      versionRegex: '([0-9]+\\.[0-9]+\\.[0-9]+)',
    },
    run: {
      argsTemplate: ['exec', '--json', '--model', '{model}', '{prompt}'],
      outputFormat: 'json-lines',
      promptViaStdin: false,
      models: [
        { id: '', name: 'Account default' },
        { id: 'gpt-5-codex', name: 'gpt-5-codex' },
        { id: 'gpt-5', name: 'gpt-5' },
      ],
      healthArgsTemplate: ['exec', '{prompt}'],
      healthPrompt: 'Reply with exactly: OK',
    },
  }),

  engine({
    id: 'cursor-agent',
    label: 'Cursor Agent CLI',
    kind: 'cli',
    builtin: true,
    enabled: true,
    description:
      'Cursorâ€™s headless agent. Flags follow `cursor-agent -p`; verify with Test after installing.',
    homepage: 'https://cursor.com/docs/cli',
    detect: {
      commands: ['cursor-agent', 'cursor'],
      searchGlobs: ['~/.local/bin/cursor-agent', '%LOCALAPPDATA%/Programs/cursor/resources/app/bin/cursor-agent.cmd'],
      versionArgs: ['--version'],
    },
    run: {
      argsTemplate: ['-p', '{prompt}', '--output-format', 'stream-json', '--model', '{model}'],
      outputFormat: 'json-lines',
      promptViaStdin: false,
      models: [{ id: '', name: 'Account default' }],
      healthArgsTemplate: ['-p', '{prompt}'],
      healthPrompt: 'Reply with exactly: OK',
    },
  }),

  engine({
    id: 'opencode',
    label: 'OpenCode',
    kind: 'cli',
    builtin: true,
    enabled: true,
    description:
      'OpenCodeâ€™s `run` subcommand. The desktop app does not install a CLI, so this is only detected when the `opencode` command is on PATH.',
    homepage: 'https://opencode.ai/docs/cli',
    detect: {
      commands: ['opencode'],
      searchGlobs: ['~/.opencode/bin/opencode', '%APPDATA%/npm/opencode.cmd', '~/.local/bin/opencode'],
      versionArgs: ['--version'],
    },
    run: {
      argsTemplate: ['run', '{prompt}', '--model', '{model}'],
      outputFormat: 'text',
      promptViaStdin: false,
      models: [{ id: '', name: 'Account default' }],
      healthArgsTemplate: ['run', '{prompt}'],
      healthPrompt: 'Reply with exactly: OK',
    },
  }),

  engine({
    id: 'aider',
    label: 'Aider',
    kind: 'cli',
    builtin: true,
    enabled: true,
    description:
      'Aider in message mode (`aider --message`). Output is plain text, so the dashboard shows the transcript as the answer.',
    homepage: 'https://aider.chat/docs/usage.html',
    detect: {
      commands: ['aider'],
      searchGlobs: ['~/.local/bin/aider', '%APPDATA%/npm/aider.cmd', '/usr/local/bin/aider'],
      versionArgs: ['--version'],
      versionRegex: '([0-9]+\\.[0-9]+\\.[0-9]+)',
    },
    run: {
      argsTemplate: ['--message', '{prompt}', '--yes', '--no-pretty', '--no-auto-commits', '--model', '{model}'],
      outputFormat: 'text',
      promptViaStdin: false,
      models: [{ id: '', name: 'Account default' }],
      healthArgsTemplate: ['--message', '{prompt}', '--yes', '--no-pretty', '--no-auto-commits', '--exit'],
      healthPrompt: 'Reply with exactly: OK',
    },
  }),

  engine({
    id: 'qwen-code',
    label: 'Qwen Code',
    kind: 'cli',
    builtin: true,
    enabled: true,
    description: 'Qwen Code CLI (a Gemini-CLI fork), non-interactive `-p` mode.',
    homepage: 'https://github.com/QwenLM/qwen-code',
    detect: {
      commands: ['qwen'],
      searchGlobs: ['%APPDATA%/npm/qwen.cmd', '~/.local/bin/qwen'],
      versionArgs: ['--version'],
    },
    run: {
      argsTemplate: ['-p', '{prompt}', '--output-format', 'json', '--model', '{model}'],
      outputFormat: 'json-lines',
      promptViaStdin: false,
      models: [{ id: '', name: 'Account default' }],
      healthArgsTemplate: ['-p', '{prompt}', '--output-format', 'json'],
      healthPrompt: 'Reply with exactly: OK',
    },
  }),

  engine({
    id: 'goose',
    label: 'Goose',
    kind: 'cli',
    builtin: true,
    enabled: true,
    description: 'Blockâ€™s Goose in run mode (`goose run -t`). Plain-text output.',
    homepage: 'https://block.github.io/goose/docs/guides/goose-cli-commands',
    detect: {
      commands: ['goose'],
      searchGlobs: ['~/.local/bin/goose', '/usr/local/bin/goose'],
      versionArgs: ['--version'],
    },
    run: {
      argsTemplate: ['run', '-t', '{prompt}', '--model', '{model}'],
      outputFormat: 'text',
      promptViaStdin: false,
      models: [{ id: '', name: 'Account default' }],
      healthArgsTemplate: ['run', '-t', '{prompt}'],
      healthPrompt: 'Reply with exactly: OK',
    },
  }),

  engine({
    id: 'antigravity-ide',
    label: 'Antigravity IDE',
    kind: 'ide',
    builtin: true,
    enabled: true,
    description:
      'Google Antigravity is an IDE, not a headless agent: it ships `antigravity-ide.cmd`, which opens a folder in the editor. The dashboard detects it and can open a run workspace in it, but agents cannot be executed through it. Use the command-line engine of your choice instead.',
    homepage: 'https://antigravity.google',
    detect: {
      commands: ['antigravity-ide', 'antigravity'],
      searchGlobs: [
        '%LOCALAPPDATA%/Programs/Antigravity IDE/bin/antigravity-ide.cmd',
        '%LOCALAPPDATA%/Programs/antigravity/Antigravity.exe',
        '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide',
      ],
    },
    run: {
      argsTemplate: [],
      outputFormat: 'text',
      promptViaStdin: false,
      models: [],
    },
    handoff: {
      argsTemplate: ['{cwd}'],
    },
  }),

  engine({
    id: 'vscode',
    label: 'Visual Studio Code',
    kind: 'ide',
    builtin: true,
    enabled: true,
    description:
      'Detects the `code` command so a finished runâ€™s workspace can be opened in an editor. Not an agent engine.',
    homepage: 'https://code.visualstudio.com/docs/configure/command-line',
    detect: {
      commands: ['code', 'code-insiders'],
      searchGlobs: [
        '%LOCALAPPDATA%/Programs/Microsoft VS Code/bin/code.cmd',
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      ],
    },
    run: {
      argsTemplate: [],
      outputFormat: 'text',
      promptViaStdin: false,
      models: [],
    },
    handoff: {
      argsTemplate: ['{cwd}'],
    },
  }),
];

export function findBuiltinEngine(id: string): EngineDefinition | undefined {
  return builtinEngines.find((entry) => entry.id === id);
}