import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/server/events.ts';
import type { DashboardEvent } from '../src/types.ts';

function collector() {
  const frames: string[] = [];
  let closeCallback: (() => void) | null = null;
  return {
    frames,
    writer: {
      write: (chunk: string) => frames.push(chunk),
      onClose: (callback: () => void) => {
        closeCallback = callback;
      },
    },
    close: () => closeCallback?.(),
  };
}

const sample = (runId: string, type: DashboardEvent['type'], data: Record<string, unknown> = {}) => ({
  runId,
  type,
  ts: Date.now(),
  data,
});

test('events: assigns monotonic sequence numbers and frames SSE payloads', () => {
  const hub = new EventHub();
  const first = hub.emit(sample('run_1', 'run_created'));
  const second = hub.emit(sample('run_1', 'run_started'));
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(hub.lastSeq, 2);
  hub.close();
});

test('events: a subscriber receives history since its last seen sequence', () => {
  const hub = new EventHub();
  hub.emit(sample('run_1', 'run_created'));
  hub.emit(sample('run_1', 'agent_started', { agentId: 'a' }));

  const subscriber = collector();
  hub.subscribe(subscriber.writer, 1);
  const payloads = subscriber.frames
    .flatMap((frame) => [...frame.matchAll(/^data: (.*)$/gm)].map((match) => match[1]!))
    .map((line) => JSON.parse(line) as DashboardEvent)
    .filter((event) => event.type !== undefined && event.runId !== undefined);
  assert.deepEqual(payloads.map((event) => event.type), ['agent_started'], 'replays only what was missed');
  assert.ok(subscriber.frames.some((frame) => frame.startsWith('retry:')), 'sets a reconnect hint');
  assert.ok(subscriber.frames.some((frame) => frame.startsWith('event: ready')), 'announces readiness');
  hub.close();
});

test('events: live events reach subscribers and detaching stops delivery', () => {
  const hub = new EventHub();
  const subscriber = collector();
  const detach = hub.subscribe(subscriber.writer, 99);
  hub.emit(sample('run_2', 'agent_event', { agentId: 'x' }));
  assert.equal(hub.clientCount, 1);
  assert.ok(subscriber.frames.some((frame) => frame.includes('agent_event')));

  detach();
  assert.equal(hub.clientCount, 0);
  hub.emit(sample('run_2', 'agent_finished'));
  assert.ok(!subscriber.frames.some((frame) => frame.includes('agent_finished')));
  hub.close();
});

test('events: history is bounded and filterable by run', () => {
  const hub = new EventHub({ bufferSize: 3 });
  for (let i = 0; i < 5; i += 1) hub.emit(sample(`run_${i}`, 'log', { i }));
  assert.equal(hub.history().length, 3, 'the ring buffer keeps only the newest events');
  assert.deepEqual(hub.history(0, 'run_4').map((event) => event.data.i), [4]);
  hub.close();
});