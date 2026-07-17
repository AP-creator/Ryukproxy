import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as net from 'node:net';

const PID_FILE = join(homedir(), '.ryukproxy', 'ryukproxy.pid');
const PORT = process.env.RYUKPROXY_PORT ?? '8931';

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempts a single TCP connection to 127.0.0.1:port, resolving true/false
 * once the connection either succeeds or fails/times out.
 */
function tryConnect(port: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Bounded health check for a freshly-spawned proxy process: polls
 * 127.0.0.1:port for up to ~1 second (10 attempts, 100ms apart) waiting for
 * the server to start accepting TCP connections. spawn() returns a PID
 * immediately even if the child crashes moments later (e.g. EADDRINUSE), so
 * this confirms the proxy is actually listening before callers rely on it.
 */
async function waitForProxyListening(
  port: string,
  attempts = 10,
  delayMs = 100
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await tryConnect(port, delayMs)) {
      return true;
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

export async function ensureProxyRunning(): Promise<boolean> {
  try {
    mkdirSync(dirname(PID_FILE), { recursive: true });

    if (existsSync(PID_FILE)) {
      const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
      // Known limitations (deliberately deferred, not overlooked):
      // 1. PID reuse — if the OS recycles this PID for an unrelated process
      //    between the last check and now, isProcessRunning() will report a
      //    false positive.
      // 2. TOCTOU race — two wrapper invocations starting at the same time
      //    can both observe no live pidfile and both spawn a proxy.
      if (pid && isProcessRunning(pid)) {
        return true;
      }
    }

    const entryPoint = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
    const child = spawn(process.execPath, [entryPoint], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, RYUKPROXY_PORT: PORT },
    });
    child.unref();
    writeFileSync(PID_FILE, String(child.pid));

    if (!(await waitForProxyListening(PORT))) {
      return false;
    }

    // The TCP probe only confirms *something* answers on the port -- it
    // could be a stale orphaned process left over from an earlier run, not
    // the child we just spawned (e.g. the new child hit EADDRINUSE against
    // that orphan and died immediately). Confirm the specific child is
    // still alive before declaring success; otherwise a dead child gets
    // credited for a stale listener's success and the pidfile ends up
    // permanently tracking a dead PID.
    if (!child.pid || !isProcessRunning(child.pid)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function runClaudeWithProxy(args: string[]): Promise<void> {
  const proxyStarted = await ensureProxyRunning();
  const env = { ...process.env };
  if (proxyStarted) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}`;
  }

  // shell: true is required on Windows so that `claude` (which resolves via
  // PATH to a claude.cmd/claude.ps1 shim, not a real .exe) can be found at
  // all — spawnSync cannot resolve shell shims without a shell. Safe here
  // because `args` is the user's own argv (process.argv.slice(2)), not
  // untrusted input.
  const result = spawnSync('claude', args, { stdio: 'inherit', env, shell: true });

  if (result.error) {
    // spawnSync failed outright (e.g. claude isn't installed at all).
    // result.status is null in this case, so falling through to
    // `result.status ?? 0` would silently exit 0 — mask the failure instead.
    process.stderr.write(`ryukproxy: failed to launch claude: ${result.error.message}\n`);
    process.exit(1);
    return;
  }

  if (result.signal) {
    process.stderr.write(`ryukproxy: claude was terminated by signal ${result.signal}\n`);
    process.exit(1);
    return;
  }

  process.exit(result.status ?? 0);
}

// Compare via fileURLToPath rather than string-building a file:// URL from
// argv[1]: on Windows, process.argv[1] is a backslashed path like
// "E:\...\wrapper.js" while import.meta.url is a URL-encoded,
// forward-slashed "file:///E:/.../wrapper.js" — `file://${process.argv[1]}`
// never matches that format, which silently prevented this entry-point
// guard from ever firing (and runClaudeWithProxy from ever being called).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runClaudeWithProxy(process.argv.slice(2));
}
