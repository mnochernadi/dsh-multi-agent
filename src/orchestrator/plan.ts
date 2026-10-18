import type { AgentSpec, PlanResult, PlanTask } from '../types.ts';

/**
 * Turn a planner agent's reply into an executable plan.
 *
 * Model output is never trusted blindly: fenced JSON is preferred, then the last
 * balanced object in the text; anything unmatched is dropped and reported as a
 * warning. When nothing usable is found the caller falls back to the manual
 * plan built from each sub-agent's own instructions.
 */

interface RawPlanTask {
  id?: unknown;
  agentId?: unknown;
  title?: unknown;
  instructions?: unknown;
  skip?: unknown;
}

/** Every substring that could be a JSON object, innermost-last. */
export function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) {
    const body = match[1]?.trim();
    if (body) candidates.push(body);
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) candidates.push(text.slice(start, i + 1));
      }
    }
  }
  return candidates;
}

/** Find the last parseable plan object in a reply. */
export function extractPlanObject(text: string): Record<string, unknown> | null {
  const candidates = jsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]!;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.tasks) || Array.isArray(record.subtasks)) return record;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** The manual plan: one task per configured sub-agent, using its own brief. */
export function manualPlan(subs: AgentSpec[]): PlanResult {
  return {
    source: 'manual',
    tasks: subs.map((sub) => ({
      id: sub.id,
      agentId: sub.id,
      title: sub.name,
      instructions:
        sub.instructions?.trim() ||
        `Handle the part of the goal that best matches your role as ${sub.name}.`,
    })),
  };
}

/**
 * Map a planner reply onto the configured roster. Every sub-agent receives at
 * most one task; a member the planner skipped is marked `skip: true`.
 */
export function resolvePlan(input: {
  raw: string;
  subs: AgentSpec[];
}): PlanResult {
  const warnings: string[] = [];
  const object = extractPlanObject(input.raw);
  if (!object) {
    return {
      source: 'main-agent',
      tasks: [],
      raw: input.raw,
      warnings: ['The planner reply contained no parseable JSON plan.'],
    };
  }

  const list = (Array.isArray(object.tasks) ? object.tasks : object.subtasks) as unknown;
  const rawTasks = (Array.isArray(list) ? list : []).filter(
    (item): item is RawPlanTask => item !== null && typeof item === 'object',
  );
  if (rawTasks.length === 0) {
    warnings.push('The planner returned an empty task list.');
  }

  const byAgent = new Map<string, RawPlanTask>();
  const leftovers: RawPlanTask[] = [];
  for (const raw of rawTasks) {
    const key = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
    const match = input.subs.find(
      (sub) =>
        sub.id === key ||
        sub.id.toLowerCase() === key.toLowerCase() ||
        sub.name.toLowerCase() === key.toLowerCase(),
    );
    if (match) {
      if (!byAgent.has(match.id)) byAgent.set(match.id, raw);
      else warnings.push(`The planner assigned more than one task to "${match.id}"; extras were ignored.`);
      continue;
    }
    leftovers.push(raw);
    if (key !== '') warnings.push(`The planner used unknown agentId "${key}"; that task was dropped.`);
  }

  // A planner that omitted members, or returned unlabelled tasks: fill in order.
  const unassigned = input.subs.filter((sub) => !byAgent.has(sub.id));
  if (unassigned.length > 0 && leftovers.length > 0) {
    unassigned.forEach((sub, index) => {
      const raw = leftovers[index];
      if (raw) {
        byAgent.set(sub.id, raw);
        warnings.push(`Task "${stringOf(raw.title) || index + 1}" had no valid agentId; assigned to "${sub.id}".`);
      }
    });
  }

  const tasks: PlanTask[] = [];
  for (const raw of rawTasks) {
    const key = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
    const match = input.subs.find((sub) => sub.id === key);
    const skip = raw.skip === true;
    if (skip && match) {
      tasks.push({
        id: match.id,
        agentId: match.id,
        title: stringOf(raw.title) || match.name,
        instructions: stringOf(raw.instructions),
        skipped: true,
      } as PlanTask & { skipped: boolean });
    }
  }

  for (const sub of input.subs) {
    const raw = byAgent.get(sub.id);
    if (!raw) {
      warnings.push(`The planner left "${sub.id}" without a task; it will not run.`);
      continue;
    }
    const skipped = raw.skip === true;
    tasks.push({
      id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : sub.id,
      agentId: sub.id,
      title: stringOf(raw.title) || sub.name,
      instructions: stringOf(raw.instructions) || sub.instructions || '',
      ...(skipped ? { skipped: true } : {}),
    } as PlanTask);
  }

  return { source: 'main-agent', tasks, raw: input.raw, warnings };
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isSkipped(task: PlanTask): boolean {
  return (task as PlanTask & { skipped?: boolean }).skipped === true;
}