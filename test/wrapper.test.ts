import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * How the port answers Ryukproxy's health probe on a given attempt:
 *  - 'healthy'  — Ryukproxy is serving there.
 *  - 'down'     — nothing is listening (connection refused).
 *  - 'imposter' — something answers, but it is not Ryukproxy. This is the case
 *                 a bare TCP connect could never tell apart from 'healthy'.
 */
type ProbeMode = 'healthy' | 'down' | 'imposter';

/**
 * Stubs global fetch for the health probe. Each entry answers one probe in
 * order; the final entry repeats for every attempt after it, so a bounded
 * poll can be driven to exhaustion without listing every attempt.
 */
function stubHealthProbe(modes: ProbeMode[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const mode = modes[Math.min(call++, modes.length - 1)];
    if (mode === 'down') {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8931');
    }
    return {
      ok: true,
      json: async () => ({
        service: mode === 'healthy' ? 'ryukproxy' : 'some-other-service',
        pid: 1234,
      }),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The pidfile is bookkeeping only now; these keep fs quiet in tests. */
function stubFs(overrides: Record<string, unknown> = {}) {
  vi.doMock('node:fs', () => ({
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    ...overrides,
  }));
}

describe('ensureProxyRunning', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('spawns the proxy, writes a pidfile, and confirms it is healthy', async () => {
    const spawnMock = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const writeFileSyncMock = vi.fn();

    stubFs({ writeFileSync: writeFileSyncMock });

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    // Nothing is up on the first probe, so it spawns; the proxy answers after.
    stubHealthProbe(['down', 'healthy']);

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

  it('does not spawn a second proxy when Ryukproxy already answers on the port', async () => {
    const spawnMock = vi.fn();

    // No pidfile at all: a healthy proxy is a healthy proxy regardless of what
    // the bookkeeping file says, so this must still short-circuit. The old
    // pidfile-first check spawned a doomed duplicate in exactly this case.
    stubFs();

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    stubHealthProbe(['healthy']);

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

    expect(started).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not mistake an unrelated service on the port for Ryukproxy', async () => {
    // The bug a bare TCP connect could never catch: something else is bound to
    // 8931, so the port accepts connections but no scrubbing would happen. It
    // must not be credited, and the spawn it triggers loses the port, so the
    // launcher has to fail open rather than claim a proxy is running.
    const spawnMock = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));

    stubFs();

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    stubHealthProbe(['imposter']);

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

    expect(started).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  }, 10000);

  it('respawns when a stale pidfile names a live but unrelated process', async () => {
    const spawnMock = vi.fn(() => ({ pid: 5555, unref: vi.fn() }));

    // The pidfile names this very test process — very much alive, and very
    // much not Ryukproxy. Under the old pidfile check this read as "already
    // running" and the session went unproxied with no way to tell.
    stubFs({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => String(process.pid)),
    });

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    stubHealthProbe(['down', 'healthy']);

    // The freshly-spawned child (fake pid 5555) must read as alive so the
    // post-health-check liveness gate passes.
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

    stubFs();

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    stubHealthProbe(['down']);

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

    expect(started).toBe(false);
  });

  it('returns false if the health check passes but the just-spawned child is not actually alive', async () => {
    // Simulates a stale orphaned proxy still holding the port: the health
    // probe succeeds, but the child spawn() just returned is not a real
    // running process (pid chosen to be practically guaranteed not to exist).
    // This must not be credited as success -- a healthy answer doesn't prove
    // *our* child is the one that's alive and serving.
    const spawnMock = vi.fn(() => ({ pid: 999999998, unref: vi.fn() }));
    const writeFileSyncMock = vi.fn();

    stubFs({ writeFileSync: writeFileSyncMock });

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    stubHealthProbe(['down', 'healthy']);

    const { ensureProxyRunning } = await import('../src/wrapper.js');
    const started = await ensureProxyRunning();

    expect(started).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('returns false (fail open) if the spawned proxy never starts serving', async () => {
    const spawnMock = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));

    stubFs();

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));

    // Every probe fails, e.g. the child crashed immediately (EADDRINUSE) — the
    // health check should exhaust its budget and report failure rather than
    // returning true just because spawn() didn't throw.
    stubHealthProbe(['down']);

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
    vi.unstubAllGlobals();
    if (originalBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    }
  });

  it('sets ANTHROPIC_BASE_URL when the proxy starts successfully', async () => {
    const spawnSyncMock = vi.fn(() => ({ status: 0, error: undefined, signal: null }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    stubFs();

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
      spawnSync: spawnSyncMock,
    }));

    stubHealthProbe(['down', 'healthy']);

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

    stubFs({
      writeFileSync: vi.fn(() => {
        throw new Error('disk full');
      }),
    });

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => ({ pid: 4242, unref: vi.fn() })),
      spawnSync: spawnSyncMock,
    }));

    stubHealthProbe(['down']);

    const { runClaudeWithProxy } = await import('../src/wrapper.js');
    await runClaudeWithProxy(['--version']);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnSyncMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect((options.env as Record<string, string>).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it.each([
    // A shell is what lets Windows resolve claude.cmd/claude.ps1, which are not
    // executables spawnSync can run directly.
    ['win32', true],
    // Everywhere else it must be off: a shell joins argv into one command
    // string, splitting quoted arguments and executing any metacharacters the
    // user's prompt happens to contain.
    ['linux', false],
    ['darwin', false],
  ])('uses shell only on Windows (%s -> shell: %s)', async (platform, expectedShell) => {
    const spawnSyncMock = vi.fn(() => ({ status: 0, error: undefined, signal: null }));
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });

    try {
      stubFs();

      vi.doMock('node:child_process', () => ({
        spawn: vi.fn(),
        spawnSync: spawnSyncMock,
      }));

      // Already healthy, so the launcher short-circuits without spawning.
      stubHealthProbe(['healthy']);

      const { runClaudeWithProxy } = await import('../src/wrapper.js');
      await runClaudeWithProxy(['--version']);

      const [, , options] = spawnSyncMock.mock.calls[0] as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(options.shell).toBe(expectedShell);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it.each([
    // Ctrl-C: how people actually end a session. 130 is what a shell reports,
    // and there is nothing to warn about.
    ['SIGINT', 130, false],
    ['SIGTERM', 143, false],
    // Unexpected enough to say out loud, but still reported as a signal death.
    ['SIGSEGV', 139, true],
  ])('reports a %s death as %i', async (signal, expectedCode, expectMessage) => {
    const spawnSyncMock = vi.fn(() => ({ status: null, error: undefined, signal }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    stubFs();

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(),
      spawnSync: spawnSyncMock,
    }));

    stubHealthProbe(['healthy']);

    const { runClaudeWithProxy } = await import('../src/wrapper.js');
    await runClaudeWithProxy(['--version']);

    expect(exitSpy).toHaveBeenCalledWith(expectedCode);
    if (expectMessage) {
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(signal));
    } else {
      expect(stderrSpy).not.toHaveBeenCalled();
    }
  });

  it('exits with a clear error, not a silent 0, when spawnSync fails to launch claude', async () => {
    const spawnSyncMock = vi.fn(() => ({
      status: null,
      error: new Error('spawnSync claude ENOENT'),
      signal: null,
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    stubFs();

    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(),
      spawnSync: spawnSyncMock,
    }));

    // Already healthy, so the launcher short-circuits without spawning.
    stubHealthProbe(['healthy']);

    const { runClaudeWithProxy } = await import('../src/wrapper.js');
    await runClaudeWithProxy(['--version']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('failed to launch claude'));
  });
});
