import type { ToolCallEvent, ToolResultEvent, TraceEvent } from './types.ts';

/** A tool call together with the result it was matched to, if any. */
export interface ToolSpan {
  call: ToolCallEvent;
  callIndex: number;
  result: ToolResultEvent | null;
  resultIndex: number | null;
  /** Reported duration, or the timestamp delta, or null when neither is usable. */
  durationMs: number | null;
  /** null while the call has no result (the run was cut short). */
  ok: boolean | null;
}

export interface OrphanResult {
  event: ToolResultEvent;
  index: number;
}

export interface PairedTrace {
  spans: ToolSpan[];
  orphans: OrphanResult[];
}

/**
 * Match tool results back to their calls.
 *
 * Correlation ids win when both sides have one. A result without an id is
 * matched to the oldest still-open call, which is what sequential agents
 * produce. A result whose id matches nothing becomes an orphan rather than
 * being force-fitted onto an unrelated call.
 */
export function pairToolEvents(events: readonly TraceEvent[]): PairedTrace {
  const spans: ToolSpan[] = [];
  const orphans: OrphanResult[] = [];
  const byId = new Map<string, ToolSpan>();
  const pending: ToolSpan[] = [];

  const takeOldestPending = (): ToolSpan | null => {
    while (pending.length > 0) {
      const span = pending[0];
      if (span.result === null) return span;
      pending.shift();
    }
    return null;
  };

  events.forEach((event, index) => {
    if (event.type === 'tool_call') {
      const span: ToolSpan = {
        call: event,
        callIndex: index,
        result: null,
        resultIndex: null,
        durationMs: null,
        ok: null,
      };
      spans.push(span);
      pending.push(span);
      if (event.id !== null && !byId.has(event.id)) byId.set(event.id, span);
      return;
    }
    if (event.type !== 'tool_result') return;

    if (event.id !== null) {
      const span = byId.get(event.id);
      if (span && span.result === null) {
        attach(span, event, index);
        byId.delete(event.id);
        return;
      }
      orphans.push({ event, index });
      return;
    }

    const span = takeOldestPending();
    if (!span) {
      orphans.push({ event, index });
      return;
    }
    attach(span, event, index);
    if (span.call.id !== null) byId.delete(span.call.id);
  });

  return { spans, orphans };
}

/** Group spans by tool name, preserving call order inside each group. */
export function spansByTool(spans: readonly ToolSpan[]): Map<string, ToolSpan[]> {
  const out = new Map<string, ToolSpan[]>();
  for (const span of spans) {
    const bucket = out.get(span.call.name);
    if (bucket) bucket.push(span);
    else out.set(span.call.name, [span]);
  }
  return out;
}

function attach(span: ToolSpan, result: ToolResultEvent, index: number): void {
  span.result = result;
  span.resultIndex = index;
  span.ok = result.ok;
  span.durationMs = durationOf(span.call, result);
}

function durationOf(call: ToolCallEvent, result: ToolResultEvent): number | null {
  if (result.durationMs !== null) return result.durationMs;
  if (call.ts === null || result.ts === null) return null;
  const delta = result.ts - call.ts;
  // Negative deltas mean the clocks disagree; reporting them as durations
  // would silently corrupt every aggregate, so drop them instead.
  return delta >= 0 ? delta : null;
}
