import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Builds a mock for 'node:net' whose connect() returns a fake socket that
 * immediately emits either 'connect' (proxy is listening) or 'error'
 * (connection refused, e.g. nothing is listening yet/at all).
 */
function createNetMock(mode: 'connect' | 'error') {
  return {
    connect: vi.fn(() => {
      const socket: Record<string, unknown> = {
        setTimeout: vi.fn(),
        removeAllListeners: vi.fn(),
        destroy: vi.fn(),
        once: vi.fn((event: string, cb: () => void) => {
          if (mode === 'connect' && event === 'connect') {
            queueMicrotask(cb);
          }
          if (mode === 'error' && event === 'error') {
            queueMicrotask(cb);
          }
        }),
      };
      return socket;
    }),
  };
}

describe('ensureProxyRunning', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns the proxy, writes a pidfile, and confirms it is listening', async () => {
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

    vi.doMock('node:net', () => createNetMock('connect'));

    // isProcessRunning(child.pid) shells out to the real process.kill(pid, 0);
    // simulate the freshly-spawned child (fake pid 4242) actually being alive.
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 4242) {
        return true;
      }
      throw new Error('ESRCH');
    });

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

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

    // No health check is needed on this branch, so a connect attempt here
    // would indicate a bug — make it fail loudly if reached.
    vi.doMock('node:net', () => createNetMock('error'));

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

    expect(started).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('respawns if the pidfile points at a dead process, confirming health after respawn', async () => {
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

    vi.doMock('node:net', () => createNetMock('connect'));

    // The stale pidfile pid (999999999) must read as dead (real OS behavior
    // already guarantees this), and the freshly-spawned child (fake pid
    // 5555) must read as alive so the post-health-check liveness gate passes.
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 5555) {
        return true;
      }
      throw new Error('ESRCH');
    });

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

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

    vi.doMock('node:net', () => createNetMock('error'));

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

    expect(started).toBe(false);
  });

  it('returns false if the health check passes but the just-spawned child is not actually alive', async () => {
    // Simulates a stale orphaned proxy still holding the port: the TCP probe
    // succeeds (mode: 'connect'), but the child spawn() just returned is not
    // a real running process (pid chosen to be practically guaranteed not to
    // exist, same technique as the "dead pidfile" test above). This must not
    // be credited as success -- the port answering doesn't prove *our* child
    // is the one that's alive and serving.
    const spawnMock = vi.fn(() => ({ pid: 999999998, unref: vi.fn() }));
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

    vi.doMock('node:net', () => createNetMock('connect'));

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

    expect(started).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('returns false (fail open) if the spawned proxy never starts listening', async () => {
    const spawnMock = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));

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

    // Every connection attempt fails, e.g. the child crashed immediately
    // (EADDRINUSE) — the health check should exhaust its budget and report
    // failure rather than returning true just because spawn() didn't throw.
    vi.doMock('node:net', () => createNetMock('error'));

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

    expect(started).toBe(false);
  }, 10000);
});

describe('runClaudeWithProxy', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  beforeEach(() => {
    vi.resetModules();
    // Isolate from whatever ANTHROPIC_BASE_URL happens to be set in the
    // ambient environment so tests can assert on exactly what
    // runClaudeWithProxy itself does to the child's env.
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    }
  });

  it('sets ANTHROPIC_BASE_URL when the proxy starts successfully', async () => {
    const spawnSyncMock = vi.fn(() => ({ status: 0, error: undefined, signal: null }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }));

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
      spawnSync: spawnSyncMock,
    }));

    vi.doMock('node:net', () => createNetMock('connect'));

    // isProcessRunning(child.pid) shells out to the real process.kill(pid, 0);
    // simulate the freshly-spawned child (fake pid 4242) actually being alive.
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 4242) {
        return true;
      }
      throw new Error('ESRCH');
    });

    const { runClaudeWithProxy } = await import('../src/wrapper.js');
    await runClaudeWithProxy(['--version']);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnSyncMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect((options.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8931');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('does not set ANTHROPIC_BASE_URL when the proxy fails to start, but still runs claude (fail open)', async () => {
    const spawnSyncMock = vi.fn(() => ({ status: 0, error: undefined, signal: null }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(() => {
        throw new Error('disk full');
      }),
      mkdirSync: vi.fn(),
    }));

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
      spawnSync: spawnSyncMock,
    }));

    vi.doMock('node:net', () => createNetMock('error'));

    const { runClaudeWithProxy } = await import('../src/wrapper.js');
    await runClaudeWithProxy(['--version']);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnSyncMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect((options.env as Record<string, string>).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('calls spawnSync with shell: true so Windows .cmd/.ps1 shims resolve', async () => {
    const spawnSyncMock = vi.fn(() => ({ status: 0, error: undefined, signal: null }));
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => String(process.pid)),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }));

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(),
      spawnSync: spawnSyncMock,
    }));

    vi.doMock('node:net', () => createNetMock('error'));

    const { runClaudeWithProxy } = await import('../src/wrapper.js');
    await runClaudeWithProxy(['--version']);

    const [, , options] = spawnSyncMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(options.shell).toBe(true);
  });

  it('exits with a clear error, not a silent 0, when spawnSync fails to launch claude', async () => {
    const spawnSyncMock = vi.fn(() => ({
      status: null,
      error: new Error('spawnSync claude ENOENT'),
      signal: null,
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => String(process.pid)),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }));

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(),
      spawnSync: spawnSyncMock,
    }));

    vi.doMock('node:net', () => createNetMock('error'));

    const { runClaudeWithProxy } = await import('../src/wrapper.js');
    await runClaudeWithProxy(['--version']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('failed to launch claude'));
  });
});
