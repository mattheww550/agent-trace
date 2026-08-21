import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairToolEvents, spansByTool } from '../src/pair.ts';
import type { ToolCallEvent, ToolResultEvent } from '../src/types.ts';

function call(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { type: 'tool_call', ts: null, id: null, name: 'read_file', args: null, ...overrides };
}

function result(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return { type: 'tool_result', ts: null, id: null, ok: true, durationMs: null, output: '', error: null, ...overrides };
}

test('matches a call and result by id', () => {
  const events = [call({ id: 'c1' }), result({ id: 'c1', durationMs: 40 })];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(spans.length, 1);
  assert.equal(orphans.length, 0);
  assert.equal(spans[0].callIndex, 0);
  assert.equal(spans[0].resultIndex, 1);
  assert.equal(spans[0].durationMs, 40);
  assert.equal(spans[0].ok, true);
});

test('derives duration from the timestamp delta when durationMs is absent', () => {
  const events = [call({ id: 'c1', ts: 1000 }), result({ id: 'c1', ts: 1075 })];
  const { spans } = pairToolEvents(events);
  assert.equal(spans[0].durationMs, 75);
});

test('a negative timestamp delta is dropped rather than reported', () => {
  const events = [call({ id: 'c1', ts: 1000 }), result({ id: 'c1', ts: 900 })];
  const { spans } = pairToolEvents(events);
  assert.equal(spans[0].durationMs, null);
});

test('an id-less result is matched to the oldest still-open call', () => {
  const events = [call({ name: 'a' }), call({ name: 'b' }), result({ durationMs: 5 })];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(orphans.length, 0);
  assert.equal(spans[0].call.name, 'a');
  assert.equal(spans[0].result, events[2]);
  assert.equal(spans[1].result, null);
});

test('takeOldestPending skips calls already resolved through the id map', () => {
  const events = [
    call({ id: 'c1', name: 'a' }),
    call({ name: 'b' }),
    result({ id: 'c1' }), // resolves "a" directly through the id map
    result(), // id-less; "a" is resolved, so this must fall through to "b"
  ];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(orphans.length, 0);
  assert.equal(spans[0].result, events[2]);
  assert.equal(spans[1].result, events[3]);
});

test('a result whose id matches nothing is an orphan, not force-fitted', () => {
  const events = [call({ id: 'c1' }), result({ id: 'does-not-exist' })];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].index, 1);
  assert.equal(spans[0].result, null);
  assert.equal(spans[0].ok, null);
});

test('an id-less result with nothing pending is an orphan', () => {
  const events = [result()];
  const { spans, orphans } = pairToolEvents(events);
  assert.equal(spans.length, 0);
  assert.equal(orphans.length, 1);
});

test('a call with no matching result stays pending', () => {
  const events = [call({ id: 'c1' })];
  const { spans } = pairToolEvents(events);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].result, null);
  assert.equal(spans[0].resultIndex, null);
  assert.equal(spans[0].durationMs, null);
  assert.equal(spans[0].ok, null);
});

test('spansByTool groups spans by tool name and preserves call order', () => {
  const events = [
    call({ id: 'c1', name: 'read_file' }),
    call({ id: 'c2', name: 'grep' }),
    call({ id: 'c3', name: 'read_file' }),
    result({ id: 'c1' }),
    result({ id: 'c2' }),
    result({ id: 'c3' }),
  ];
  const { spans } = pairToolEvents(events);
  const byTool = spansByTool(spans);
  assert.deepEqual([...byTool.keys()], ['read_file', 'grep']);
  assert.equal(byTool.get('read_file')?.length, 2);
  assert.equal(byTool.get('read_file')?.[0].callIndex, 0);
  assert.equal(byTool.get('read_file')?.[1].callIndex, 2);
});
