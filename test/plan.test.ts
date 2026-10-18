import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPlanObject, isSkipped, jsonCandidates, manualPlan, resolvePlan } from '../src/orchestrator/plan.ts';
import type { AgentSpec } from '../src/types.ts';

const subs: AgentSpec[] = [
  { id: 'writer', name: 'Writer', role: 'sub', model: { provider: 'p', model: 'm' }, instructions: 'Write it.' },
  { id: 'critic', name: 'Critic', role: 'sub', model: { provider: 'p', model: 'm' }, instructions: 'Review it.' },
];

test('plan: finds fenced JSON and the last balanced object', () => {
  const fenced = 'Here is the plan:\n```json\n{"tasks":[{"agentId":"writer"}]}\n```\n';
  assert.deepEqual(extractPlanObject(fenced), { tasks: [{ agentId: 'writer' }] });

  const bare = 'thinking… {"tasks":[{"agentId":"writer"}]} and some trailing prose';
  assert.deepEqual(extractPlanObject(bare), { tasks: [{ agentId: 'writer' }] });

  const nested = '{"tasks":[{"agentId":"a","title":"with {braces} inside"}]}';
  assert.deepEqual(extractPlanObject(nested), { tasks: [{ agentId: 'a', title: 'with {braces} inside' }] });

  assert.equal(extractPlanObject('no json at all'), null);
  assert.equal(extractPlanObject('{"unrelated":true}'), null, 'objects without tasks are ignored');
});

test('plan: braces inside strings do not break candidate scanning', () => {
  const candidates = jsonCandidates('{"note":"a } b","tasks":[]}');
  assert.ok(candidates.some((candidate) => candidate.includes('"tasks"')));
});

test('plan: maps planner output onto the configured roster', () => {
  const raw = JSON.stringify({
    tasks: [
      { id: 't1', agentId: 'writer', title: 'Write the note', instructions: 'Six lines.' },
      { id: 't2', agentId: 'critic', title: 'Review it', instructions: 'Find gaps.', skip: false },
    ],
  });
  const plan = resolvePlan({ raw, subs });
  assert.equal(plan.source, 'main-agent');
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0]!.agentId, 'writer');
  assert.equal(plan.tasks[0]!.instructions, 'Six lines.');
  assert.equal(plan.tasks[1]!.title, 'Review it');
  assert.deepEqual(plan.warnings, []);
});

test('plan: honours skip and warns about unknown agent ids', () => {
  const raw = JSON.stringify({
    tasks: [
      { agentId: 'writer', title: 'Write', instructions: 'Do it' },
      { agentId: 'critic', title: 'Review', instructions: 'Skip me', skip: true },
      { agentId: 'ghost', title: 'Drop me', instructions: 'x' },
    ],
  });
  const plan = resolvePlan({ raw, subs });
  const critic = plan.tasks.find((task) => task.agentId === 'critic')!;
  assert.equal(isSkipped(critic), true);
  assert.ok(plan.warnings?.some((warning) => warning.includes('unknown agentId "ghost"')));
});

test('plan: matches by name and by index when ids are missing', () => {
  const byName = resolvePlan({
    raw: JSON.stringify({ tasks: [{ agentId: 'Writer', title: 'W', instructions: 'i' }] }),
    subs,
  });
  assert.equal(byName.tasks.find((task) => task.agentId === 'writer')!.title, 'W');

  const unlabelled = resolvePlan({
    raw: JSON.stringify({ tasks: [{ title: 'First', instructions: 'a' }, { title: 'Second', instructions: 'b' }] }),
    subs,
  });
  assert.equal(unlabelled.tasks.length, 2);
  assert.equal(unlabelled.tasks[0]!.agentId, 'writer');
  assert.equal(unlabelled.tasks[1]!.agentId, 'critic');
});

test('plan: an unparseable reply yields no tasks and a warning', () => {
  const plan = resolvePlan({ raw: 'I would rather describe the plan in prose.', subs });
  assert.deepEqual(plan.tasks, []);
  assert.equal(plan.warnings?.length, 1);
  assert.match(plan.warnings![0]!, /no parseable JSON plan/);
});

test('plan: manual plan uses each agent brief', () => {
  const plan = manualPlan(subs);
  assert.equal(plan.source, 'manual');
  assert.deepEqual(
    plan.tasks.map((task) => [task.agentId, task.instructions]),
    [
      ['writer', 'Write it.'],
      ['critic', 'Review it.'],
    ],
  );
});