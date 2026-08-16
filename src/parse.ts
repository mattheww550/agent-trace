import type {
  AssistantEvent,
  ParsedTrace,
  TokenUsage,
  ToolCallEvent,
  ToolResultEvent,
  TraceEvent,
  TraceEventType,
  TraceIssue,
  UserEvent,
} from './types.ts';

/** How much of a bad line is kept in the issue report. */
const RAW_PREVIEW = 100;

/**
 * Different agent runtimes spell the event kinds differently. Keys are compared
 * lowercased, so `toolCall` and `TOOL_CALL` both land on `toolcall` / `tool_call`.
 */
const TYPE_ALIASES: Record<string, TraceEventType> = {
  user: 'user',
  human: 'user',
  prompt: 'user',
  input: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  model: 'assistant',
  completion: 'assistant',
  tool_call: 'tool_call',
  toolcall: 'tool_call',
  tool_use: 'tool_call',
  tooluse: 'tool_call',
  function_call: 'tool_call',
  tool_result: 'tool_result',
  toolresult: 'tool_result',
  tool_output: 'tool_result',
  tooloutput: 'tool_result',
  function_result: 'tool_result',
};

const TS_KEYS = ['ts', 'timestamp', 'time', 'at', 'started_at', 'startedAt'] as const;
const TEXT_KEYS = ['text', 'content', 'message', 'body'] as const;
const NAME_KEYS = ['name', 'tool', 'tool_name', 'toolName', 'function'] as const;
const ID_KEYS = ['id', 'call_id', 'callId', 'tool_call_id', 'toolCallId'] as const;
const ARG_KEYS = ['args', 'arguments', 'input', 'params', 'parameters'] as const;
const OUTPUT_KEYS = ['output', 'result', 'content', 'text', 'stdout'] as const;
const USAGE_KEYS = ['usage', 'tokens', 'token_usage', 'tokenUsage'] as const;

export type LineResult = { ok: true; event: TraceEvent } | { ok: false; issue: TraceIssue };

/**
 * Parse a whole trace. Blank lines are skipped; every other line either yields
 * an event or an issue, so `events.length + issues.length` accounts for all of
 * the non-blank input.
 */
export function parseTrace(text: string): ParsedTrace {
  const events: TraceEvent[] = [];
  const issues: TraceIssue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const result = parseTraceLine(raw, i + 1);
    if (result.ok) events.push(result.event);
    else issues.push(result.issue);
  }
  return { events, issues };
}

/** Like {@link parseTrace}, but refuses to return a partially understood trace. */
export function parseTraceStrict(text: string): TraceEvent[] {
  const { events, issues } = parseTrace(text);
  if (issues.length > 0) {
    const head = issues.slice(0, 3).map(formatIssue).join('; ');
    const more = issues.length > 3 ? `; and ${issues.length - 3} more` : '';
    throw new Error(`invalid trace: ${issues.length} unusable line(s): ${head}${more}`);
  }
  return events;
}

export function formatIssue(issue: TraceIssue): string {
  return `line ${issue.line}: ${issue.message} -- ${issue.raw}`;
}

/** Parse one JSONL line. `line` is only used for error reporting. */
export function parseTraceLine(raw: string, line = 1): LineResult {
  const bad = (message: string): LineResult => ({
    ok: false,
    issue: { line, message, raw: truncateRaw(raw) },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return bad(`not valid json (${(err as Error).message})`);
  }

  const rec = asRecord(parsed);
  if (!rec) return bad(`expected a json object, got ${describe(parsed)}`);

  const rawType = rec['type'] ?? rec['role'] ?? rec['event'] ?? rec['kind'];
  if (typeof rawType !== 'string' || rawType.trim() === '') {
    return bad('missing "type" (or "role") field');
  }
  const type = TYPE_ALIASES[rawType.trim().toLowerCase()];
  if (!type) return bad(`unknown event type "${rawType}"`);

  const ts = asTimestamp(pick(rec, TS_KEYS));

  if (type === 'user') {
    const event: UserEvent = { type: 'user', ts, text: asText(pick(rec, TEXT_KEYS)) };
    return { ok: true, event };
  }

  if (type === 'assistant') {
    const event: AssistantEvent = {
      type: 'assistant',
      ts,
      text: asText(pick(rec, TEXT_KEYS)),
      usage: asUsage(pick(rec, USAGE_KEYS)),
    };
    return { ok: true, event };
  }

  if (type === 'tool_call') {
    const name = pick(rec, NAME_KEYS);
    if (typeof name !== 'string' || name.trim() === '') {
      return bad('tool_call is missing a tool name');
    }
    const event: ToolCallEvent = {
      type: 'tool_call',
      ts,
      id: asId(pick(rec, ID_KEYS)),
      name: name.trim(),
      args: pick(rec, ARG_KEYS),
    };
    return { ok: true, event };
  }

  const error = asErrorText(rec['error'] ?? rec['err'] ?? rec['message_error']);
  const event: ToolResultEvent = {
    type: 'tool_result',
    ts,
    id: asId(pick(rec, ID_KEYS)),
    ok: asOk(rec, error),
    durationMs: asDuration(pick(rec, ['durationMs', 'duration_ms', 'duration', 'elapsed_ms', 'elapsedMs'])),
    output: asText(pick(rec, OUTPUT_KEYS)),
    error,
  };
  return { ok: true, event };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pick(rec: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = rec[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Flatten anything a runtime might have put in a text field into a string. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        const rec = asRecord(part);
        const text = rec ? rec['text'] : undefined;
        return typeof text === 'string' ? text : safeJson(part);
      })
      .filter((part) => part !== '')
      .join('\n');
  }
  return safeJson(value);
}

function asErrorText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  const rec = asRecord(value);
  const message = rec ? rec['message'] : undefined;
  if (typeof message === 'string') return message;
  return safeJson(value);
}

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Timestamps come as epoch milliseconds, epoch seconds or ISO strings.
 * Anything in the plausible epoch-seconds window is scaled up; smaller numbers
 * are treated as an offset that is already in milliseconds.
 */
function asTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1e9 && value < 1e11 ? Math.round(value * 1000) : value;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asDuration(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function asUsage(value: unknown): TokenUsage | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const input = asCount(pick(rec, ['input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens']));
  const output = asCount(pick(rec, ['output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens']));
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

function asCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** `ok` is true unless something says otherwise. */
function asOk(rec: Record<string, unknown>, error: string | null): boolean {
  const explicit = pick(rec, ['ok', 'success', 'succeeded']);
  if (typeof explicit === 'boolean') return explicit;
  const status = pick(rec, ['status', 'state']);
  if (typeof status === 'string') {
    const s = status.toLowerCase();
    if (s === 'ok' || s === 'success' || s === 'succeeded' || s === 'completed') return true;
    if (s === 'error' || s === 'failed' || s === 'failure' || s === 'timeout') return false;
  }
  const isError = pick(rec, ['is_error', 'isError']);
  if (typeof isError === 'boolean') return !isError;
  return error === null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function truncateRaw(raw: string): string {
  const flat = raw.trim();
  return flat.length <= RAW_PREVIEW ? flat : `${flat.slice(0, RAW_PREVIEW)}...`;
}
