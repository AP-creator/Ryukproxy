import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStats, formatStats, formatBytes } from '../src/stats.js';
import { HEALTH_PATH, HEALTH_SERVICE_ID } from '../src/health.js';

let tempDir: string;
let logPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ryukproxy-stats-test-'));
  logPath = join(tempDir, 'events.jsonl');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('readStats', () => {
  it('totals requests and bytes across every logged event', async () => {
    await writeFile(
      logPath,
      [
        '{"timestamp":"2026-07-16T10:00:00.000Z","bytesBefore":1000,"bytesAfter":400}',
        '{"timestamp":"2026-07-16T11:00:00.000Z","bytesBefore":3000,"bytesAfter":600}',
      ].join('\n') + '\n',
      'utf8'
    );

    const stats = await readStats(logPath);

    expect(stats.requests).toBe(2);
    expect(stats.bytesBefore).toBe(4000);
    expect(stats.bytesAfter).toBe(1000);
    expect(stats.bytesSaved).toBe(3000);
    expect(stats.reduction).toBeCloseTo(0.75);
    expect(stats.firstEvent).toBe('2026-07-16T10:00:00.000Z');
    expect(stats.lastEvent).toBe('2026-07-16T11:00:00.000Z');
  });

  it('returns an empty summary when the log file does not exist yet', async () => {
    const stats = await readStats(join(tempDir, 'nope.jsonl'));

    expect(stats.requests).toBe(0);
    expect(stats.bytesBefore).toBe(0);
    expect(stats.bytesSaved).toBe(0);
    expect(stats.reduction).toBe(0);
    expect(stats.firstEvent).toBeUndefined();
  });

  it('reports zero reduction rather than dividing by zero on an empty log', async () => {
    await writeFile(logPath, '', 'utf8');

    const stats = await readStats(logPath);

    expect(stats.requests).toBe(0);
    expect(stats.reduction).toBe(0);
    expect(Number.isNaN(stats.reduction)).toBe(false);
  });

  it('skips malformed lines instead of throwing, and counts them', async () => {
    await writeFile(
      logPath,
      [
        '{"timestamp":"2026-07-16T10:00:00.000Z","bytesBefore":1000,"bytesAfter":400}',
        'not json at all',
        '{"timestamp":"2026-07-16T10:30:00.000Z","bytesBefore":"nope","bytesAfter":400}',
        '{"timestamp":"2026-07-16T11:00:00.000Z","bytesAfter":600}',
        '',
        '{"timestamp":"2026-07-16T12:00:00.000Z","bytesBefore":2000,"bytesAfter":100}',
      ].join('\n') + '\n',
      'utf8'
    );

    const stats = await readStats(logPath);

    expect(stats.requests).toBe(2);
    expect(stats.bytesBefore).toBe(3000);
    expect(stats.bytesAfter).toBe(500);
    // The blank trailing line is not a malformed record, the three bad ones are.
    expect(stats.malformedLines).toBe(3);
    expect(stats.lastEvent).toBe('2026-07-16T12:00:00.000Z');
  });

  it('ignores a partially-written final line without losing the earlier events', async () => {
    // The proxy appends while `stats` may be reading; a torn last line must not
    // discard the whole file.
    await writeFile(
      logPath,
      '{"timestamp":"2026-07-16T10:00:00.000Z","bytesBefore":1000,"bytesAfter":400}\n{"timestamp":"2026-07-1',
      'utf8'
    );

    const stats = await readStats(logPath);

    expect(stats.requests).toBe(1);
    expect(stats.bytesBefore).toBe(1000);
    expect(stats.malformedLines).toBe(1);
  });
});

describe('formatStats', () => {
  it('renders the totals in a human-readable summary', async () => {
    await writeFile(
      logPath,
      '{"timestamp":"2026-07-16T10:00:00.000Z","bytesBefore":1048576,"bytesAfter":524288}\n',
      'utf8'
    );

    const output = formatStats(await readStats(logPath));

    expect(output).toContain('1 request');
    expect(output).toContain('50.0%');
    expect(output).toContain('1.0 MB');
  });

  it('says so plainly when nothing has been logged yet', () => {
    const output = formatStats({
      requests: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      bytesSaved: 0,
      reduction: 0,
      malformedLines: 0,
    });

    expect(output).toContain('No requests logged yet');
    expect(output).not.toContain('NaN');
  });

  it('mentions skipped lines only when there are some', async () => {
    await writeFile(logPath, 'garbage\n{"bytesBefore":10,"bytesAfter":5}\n', 'utf8');

    const output = formatStats(await readStats(logPath));

    expect(output).toContain('1 unreadable line');
  });
});

describe('formatBytes', () => {
  it('switches units at the binary boundary, not the decimal one', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });
});

describe('the documented health interface', () => {
  it('keeps the exact path and service id the README tells people to curl', () => {
    // Server and launcher share these constants, so changing them keeps the
    // two in step and every other test passing — while breaking the one thing
    // a person types by hand.
    expect(HEALTH_PATH).toBe('/__ryukproxy/health');
    expect(HEALTH_SERVICE_ID).toBe('ryukproxy');
  });
});
