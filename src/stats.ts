import { pairToolEvents } from './pair.ts';
import type { ToolSpan } from './pair.ts';
import type { TraceEvent, TraceEventType } from './types.ts';

export interface ToolStats {
  name: string;
  /** Number of tool_call events for this tool. */
  calls: number;
  /** Calls that got a result back. */
  completed: number;
  failures: number;
  /** Sum of the durations that could be determined. */
  totalMs: number;
  avgMs: number | null;
  maxMs: number | null;
  /** Fraction of all measured tool time spent in this tool, 0..1. */
  timeShare: number;
}

export interface TraceStats {
  events: number;
  byType: Record<TraceEventType, number>;
  firstTs: number | null;
  lastTs: number | null;
  /** Span between the first and last timestamped event. */
  wallClockMs: number | null;
  /** Sum of all measured tool durations. */
  toolTimeMs: number;
  tools: ToolStats[];
  toolCalls: number;
  toolCompleted: number;
  toolFailures: number;
  /** Failures divided by completed calls, 0..1. */
  failureRate: number;
  /** Calls that never got a result. */
  pendingCalls: number;
  /** Results that could not be attributed to a call. */
  orphanResults: number;
  tokens: { input: number; output: number; total: number };
}

/** Aggregate a parsed trace. Pure: it never touches the filesystem or clock. */
export function computeStats(events: readonly TraceEvent[]): TraceStats {
  const byType: Record<TraceEventType, number> = {
    user: 0,
    assistant: 0,
    tool_call: 0,
    tool_result: 0,
  };

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let input = 0;
  let output = 0;

  for (const event of events) {
    byType[event.type] += 1;
    if (event.ts !== null) {
      if (firstTs === null || event.ts < firstTs) firstTs = event.ts;
      if (lastTs === null || event.ts > lastTs) lastTs = event.ts;
    }
    if (event.type === 'assistant' && event.usage) {
      input += event.usage.input;
      output += event.usage.output;
    }
  }

  const { spans, orphans } = pairToolEvents(events);
  const toolTimeMs = spans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0);
  const tools = summariseTools(spans, toolTimeMs);

  const toolCompleted = spans.filter((span) => span.result !== null).length;
  const toolFailures = spans.filter((span) => span.ok === false).length;

  return {
    events: events.length,
    byType,
    firstTs,
    lastTs,
    wallClockMs: firstTs === null || lastTs === null ? null : lastTs - firstTs,
    toolTimeMs,
    tools,
    toolCalls: spans.length,
    toolCompleted,
    toolFailures,
    failureRate: toolCompleted === 0 ? 0 : toolFailures / toolCompleted,
    pendingCalls: spans.length - toolCompleted,
    orphanResults: orphans.length,
    tokens: { input, output, total: input + output },
  };
}

function summariseTools(spans: readonly ToolSpan[], toolTimeMs: number): ToolStats[] {
  const acc = new Map<string, ToolStats & { measured: number }>();

  for (const span of spans) {
    const name = span.call.name;
    let row = acc.get(name);
    if (!row) {
      row = {
        name,
        calls: 0,
        completed: 0,
        failures: 0,
        totalMs: 0,
        avgMs: null,
        maxMs: null,
        timeShare: 0,
        measured: 0,
      };
      acc.set(name, row);
    }
    row.calls += 1;
    if (span.result !== null) row.completed += 1;
    if (span.ok === false) row.failures += 1;
    if (span.durationMs !== null) {
      row.totalMs += span.durationMs;
      row.measured += 1;
      row.maxMs = row.maxMs === null ? span.durationMs : Math.max(row.maxMs, span.durationMs);
    }
  }

  const rows: ToolStats[] = [];
  for (const row of acc.values()) {
    rows.push({
      name: row.name,
      calls: row.calls,
      completed: row.completed,
      failures: row.failures,
      totalMs: row.totalMs,
      avgMs: row.measured === 0 ? null : row.totalMs / row.measured,
      maxMs: row.maxMs,
      timeShare: toolTimeMs === 0 ? 0 : row.totalMs / toolTimeMs,
    });
  }

  rows.sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls || a.name.localeCompare(b.name));
  return rows;
}
