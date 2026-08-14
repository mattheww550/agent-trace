# agent-trace

Agent runtimes log what they did as JSONL: one line per user message, assistant
message, tool call and tool result. That file is the only record of *why* a run
took 40 seconds or burned 200k tokens, and reading it by hand is miserable.

`agent-trace` turns such a file into two things: a summary (where the time and
the tokens went) and a timeline (what actually happened, in order). It is a
library plus a small CLI, with zero runtime dependencies -- Node built-ins only.

The parser is deliberately forgiving. Field names differ between runtimes
(`ts` / `timestamp`, `name` / `tool`, `args` / `arguments`, `role` / `type`), so
those are all accepted, and a line it cannot understand is reported with its line
number instead of aborting the run.

## Install

```bash
npm install
npm run build
```

Requires Node 22 or newer.

## Trace format

One JSON object per line. Only `type` is mandatory:

```jsonl
{"type":"user","ts":1767225600000,"text":"the parse test fails on windows"}
{"type":"assistant","ts":1767225600900,"text":"let me look","usage":{"input_tokens":1180,"output_tokens":96}}
{"type":"tool_call","ts":1767225600950,"id":"c1","name":"read_file","args":{"path":"src/parse.ts"}}
{"type":"tool_result","ts":1767225601004,"id":"c1","ok":true,"durationMs":54,"output":"1.9 kB read"}
```

Results are matched to calls by `id`. When a result has no `id` it is matched to
the oldest still-open call, which is what sequential agents produce. A result
whose `id` matches nothing is reported as an orphan rather than being attached to
an unrelated call. Durations come from `durationMs` when present, otherwise from
the timestamp delta.

## CLI

```bash
# where did the time go?
node dist/cli.js stats examples/session.jsonl

# what happened, in order?
node dist/cli.js show examples/session.jsonl --max-arg=48

# only one tool
node dist/cli.js show examples/session.jsonl --tool=run_tests
```

`stats` on the bundled example prints:

```
events        17  (user 1, assistant 4, tool_call 6, tool_result 6)
wall clock    7.400s
tool time     3.728s  (50.4% of wall clock)
tool calls    6  (6 completed, 0 pending, 1 failed = 16.7% failure rate)
tokens        10330 in / 536 out = 10866 total

tool         calls  fail   total     avg     max  share
run_tests        2     1  3.515s  1.758s  1.760s  94.3%
apply_patch      2     0   118ms    59ms    60ms   3.2%
read_file        2     0    95ms    48ms    54ms   2.5%
```

### Commands and options

| | |
|---|---|
| `stats <file>` | totals, per-tool timing, token usage |
| `show <file>` | indented timeline of the session |
| `--json` | print stats as JSON instead of a table (`stats` only) |
| `--tool=<name>` | restrict `show` to a single tool |
| `--max-arg=<n>` | truncate tool arguments to n characters (default 80) |
| `--no-text` | hide user and assistant messages |
| `--strict` | exit 1 if any line failed to parse |
| `-h, --help` | usage |
| `--version` | version |

Pass `-` as the file to read the trace from stdin. Exit codes: `0` success,
`1` nothing usable in the trace (or `--strict` with bad lines), `2` bad usage.

## Library

```ts
import { computeStats, parseTrace, renderTimeline } from 'agent-trace';
import { readFileSync } from 'node:fs';

const { events, issues } = parseTrace(readFileSync('session.jsonl', 'utf8'));
if (issues.length > 0) {
  console.warn(`skipping ${issues.length} unusable line(s)`);
}

const stats = computeStats(events);
const slowest = stats.tools[0];
console.log(`${slowest.name}: ${slowest.calls} calls, ${slowest.totalMs} ms`);

console.log(renderTimeline(events, { tool: 'run_tests', maxArgLength: 40 }));
```

### API

- `parseTrace(text): { events, issues }` -- never throws; unusable lines land in
  `issues` as `{ line, message, raw }`.
- `parseTraceStrict(text): TraceEvent[]` -- throws if anything was unusable.
- `parseTraceLine(raw, line?): LineResult` -- single line, for streaming callers.
- `pairToolEvents(events): { spans, orphans }` -- calls matched to their results,
  each span carrying `durationMs` and `ok`.
- `computeStats(events): TraceStats` -- wall clock, tool time, per-tool
  `calls / failures / totalMs / avgMs / maxMs / timeShare`, token totals,
  pending calls and orphan results.
- `renderTimeline(events, options?): string` -- the timeline text.
- `renderStats(stats): string` -- the summary text.

`computeStats` and `renderTimeline` are pure functions over the parsed events, so
they are equally happy with events you built yourself.

## Test

```bash
npm test
```

## License

MIT (c) mattheww550
