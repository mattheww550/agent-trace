import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatIssue, parseTrace, parseTraceLine, parseTraceStrict } from '../src/parse.ts';

test('parses the canonical field names', () => {
  const result = parseTraceLine('{"type":"tool_call","ts":1767225600950,"id":"c1","name":"read_file","args":{"path":"a"}}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.event, {
    type: 'tool_call',
    ts: 1767225600950,
    id: 'c1',
    name: 'read_file',
    args: { path: 'a' },
  });
});

test('accepts type aliases case-insensitively', () => {
  for (const rawType of ['USER', 'Human', 'prompt', 'input']) {
    const result = parseTraceLine(`{"type":"${rawType}","text":"hi"}`);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.event.type, 'user');
  }
  for (const rawType of ['AI', 'model', 'completion']) {
    const result = parseTraceLine(`{"type":"${rawType}"}`);
    assert.equal(result.ok && result.event.type, 'assistant');
  }
  for (const rawType of ['toolCall', 'tool_use', 'function_call']) {
    const result = parseTraceLine(`{"type":"${rawType}","name":"x"}`);
    assert.equal(result.ok && result.event.type, 'tool_call');
  }
  for (const rawType of ['toolResult', 'tool_output', 'function_result']) {
    const result = parseTraceLine(`{"type":"${rawType}"}`);
    assert.equal(result.ok && result.event.type, 'tool_result');
  }
});

test('falls back through role, event and kind for the type field', () => {
  for (const key of ['role', 'event', 'kind']) {
    const result = parseTraceLine(`{"${key}":"assistant"}`);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.event.type, 'assistant');
  }
});

test('accepts alternate spellings for tool_call fields', () => {
  const result = parseTraceLine(
    '{"type":"tool_call","tool_name":"grep","call_id":"7","arguments":{"q":"foo"}}',
  );
  const event = result.ok ? result.event : null;
  assert.ok(event && event.type === 'tool_call');
  if (!event || event.type !== 'tool_call') return;
  assert.equal(event.id, '7');
  assert.equal(event.name, 'grep');
  assert.deepEqual(event.args, { q: 'foo' });
});

test('accepts alternate spellings for tool_result fields', () => {
  const result = parseTraceLine(
    '{"type":"tool_output","tool_call_id":"7","success":false,"duration_ms":42,"stdout":"boom","err":"boom"}',
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.event, {
    type: 'tool_result',
    ts: null,
    id: '7',
    ok: false,
    durationMs: 42,
    output: 'boom',
    error: 'boom',
  });
});

test('rejects invalid json', () => {
  assert.match(issueMessage('{not json'), /not valid json/);
});

test('rejects a line that is not a json object', () => {
  for (const raw of ['[1,2,3]', '"just a string"', '42', 'null']) {
    assert.match(issueMessage(raw), /expected a json object/);
  }
});

test('rejects a missing or unknown type', () => {
  assert.match(issueMessage('{"text":"hi"}'), /missing "type"/);
  assert.match(issueMessage('{"type":"telemetry"}'), /unknown event type/);
});

test('rejects a tool_call with no usable name', () => {
  assert.match(issueMessage('{"type":"tool_call"}'), /missing a tool name/);
  assert.equal(parseTraceLine('{"type":"tool_call","name":"   "}').ok, false);
});

test('timestamps: epoch seconds are scaled to milliseconds, epoch ms and ISO strings pass through', () => {
  const seconds = parseTraceLine('{"type":"user","ts":1767225600}');
  assert.equal(seconds.ok && seconds.event.ts, 1767225600000);

  const millis = parseTraceLine('{"type":"user","ts":1767225600950}');
  assert.equal(millis.ok && millis.event.ts, 1767225600950);

  const iso = parseTraceLine('{"type":"user","timestamp":"2026-01-01T00:00:00.000Z"}');
  assert.equal(iso.ok && iso.event.ts, Date.parse('2026-01-01T00:00:00.000Z'));

  const bad = parseTraceLine('{"type":"user","ts":"not a date"}');
  assert.equal(bad.ok && bad.event.ts, null);

  const missing = parseTraceLine('{"type":"user"}');
  assert.equal(missing.ok && missing.event.ts, null);
});

test('token usage is read from nested aliases and requires at least one count', () => {
  assert.deepEqual(
    assistantUsage('{"type":"assistant","usage":{"prompt_tokens":10,"completion_tokens":3}}'),
    { input: 10, output: 3 },
  );
  assert.equal(assistantUsage('{"type":"assistant","usage":{}}'), null);
  assert.equal(assistantUsage('{"type":"assistant"}'), null);
});

test('tool_result ok is derived from status text and is_error when not explicit', () => {
  assert.equal(toolResultOk('{"type":"tool_result","status":"failed"}'), false);
  assert.equal(toolResultOk('{"type":"tool_result","is_error":true}'), false);
  assert.equal(toolResultOk('{"type":"tool_result","error":"boom"}'), false);
  assert.equal(toolResultOk('{"type":"tool_result"}'), true);
});

test('text fields flatten arrays of parts and stringify other shapes', () => {
  const fromParts = parseTraceLine('{"type":"user","text":["a","",{"text":"b"},{"other":1}]}');
  assert.equal(fromParts.ok && fromParts.event.type === 'user' && fromParts.event.text, 'a\nb\n{"other":1}');

  const fromNumber = parseTraceLine('{"type":"user","text":5}');
  assert.equal(fromNumber.ok && fromNumber.event.type === 'user' && fromNumber.event.text, '5');
});

test('parseTrace skips blank lines and separates events from issues', () => {
  const text = [
    '{"type":"user","text":"hi"}',
    '',
    '   ',
    'not json',
    '{"type":"assistant","text":"hello"}',
  ].join('\n');

  const { events, issues } = parseTrace(text);
  assert.equal(events.length, 2);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 4);
  assert.equal(issues[0].raw, 'not json');
});

test('parseTraceStrict throws with a summary of the first few issues', () => {
  const text = ['bad1', 'bad2', 'bad3', 'bad4'].join('\n');
  assert.throws(() => parseTraceStrict(text), /4 unusable line\(s\).*and 1 more/s);
});

test('parseTraceStrict returns events untouched when the trace is clean', () => {
  const text = '{"type":"user","text":"hi"}\n{"type":"assistant","text":"hello"}';
  const events = parseTraceStrict(text);
  assert.equal(events.length, 2);
});

test('formatIssue renders a one-line, greppable message', () => {
  const { issues } = parseTrace('nope');
  // JSON.parse's own error text is engine-specific, so only pin down our framing around it.
  assert.match(formatIssue(issues[0]), /^line 1: not valid json \(.+\) -- nope$/);
});

test('long raw lines are truncated in issue reports', () => {
  const long = `not json but very long: ${'x'.repeat(200)}`;
  const { issues } = parseTrace(long);
  assert.equal(issues[0].raw.length, 103);
  assert.ok(issues[0].raw.endsWith('...'));
});

function issueMessage(raw: string): string {
  const result = parseTraceLine(raw);
  if (result.ok) throw new Error(`expected an issue, but line parsed as ${JSON.stringify(result.event)}`);
  return result.issue.message;
}

function assistantUsage(raw: string) {
  const result = parseTraceLine(raw);
  const event = result.ok ? result.event : null;
  if (!event || event.type !== 'assistant') throw new Error(`expected an assistant event, got ${JSON.stringify(result)}`);
  return event.usage;
}

function toolResultOk(raw: string) {
  const result = parseTraceLine(raw);
  const event = result.ok ? result.event : null;
  if (!event || event.type !== 'tool_result') throw new Error(`expected a tool_result event, got ${JSON.stringify(result)}`);
  return event.ok;
}
