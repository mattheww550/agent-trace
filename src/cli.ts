#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatIssue, parseTrace } from './parse.ts';
import { renderStats, renderTimeline } from './render.ts';
import { computeStats } from './stats.ts';

const USAGE = `Usage: agent-trace <command> <file> [options]

Commands:
  stats <file>   totals, per-tool timing, token usage
  show <file>    indented timeline of the session

Options:
  --json         print stats as JSON instead of a table (stats only)
  --tool=<name>  restrict show to a single tool
  --max-arg=<n>  truncate tool arguments to n characters (default 80)
  --no-text      hide user and assistant messages
  --strict       exit 1 if any line failed to parse
  -h, --help     usage
  --version      version

Pass "-" as the file to read the trace from stdin.`;

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

interface Options {
  command: 'stats' | 'show';
  file: string;
  json: boolean;
  tool?: string;
  maxArgLength?: number;
  noText: boolean;
  strict: boolean;
}

type ParsedArgs = { ok: true; options: Options } | { ok: false; message: string };

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== 'stats' && command !== 'show') {
    return { ok: false, message: `unknown command "${command ?? ''}"` };
  }

  let file: string | undefined;
  let json = false;
  let tool: string | undefined;
  let maxArgLength: number | undefined;
  let noText = false;
  let strict = false;

  for (const arg of rest) {
    if (!arg.startsWith('-')) {
      if (file !== undefined) return { ok: false, message: `unexpected argument "${arg}"` };
      file = arg;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--no-text') {
      noText = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('--tool=')) {
      tool = arg.slice('--tool='.length);
    } else if (arg.startsWith('--max-arg=')) {
      const n = Number(arg.slice('--max-arg='.length));
      if (!Number.isInteger(n) || n < 0) return { ok: false, message: `invalid --max-arg value in "${arg}"` };
      maxArgLength = n;
    } else {
      return { ok: false, message: `unknown option "${arg}"` };
    }
  }

  if (file === undefined) return { ok: false, message: 'missing <file> argument' };

  return { ok: true, options: { command, file, json, tool, maxArgLength, noText, strict } };
}

function readTrace(file: string): string {
  return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
}

function run(argv: string[]): number {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === '--version') {
    console.log(readVersion());
    return 0;
  }

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`agent-trace: ${parsed.message}`);
    console.error(USAGE);
    return 2;
  }
  const { options } = parsed;

  let text: string;
  try {
    text = readTrace(options.file);
  } catch (err) {
    console.error(`agent-trace: cannot read "${options.file}": ${(err as Error).message}`);
    return 2;
  }

  const { events, issues } = parseTrace(text);

  if (issues.length > 0) {
    for (const issue of issues) console.error(`agent-trace: ${formatIssue(issue)}`);
    if (options.strict) return 1;
  }

  if (events.length === 0) {
    console.error('agent-trace: no usable events in trace');
    return 1;
  }

  if (options.command === 'stats') {
    const stats = computeStats(events);
    console.log(options.json ? JSON.stringify(stats, null, 2) : renderStats(stats));
    return 0;
  }

  console.log(
    renderTimeline(events, {
      tool: options.tool,
      maxArgLength: options.maxArgLength,
      includeText: !options.noText,
    }),
  );
  return 0;
}

process.exitCode = run(process.argv.slice(2));
