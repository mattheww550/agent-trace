import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTrace } from '../src/parse.ts';
import { renderStats, renderTimeline } from '../src/render.ts';
import type { ToolStats, TraceStats } from '../src/stats.ts';
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

function toolStats(overrides: Partial<ToolStats> = {}): ToolStats {
  return { name: 'read_file', calls: 0, completed: 0, failures: 0, totalMs: 0, avgMs: null, maxMs: null, timeShare: 0, ...overrides };
}

function traceStats(overrides: Partial<TraceStats> = {}): TraceStats {
  return {
    events: 0,
    byType: { user: 0, assistant: 0, tool_call: 0, tool_result: 0 },
    firstTs: null,
    lastTs: null,
    wallClockMs: null,
    toolTimeMs: 0,
    tools: [],
    toolCalls: 0,
    toolCompleted: 0,
    toolFailures: 0,
    failureRate: 0,
    pendingCalls: 0,
    orphanResults: 0,
    tokens: { input: 0, output: 0, total: 0 },
    ...overrides,
  };
}

test('renderTimeline turns a parsed trace into one line per event, folding a result into its call', () => {
  const raw = [
    '{"type":"user","ts":1767225600000,"text":"the parse test fails on windows"}',
    '{"type":"assistant","ts":1767225600900,"text":"let me look","usage":{"input_tokens":1180,"output_tokens":96}}',
    '{"type":"tool_call","ts":1767225600950,"id":"c1","name":"read_file","args":{"path":"src/parse.ts"}}',
    '{"type":"tool_result","ts":1767225601004,"id":"c1","ok":true,"durationMs":54,"output":"1.9 kB read"}',
  ].join('\n');
  const { events } = parseTrace(raw);

  assert.equal(
    renderTimeline(events),
    [
      '00:00:00  user: the parse test fails on windows',
      '00:00:00  assistant: let me look  (1180 in / 96 out)',
      '00:00:00  tool read_file({"path":"src/parse.ts"})  -> ok  54ms',
    ].join('\n'),
  );
});

test('renderTimeline shows failed calls with a derived duration, pending calls with none, and unmatched results as orphans', () => {
  const events: TraceEvent[] = [
    user({ ts: 0, text: 'hi' }),
    call({ ts: 1000, id: 'a', name: 'run_tests', args: { n: 5 } }),
    result({ ts: 2000, id: 'a', ok: false, error: 'boom' }),
    call({ ts: 3000, id: 'b', name: 'read_file', args: undefined }),
    result({ ts: 4000, id: 'zzz', ok: true, output: 'lonely' }),
  ];

  assert.equal(
    renderTimeline(events),
    [
      '00:00:00  user: hi',
      '00:00:01  tool run_tests({"n":5})  -> FAILED  1.000s',
      '00:00:03  tool read_file()  -> pending',
      '00:00:04  ! orphan result (id zzz): lonely',
    ].join('\n'),
  );
});

test('the --tool filter keeps only matching calls and drops text lines and orphan results', () => {
  const events: TraceEvent[] = [
    user({ ts: 0, text: 'hi' }),
    call({ ts: 1000, id: 'a', name: 'run_tests', args: { n: 5 } }),
    result({ ts: 2000, id: 'a', ok: false, error: 'boom' }),
    call({ ts: 3000, id: 'b', name: 'read_file', args: undefined }),
    result({ ts: 4000, id: 'zzz', ok: true, output: 'lonely' }),
  ];

  assert.equal(renderTimeline(events, { tool: 'run_tests' }), '00:00:01  tool run_tests({"n":5})  -> FAILED  1.000s');
});

test('includeText: false hides user and assistant lines but keeps tool lines', () => {
  const events: TraceEvent[] = [
    user({ ts: 0, text: 'hi' }),
    assistant({ ts: 500, text: 'looking' }),
    call({ ts: 1000, id: 'a', name: 'grep', args: undefined }),
    result({ ts: 1010, id: 'a', ok: true, durationMs: 10 }),
  ];

  assert.equal(renderTimeline(events, { includeText: false }), '00:00:01  tool grep()  -> ok  10ms');
});

test('tool args longer than maxArgLength are truncated with an ellipsis', () => {
  const bigArgs = { a: 'y'.repeat(75) };
  const full = JSON.stringify(bigArgs);
  assert.ok(full.length > 80);
  const events: TraceEvent[] = [call({ ts: 0, id: 'a', args: bigArgs })];

  assert.equal(renderTimeline(events), `00:00:00  tool read_file(${full.slice(0, 80)}...)  -> pending`);
  assert.equal(
    renderTimeline(events, { maxArgLength: full.length }),
    `00:00:00  tool read_file(${full})  -> pending`,
  );
});

test('a missing timestamp renders as --:--:--', () => {
  const events: TraceEvent[] = [user({ ts: null, text: 'no clock' })];
  assert.equal(renderTimeline(events), '--:--:--  user: no clock');
});

test('renderStats: a trace with no events produces zeroed lines and no tool table', () => {
  assert.equal(
    renderStats(traceStats()),
    [
      'events        0  (user 0, assistant 0, tool_call 0, tool_result 0)',
      'wall clock    --',
      'tool time     0ms',
      'tool calls    0  (0 completed, 0 pending, 0 failed = 0.0% failure rate)',
      'tokens        0 in / 0 out = 0 total',
    ].join('\n'),
  );
});

test('renderStats: tool time is shown as a percentage of wall clock only when both are known', () => {
  const withWallClock = renderStats(traceStats({ wallClockMs: 2000, toolTimeMs: 1000 })).split('\n');
  assert.equal(withWallClock[2], 'tool time     1.000s  (50.0% of wall clock)');

  const withoutWallClock = renderStats(traceStats({ wallClockMs: null, toolTimeMs: 1000 })).split('\n');
  assert.equal(withoutWallClock[2], 'tool time     1.000s');
});

test('renderStats reproduces the documented example output, including the aligned tool table', () => {
  const stats = traceStats({
    events: 17,
    byType: { user: 1, assistant: 4, tool_call: 6, tool_result: 6 },
    wallClockMs: 7400,
    toolTimeMs: 3728,
    tools: [
      toolStats({ name: 'run_tests', calls: 2, completed: 2, failures: 1, totalMs: 3515, avgMs: 1758, maxMs: 1760, timeShare: 3515 / 3728 }),
      toolStats({ name: 'apply_patch', calls: 2, completed: 2, failures: 0, totalMs: 118, avgMs: 59, maxMs: 60, timeShare: 118 / 3728 }),
      toolStats({ name: 'read_file', calls: 2, completed: 2, failures: 0, totalMs: 95, avgMs: 48, maxMs: 54, timeShare: 95 / 3728 }),
    ],
    toolCalls: 6,
    toolCompleted: 6,
    toolFailures: 1,
    failureRate: 1 / 6,
    tokens: { input: 10330, output: 536, total: 10866 },
  });

  assert.equal(
    renderStats(stats),
    [
      'events        17  (user 1, assistant 4, tool_call 6, tool_result 6)',
      'wall clock    7.400s',
      'tool time     3.728s  (50.4% of wall clock)',
      'tool calls    6  (6 completed, 0 pending, 1 failed = 16.7% failure rate)',
      'tokens        10330 in / 536 out = 10866 total',
      '',
      'tool         calls  fail   total     avg     max  share',
      'run_tests        2     1  3.515s  1.758s  1.760s  94.3%',
      'apply_patch      2     0   118ms    59ms    60ms   3.2%',
      'read_file        2     0    95ms    48ms    54ms   2.5%',
    ].join('\n'),
  );
});
