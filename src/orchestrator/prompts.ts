import type { AgentSpec, PlanResult, PlanTask } from '../types.ts';

/**
 * Prompt templates for the dashboard pipeline.
 *
 * Every stage is a separate `dsh` run, so each prompt has to be self-contained:
 * it restates the user's goal, the agent's role, and whatever upstream output
 * the agent is allowed to see.
 */

function roleBlock(agent: AgentSpec): string {
  const lines = [`Your assigned role: ${agent.name}.`];
  if (agent.instructions && agent.instructions.trim() !== '') lines.push(agent.instructions.trim());
  return lines.join('\n');
}

function fence(language: string, body: string): string {
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

export function buildPlannerPrompt(input: {
  task: string;
  subs: AgentSpec[];
  cwd: string;
}): string {
  const roster = input.subs
    .map((sub, index) => {
      const role = sub.instructions?.trim() ? ` — ${sub.instructions.trim()}` : '';
      return `${index + 1}. agentId: "${sub.id}" — name: ${sub.name}${role}`;
    })
    .join('\n');

  const shape = {
    tasks: [
      {
        id: 't1',
        agentId: input.subs[0]?.id ?? 'agent-id',
        title: 'short title',
        instructions: 'precise, self-contained instructions for that agent',
        skip: false,
      },
    ],
  };

  return [
    'You are the lead agent of a multi-agent team. Plan the work; do not do it yourself.',
    '',
    '# Overall goal',
    input.task,
    '',
    '# Working directory',
    input.cwd,
    '',
    '# Available team members',
    roster === '' ? '(no sub-agents are configured; plan a single task for yourself)' : roster,
    '',
    '# Requirements',
    '- Return exactly one entry per team member listed above, in the same order.',
    '- `instructions` must be self-contained: the agent sees only your instructions and the overall goal.',
    '- Set `skip` to true only when that member is genuinely not needed.',
    '- Use the exact `agentId` strings given above. Do not invent new ids.',
    '- You may read files and run read-only commands to ground the plan, but delegate all real work.',
    '',
    '# Output contract',
    'End your reply with exactly one JSON object and nothing after it, in this shape:',
    fence('json', JSON.stringify(shape, null, 2)),
  ].join('\n');
}

export function buildSubAgentPrompt(input: {
  task: string;
  agent: AgentSpec;
  planTask: PlanTask;
  dependencyOutputs: { name: string; output: string }[];
  includeDependencyOutput: boolean;
}): string {
  const parts = [
    roleBlock(input.agent),
    '',
    '# Overall goal (for context only)',
    input.task,
    '',
    `# Your task: ${input.planTask.title}`,
    input.planTask.instructions,
  ];

  if (input.includeDependencyOutput && input.dependencyOutputs.length > 0) {
    parts.push('', '# Outputs from agents that ran before you');
    for (const dependency of input.dependencyOutputs) {
      parts.push('', `## ${dependency.name}`, dependency.output.trim() || '(no output)');
    }
  }

  parts.push(
    '',
    '# Rules',
    '- Complete only your task; other agents cover the rest.',
    '- Do the work with your tools instead of describing what you would do.',
    '- Finish with a compact report: what you did, what you found, and any open question.',
  );
  return parts.join('\n');
}

export function buildSynthesisPrompt(input: {
  task: string;
  plan: PlanResult | undefined;
  results: { name: string; task: string; output: string; error?: string }[];
  instructions?: string;
  cwd: string;
}): string {
  const parts = [
    'You are the lead agent. Your sub-agents have finished their tasks.',
    '',
    '# Overall goal',
    input.task,
    '',
    '# What was delegated',
  ];

  if (input.plan && input.plan.tasks.length > 0) {
    for (const task of input.plan.tasks) {
      parts.push(`- ${task.title}${task.agentId ? ` (agent: ${task.agentId})` : ''}`);
    }
  } else {
    parts.push('- (no plan was recorded)');
  }

  parts.push('', '# Sub-agent reports');
  if (input.results.length === 0) {
    parts.push('(no sub-agent produced a report)');
  }
  for (const result of input.results) {
    parts.push('', `## ${result.name} — ${result.task}`);
    if (result.error) parts.push(`This agent failed: ${result.error}`);
    parts.push(result.output.trim() || '(no output)');
  }

  if (input.instructions && input.instructions.trim() !== '') {
    parts.push('', '# Extra instructions from the operator', input.instructions.trim());
  }

  parts.push(
    '',
    '# Your job',
    '- Deliver the final answer to the overall goal, not a summary of the team.',
    '- Resolve contradictions between reports; verify anything that looks uncertain.',
    '- If a sub-agent failed or left a gap, close it yourself or state the gap plainly.',
    '- Write for the person who asked: concrete, complete, no process narration.',
  );
  return parts.join('\n');
}

export function buildNativePrompt(input: { task: string; subs: AgentSpec[]; cwd: string }): string {
  const roster = input.subs
    .map((sub) => `- ${sub.name}${sub.instructions?.trim() ? `: ${sub.instructions.trim()}` : ''}`)
    .join('\n');

  return [
    'You are the lead agent working in a shared workspace.',
    '',
    '# Goal',
    input.task,
    '',
    '# Working directory',
    input.cwd,
    '',
    '# Intended helper roles',
    roster === '' ? '(none declared — create helpers only if they clearly help)' : roster,
    '',
    '# Rules',
    '- Use your sub-agent tools (`subagent`, `subagent_fork`) to delegate independent parts of the work.',
    '- Run independent parts in the same step so they execute concurrently.',
    '- Sub-agents inherit your model and your working directory; give each one a self-contained brief.',
    '- Do the critical-path work yourself and integrate their results.',
    '- Finish with the complete answer for the person who asked.',
  ].join('\n');
}

/** Prompt used when the planner stage could not produce a usable plan. */
export function buildFallbackDirectPrompt(input: { task: string; agent: AgentSpec }): string {
  return [
    roleBlock(input.agent),
    '',
    '# Goal',
    input.task,
    '',
    'Complete this goal directly, using your tools.',
  ].join('\n');
}