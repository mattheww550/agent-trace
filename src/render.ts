import { pairToolEvents } from './pair.ts';
import type { ToolSpan } from './pair.ts';
import type { ToolStats, TraceStats } from './stats.ts';
import type { TraceEvent } from './types.ts';

export interface RenderTimelineOptions {
  /** Show only calls (and their results) to this tool. */
  tool?: string;
  /** Truncate JSON-encoded tool_call args to this many characters. Default 80. */
  maxArgLength?: number;
  /** Include user and assistant text lines. Default true. */
  includeText?: boolean;
}

const LABEL_WIDTH = 14;

/**
 * Render the summary block: totals, wall clock, tool time and the per-tool table.
 */
export function renderStats(stats: TraceStats): string {
  const label = (s: string): string => s.padEnd(LABEL_WIDTH);
  const byType = stats.byType;
  const lines: string[] = [];

  lines.push(
    `${label('events')}${stats.events}  (user ${byType.user}, assistant ${byType.assistant}, ` +
      `tool_call ${byType.tool_call}, tool_result ${byType.tool_result})`,
  );

  lines.push(`${label('wall clock')}${stats.wallClockMs === null ? '--' : formatDuration(stats.wallClockMs)}`);

  const toolTimeShare = stats.wallClockMs !== null && stats.wallClockMs > 0 ? stats.toolTimeMs / stats.wallClockMs : null;
  const toolTimeSuffix = toolTimeShare === null ? '' : `  (${formatPercent(toolTimeShare)} of wall clock)`;
  lines.push(`${label('tool time')}${formatDuration(stats.toolTimeMs)}${toolTimeSuffix}`);

  lines.push(
    `${label('tool calls')}${stats.toolCalls}  (${stats.toolCompleted} completed, ${stats.pendingCalls} pending, ` +
      `${stats.toolFailures} failed = ${formatPercent(stats.failureRate)} failure rate)`,
  );

  lines.push(`${label('tokens')}${stats.tokens.input} in / ${stats.tokens.output} out = ${stats.tokens.total} total`);

  if (stats.tools.length > 0) {
    lines.push('');
    lines.push(...renderToolTable(stats.tools));
  }

  return lines.join('\n');
}

function renderToolTable(tools: readonly ToolStats[]): string[] {
  const headers = ['tool', 'calls', 'fail', 'total', 'avg', 'max', 'share'];
  const rows = tools.map((t) => [
    t.name,
    String(t.calls),
    String(t.failures),
    formatDuration(t.totalMs),
    t.avgMs === null ? '--' : formatDuration(t.avgMs),
    t.maxMs === null ? '--' : formatDuration(t.maxMs),
    formatPercent(t.timeShare),
  ]);

  const widths = headers.map((header, col) => Math.max(header.length, ...rows.map((row) => row[col].length)));

  const formatRow = (cells: readonly string[]): string =>
    cells
      .map((cell, col) => (col === 0 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])))
      .join('  ')
      .trimEnd();

  return [formatRow(headers), ...rows.map(formatRow)];
}

/**
 * Render the chronological timeline. Tool results are folded into the line for
 * their call rather than printed again; a result that could not be matched to a
 * call (see {@link pairToolEvents}) is shown on its own as an orphan.
 */
export function renderTimeline(events: readonly TraceEvent[], options: RenderTimelineOptions = {}): string {
  const maxArgLength = options.maxArgLength ?? 80;
  const includeText = options.includeText ?? true;
  const toolFilter = options.tool;

  const { spans } = pairToolEvents(events);
  const spanByCallIndex = new Map<number, ToolSpan>();
  const resultIndicesInSpans = new Set<number>();
  for (const span of spans) {
    spanByCallIndex.set(span.callIndex, span);
    if (span.resultIndex !== null) resultIndicesInSpans.add(span.resultIndex);
  }

  const lines: string[] = [];

  events.forEach((event, index) => {
    if (resultIndicesInSpans.has(index)) return; // already printed alongside its call

    if (event.type === 'tool_call') {
      if (toolFilter !== undefined && event.name !== toolFilter) return;
      const span = spanByCallIndex.get(index);
      if (span) lines.push(formatToolLine(span, maxArgLength));
      return;
    }

    if (event.type === 'tool_result') {
      if (toolFilter !== undefined) return; // an orphan has no tool name to filter on
      const detail = event.error ?? event.output;
      lines.push(`${formatTs(event.ts)}  ! orphan result${event.id ? ` (id ${event.id})` : ''}: ${firstLine(detail)}`);
      return;
    }

    if (toolFilter !== undefined || !includeText) return;

    if (event.type === 'user') {
      lines.push(`${formatTs(event.ts)}  user: ${firstLine(event.text)}`);
    } else {
      const usage = event.usage ? `  (${event.usage.input} in / ${event.usage.output} out)` : '';
      lines.push(`${formatTs(event.ts)}  assistant: ${firstLine(event.text)}${usage}`);
    }
  });

  return lines.join('\n');
}

function formatToolLine(span: ToolSpan, maxArgLength: number): string {
  const ts = formatTs(span.call.ts);
  const args = formatArgs(span.call.args, maxArgLength);
  const status = span.result === null ? 'pending' : span.ok ? 'ok' : 'FAILED';
  const duration = span.durationMs === null ? '' : `  ${formatDuration(span.durationMs)}`;
  return `${ts}  tool ${span.call.name}(${args})  -> ${status}${duration}`;
}

function formatArgs(args: unknown, maxArgLength: number): string {
  if (args === undefined) return '';
  let text: string;
  try {
    text = JSON.stringify(args) ?? '';
  } catch {
    text = String(args);
  }
  return text.length > maxArgLength ? `${text.slice(0, maxArgLength)}...` : text;
}

/** Collapse multi-line text down to its first line, for one-line-per-event display. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : `${text.slice(0, newline)}...`;
}

function formatTs(ts: number | null): string {
  if (ts === null) return '--:--:--';
  return new Date(ts).toISOString().slice(11, 19);
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(3)}s` : `${Math.round(ms)}ms`;
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
