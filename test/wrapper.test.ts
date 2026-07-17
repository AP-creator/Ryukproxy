import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('ensureProxyRunning', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('spawns the proxy and writes a pidfile when none exists', async () => {
    const spawnMock = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const writeFileSyncMock = vi.fn();

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ''),
      writeFileSync: writeFileSyncMock,
      mkdirSync: vi.fn(),
    }));

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = ensureProxyRunning();

    expect(started).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(writeFileSyncMock).toHaveBeenCalledWith(expect.stringContaining('ryukproxy.pid'), '4242');
  });

  it('does not spawn a second proxy if the pidfile points at a live process', async () => {
    const spawnMock = vi.fn();

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => String(process.pid)),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }));

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = ensureProxyRunning();

    expect(started).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('respawns if the pidfile points at a dead process', async () => {
    const spawnMock = vi.fn(() => ({ pid: 5555, unref: vi.fn() }));

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => '999999999'),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }));

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = ensureProxyRunning();

    expect(started).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('returns false (fail open) if spawning throws', async () => {
    const spawnMock = vi.fn(() => {
      throw new Error('spawn failed');
    });

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }));

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = ensureProxyRunning();

    expect(started).toBe(false);
  });
});
