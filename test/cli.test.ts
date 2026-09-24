import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseArgs, run } from '../src/cli.ts';
import { parseTrace } from '../src/parse.ts';
import { renderStats, renderTimeline } from '../src/render.ts';
import { computeStats } from '../src/stats.ts';

const FIXTURE = 'test/fixtures/sample.jsonl';
const BAD_LINES_FIXTURE = 'test/fixtures/bad-lines.jsonl';
const ALL_BAD_FIXTURE = 'test/fixtures/all-bad.jsonl';

function packageVersion(): string {
  return (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
}

test('parseArgs rejects a missing or unknown command', () => {
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(['bogus', 'file.jsonl']).ok, false);
});

test('parseArgs requires a file and rejects a second positional argument', () => {
  const missing = parseArgs(['stats']);
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.message : '', /missing <file>/);

  const extra = parseArgs(['stats', 'a.jsonl', 'b.jsonl']);
  assert.equal(extra.ok, false);
  assert.match(!extra.ok ? extra.message : '', /unexpected argument/);
});

test('parseArgs rejects unknown options and bad --max-arg values', () => {
  assert.equal(parseArgs(['show', 'a.jsonl', '--bogus']).ok, false);
  assert.equal(parseArgs(['show', 'a.jsonl', '--max-arg=nope']).ok, false);
  assert.equal(parseArgs(['show', 'a.jsonl', '--max-arg=-1']).ok, false);
});

test('parseArgs reads every show option', () => {
  const parsed = parseArgs(['show', 'a.jsonl', '--tool=grep', '--max-arg=10', '--no-text', '--strict']);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.options, {
    command: 'show',
    file: 'a.jsonl',
    json: false,
    tool: 'grep',
    maxArgLength: 10,
    noText: true,
    strict: true,
  });
});

test('run() with no arguments or -h/--help prints usage and exits 0', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const argvs: string[][] = [[], ['-h'], ['--help']];
  for (const argv of argvs) {
    log.mock.resetCalls();
    const code = run(argv);
    assert.equal(code, 0);
    assert.equal(log.mock.calls.length, 1);
    assert.match(String(log.mock.calls[0].arguments[0]), /^Usage: agent-trace/);
  }
});

test('run() --version prints the version from package.json', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const code = run(['--version']);
  assert.equal(code, 0);
  assert.equal(log.mock.calls[0].arguments[0], packageVersion());
});

test('run() rejects an unknown command with exit code 2', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const code = run(['bogus', 'a.jsonl']);
  assert.equal(code, 2);
  assert.match(String(error.mock.calls[0].arguments[0]), /unknown command/);
});

test('run() reports a file it cannot read with exit code 2', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const code = run(['stats', 'test/fixtures/does-not-exist.jsonl']);
  assert.equal(code, 2);
  assert.match(String(error.mock.calls[0].arguments[0]), /cannot read/);
});

test('run() stats prints exactly what renderStats produces for the parsed file', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const code = run(['stats', FIXTURE]);
  const { events } = parseTrace(readFileSync(FIXTURE, 'utf8'));
  assert.equal(code, 0);
  assert.equal(log.mock.calls[0].arguments[0], renderStats(computeStats(events)));
});

test('run() stats --json prints the stats object as indented JSON', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const code = run(['stats', FIXTURE, '--json']);
  const { events } = parseTrace(readFileSync(FIXTURE, 'utf8'));
  assert.equal(code, 0);
  assert.equal(log.mock.calls[0].arguments[0], JSON.stringify(computeStats(events), null, 2));
});

test('run() show prints exactly what renderTimeline produces, honoring its options', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const code = run(['show', FIXTURE, '--tool=read_file', '--max-arg=5', '--no-text']);
  const { events } = parseTrace(readFileSync(FIXTURE, 'utf8'));
  assert.equal(code, 0);
  assert.equal(
    log.mock.calls[0].arguments[0],
    renderTimeline(events, { tool: 'read_file', maxArgLength: 5, includeText: false }),
  );
});

test('run() reports parse issues to stderr, and only fails the run under --strict', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const log = t.mock.method(console, 'log', () => {});

  const lenient = run(['stats', BAD_LINES_FIXTURE]);
  assert.equal(lenient, 0);
  assert.ok(error.mock.calls.length > 0);
  assert.equal(log.mock.calls.length, 1);

  error.mock.resetCalls();
  log.mock.resetCalls();

  const strict = run(['stats', BAD_LINES_FIXTURE, '--strict']);
  assert.equal(strict, 1);
  assert.equal(log.mock.calls.length, 0);
});

test('run() exits 1 when a trace has no usable events', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const code = run(['stats', ALL_BAD_FIXTURE]);
  assert.equal(code, 1);
  assert.ok(error.mock.calls.some((call) => /no usable events/.test(String(call.arguments[0]))));
});
