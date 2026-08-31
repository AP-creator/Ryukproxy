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

  it('writes only the three size fields, dropping anything else it is handed', async () => {
    // The privacy guarantee, pinned: the logger picks its fields explicitly
    // rather than serialising whatever it was given. A future refactor to
    // JSON.stringify(event) would look harmless and would start writing the
    // API key or request content straight to disk the moment a caller passed
    // one through.
    tempDir = await mkdtemp(join(tmpdir(), 'ryukproxy-test-'));
    const logPath = join(tempDir, 'events.jsonl');

    await logScrubEvent(
      {
        timestamp: '2026-07-16T00:00:00.000Z',
        bytesBefore: 10,
        bytesAfter: 5,
        apiKey: 'sk-ant-must-never-be-written',
        body: 'tool_result content that must never be written',
      } as never,
      logPath
    );

    const contents = await readFile(logPath, 'utf8');
    expect(contents).not.toContain('sk-ant');
    expect(contents).not.toContain('tool_result content');
    expect(Object.keys(JSON.parse(contents.trim())).sort()).toEqual([
      'bytesAfter',
      'bytesBefore',
      'timestamp',
    ]);
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
