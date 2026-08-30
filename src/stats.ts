import { readFile } from 'node:fs/promises';
import { DEFAULT_LOG_PATH } from './logger.js';

export interface StatsSummary {
  requests: number;
  bytesBefore: number;
  bytesAfter: number;
  bytesSaved: number;
  /** Fraction of outgoing bytes removed, 0..1. Zero when nothing is logged. */
  reduction: number;
  /** Lines that could not be read as an event record (torn writes, corruption). */
  malformedLines: number;
  firstEvent?: string;
  lastEvent?: string;
}

const EMPTY_SUMMARY: StatsSummary = {
  requests: 0,
  bytesBefore: 0,
  bytesAfter: 0,
  bytesSaved: 0,
  reduction: 0,
  malformedLines: 0,
};

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Summarise the JSONL event log written by logScrubEvent.
 *
 * Deliberately forgiving: the proxy appends to this file while `stats` reads
 * it, so the last line can be torn mid-write. A line that doesn't parse is
 * counted and skipped rather than failing the whole report — the log is
 * observability, and a corrupt byte should never cost the user the rest of it.
 * A missing log file is not an error either; it just means nothing has been
 * proxied yet.
 */
export async function readStats(logPath: string = DEFAULT_LOG_PATH): Promise<StatsSummary> {
  let contents: string;
  try {
    contents = await readFile(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_SUMMARY };
    throw err;
  }

  const summary: StatsSummary = { ...EMPTY_SUMMARY };

  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      summary.malformedLines++;
      continue;
    }

    if (typeof event !== 'object' || event === null) {
      summary.malformedLines++;
      continue;
    }

    const { bytesBefore, bytesAfter, timestamp } = event as Record<string, unknown>;
    if (!isByteCount(bytesBefore) || !isByteCount(bytesAfter)) {
      summary.malformedLines++;
      continue;
    }

    summary.requests++;
    summary.bytesBefore += bytesBefore;
    summary.bytesAfter += bytesAfter;

    if (typeof timestamp === 'string') {
      summary.firstEvent ??= timestamp;
      summary.lastEvent = timestamp;
    }
  }

  summary.bytesSaved = summary.bytesBefore - summary.bytesAfter;
  summary.reduction = summary.bytesBefore > 0 ? summary.bytesSaved / summary.bytesBefore : 0;

  return summary;
}

export function formatBytes(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB'];
  if (Math.abs(bytes) < 1024) return `${bytes} B`;

  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && Math.abs(value) >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(1)} ${unit}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function formatStats(summary: StatsSummary): string {
  const lines: string[] = [];

  if (summary.requests === 0) {
    lines.push('Ryukproxy: No requests logged yet.');
  } else {
    const range =
      summary.firstEvent && summary.lastEvent
        ? ` (${summary.firstEvent} → ${summary.lastEvent})`
        : '';
    lines.push(`Ryukproxy: ${plural(summary.requests, 'request')} logged${range}`);
    lines.push('');
    lines.push(`  Sent by Claude Code   ${formatBytes(summary.bytesBefore)}`);
    lines.push(`  Forwarded upstream    ${formatBytes(summary.bytesAfter)}`);
    lines.push(
      `  Saved                 ${formatBytes(summary.bytesSaved)} (${(summary.reduction * 100).toFixed(1)}%)`
    );
  }

  if (summary.malformedLines > 0) {
    lines.push('');
    lines.push(`  Skipped ${plural(summary.malformedLines, 'unreadable line')} in the log.`);
  }

  return lines.join('\n');
}

/**
 * `ryukproxy stats` — print the summary. Supports `--json` for scripting.
 */
export async function runStatsCommand(args: string[] = []): Promise<void> {
  const logPath = process.env.RYUKPROXY_LOG_PATH ?? DEFAULT_LOG_PATH;

  try {
    const summary = await readStats(logPath);
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(summary) + '\n');
    } else {
      process.stdout.write(formatStats(summary) + '\n');
    }
  } catch (err) {
    process.stderr.write(`ryukproxy: could not read ${logPath}: ${String(err)}\n`);
    process.exit(1);
  }
}
