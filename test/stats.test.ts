import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats } from '../src/stats.ts';
import type { AssistantEvent, ToolCallEvent, ToolResultEvent, TraceEvent, UserEvent } from '../src/types.ts';

function user(overrides: Partial<UserEvent> = {}): UserEvent {
  return { type: 'user', ts: null, text: '', ...overrides };
}

function assistant(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return { type: 'assistant', ts: null, text: '', usage: null, ...overrides };
}

function call(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { type: 'tool_call', ts: null, id: null, name: 'read_file', args: null, ...overrides };
}

function result(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return { type: 'tool_result', ts: null, id: null, ok: true, durationMs: null, output: '', error: null, ...overrides };
}

test('an empty trace produces all-zero stats without dividing by zero', () => {
  const stats = computeStats([]);
  assert.equal(stats.events, 0);
  assert.deepEqual(stats.byType, { user: 0, assistant: 0, tool_call: 0, tool_result: 0 });
  assert.equal(stats.firstTs, null);
  assert.equal(stats.lastTs, null);
  assert.equal(stats.wallClockMs, null);
  assert.equal(stats.toolTimeMs, 0);
  assert.deepEqual(stats.tools, []);
  assert.equal(stats.failureRate, 0);
  assert.equal(stats.pendingCalls, 0);
  assert.equal(stats.orphanResults, 0);
  assert.deepEqual(stats.tokens, { input: 0, output: 0, total: 0 });
});

test('wall clock spans the earliest to the latest timestamped event', () => {
  const events: TraceEvent[] = [
    user({ ts: 1000 }),
    assistant({ ts: 1500 }),
    call({ ts: 1600 }),
    result({ ts: 1900 }),
  ];
  const stats = computeStats(events);
  assert.equal(stats.firstTs, 1000);
  assert.equal(stats.lastTs, 1900);
  assert.equal(stats.wallClockMs, 900);
});

test('token totals are summed across assistant events only', () => {
  const events: TraceEvent[] = [
    assistant({ usage: { input: 10, output: 3 } }),
    assistant({ usage: { input: 5, output: 1 } }),
    assistant({ usage: null }),
    user(),
  ];
  const stats = computeStats(events);
  assert.deepEqual(stats.tokens, { input: 15, output: 4, total: 19 });
});

test('per-tool stats: totals, average and max ignore unmeasured spans', () => {
  const events: TraceEvent[] = [
    call({ id: 'c1', name: 'read_file' }),
    result({ id: 'c1', durationMs: 100 }),
    call({ id: 'c2', name: 'read_file' }),
    result({ id: 'c2' }), // completed, but no duration is derivable
  ];
  const stats = computeStats(events);
  assert.equal(stats.tools.length, 1);
  const [readFile] = stats.tools;
  assert.equal(readFile.calls, 2);
  assert.equal(readFile.completed, 2);
  assert.equal(readFile.totalMs, 100);
  assert.equal(readFile.avgMs, 100); // averaged over the one span that had a duration, not both
  assert.equal(readFile.maxMs, 100);
  assert.equal(readFile.timeShare, 1);
});

test('tools are sorted by total time, then call count, then name', () => {
  const events: TraceEvent[] = [
    call({ id: 'a1', name: 'slow' }),
    result({ id: 'a1', durationMs: 300 }),
    call({ id: 'b1', name: 'fast' }),
    result({ id: 'b1', durationMs: 10 }),
    call({ id: 'b2', name: 'fast' }),
    result({ id: 'b2', durationMs: 10 }),
  ];
  const stats = computeStats(events);
  assert.deepEqual(stats.tools.map((t) => t.name), ['slow', 'fast']);
});

test('failure rate divides by completed calls and ignores pending ones', () => {
  const events: TraceEvent[] = [
    call({ id: 'c1' }),
    result({ id: 'c1', ok: false }),
    call({ id: 'c2' }),
    result({ id: 'c2', ok: true }),
    call({ id: 'c3' }), // never completes
  ];
  const stats = computeStats(events);
  assert.equal(stats.toolCalls, 3);
  assert.equal(stats.toolCompleted, 2);
  assert.equal(stats.toolFailures, 1);
  assert.equal(stats.failureRate, 0.5);
  assert.equal(stats.pendingCalls, 1);
});

test('orphan results are counted separately from calls and do not create spans', () => {
  const events: TraceEvent[] = [call({ id: 'c1' }), result({ id: 'unrelated' })];
  const stats = computeStats(events);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.pendingCalls, 1);
  assert.equal(stats.orphanResults, 1);
});
