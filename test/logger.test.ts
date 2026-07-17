import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logScrubEvent } from '../src/logger.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('logScrubEvent', () => {
  it('appends exactly timestamp, bytesBefore, bytesAfter as one JSON line', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ryukproxy-test-'));
    const logPath = join(tempDir, 'nested', 'events.jsonl');

    await logScrubEvent({ timestamp: '2026-07-16T00:00:00.000Z', bytesBefore: 500, bytesAfter: 120 }, logPath);

    const contents = await readFile(logPath, 'utf8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed).sort()).toEqual(['bytesAfter', 'bytesBefore', 'timestamp']);
    expect(parsed).toEqual({
      timestamp: '2026-07-16T00:00:00.000Z',
      bytesBefore: 500,
      bytesAfter: 120,
    });
  });

  it('appends subsequent events as additional lines rather than overwriting', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ryukproxy-test-'));
    const logPath = join(tempDir, 'events.jsonl');

    await logScrubEvent({ timestamp: 't1', bytesBefore: 1, bytesAfter: 1 }, logPath);
    await logScrubEvent({ timestamp: 't2', bytesBefore: 2, bytesAfter: 2 }, logPath);

    const contents = await readFile(logPath, 'utf8');
    expect(contents.trim().split('\n')).toHaveLength(2);
  });
});
