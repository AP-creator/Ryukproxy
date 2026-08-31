import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEALTH_PATH, HEALTH_SERVICE_ID } from './health.js';

const PID_FILE = join(homedir(), '.ryukproxy', 'ryukproxy.pid');
const PORT = process.env.RYUKPROXY_PORT ?? '8931';

/** Budget for the one probe taken before deciding whether to spawn anything. */
const INITIAL_PROBE_TIMEOUT_MS = 250;

/** Signals that mean "the user ended it", which need no error message. */
const QUIET_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Work out what the proxy should forward to.
 *
 * The launcher overwrites ANTHROPIC_BASE_URL so Claude Code talks to the proxy
 * instead of the API. If the user already had one set -- pointing at a company
 * gateway, say -- and the proxy then defaulted to api.anthropic.com, inserting
 * the proxy would silently redirect their traffic away from the endpoint they
 * chose. So their value becomes the proxy's upstream.
 *
 * Except when it points back at the proxy's own port, which happens the moment
 * someone exports ANTHROPIC_BASE_URL=http://127.0.0.1:8931 to make the setting
 * stick: adopting that would have the proxy forward to itself, forever.
 */
export function resolveUpstreamForProxy(
  env: NodeJS.ProcessEnv,
  port: string
): string | undefined {
  // An explicit setting always wins; it is the more specific instruction.
  if (env.RYUKPROXY_UPSTREAM_URL) return env.RYUKPROXY_UPSTREAM_URL;

  const existing = env.ANTHROPIC_BASE_URL;
  if (!existing) return undefined;

  try {
    const url = new URL(existing);
    // `url.port` is empty when the URL uses its scheme's default, so compare
    // effective ports: http://127.0.0.1 against a proxy on port 80 is the same
    // self-reference as http://127.0.0.1:8931 against one on 8931.
    const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
    const isSelf = LOOPBACK_HOSTS.has(url.hostname) && effectivePort === port;
    return isSelf ? undefined : existing;
  } catch {
    // Not a URL we can reason about — leave the proxy on its default.
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks 127.0.0.1:port whether *Ryukproxy* is serving there.
 *
 * A bare TCP connect only proves something accepts connections on the port —
 * it could be any unrelated service, or a stale process from another tool.
 * Requiring the health endpoint's service identity is what makes the answer
 * mean "Ryukproxy is up", which is the only thing the caller actually cares
 * about.
 */
async function probeHealth(port: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { service?: unknown };
    return body?.service === HEALTH_SERVICE_ID;
  } catch {
    return false;
  }
}

/**
 * Bounded health check for a freshly-spawned proxy process: polls for up to
 * ~2 seconds (10 attempts, 100ms apart) waiting for Ryukproxy to answer.
 * spawn() returns a PID immediately even if the child crashes moments later
 * (e.g. EADDRINUSE), so this confirms the proxy is really serving before
 * callers rely on it.
 */
async function waitForProxyHealthy(
  port: string,
  attempts = 10,
  delayMs = 100
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probeHealth(port, delayMs)) {
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

    // Ask the port directly rather than trusting the pidfile. Reading the
    // pidfile answered a different question — "is some process with this PID
    // alive" — which was wrong in both directions: the OS can recycle a PID
    // onto an unrelated process (false positive), and a healthy proxy whose
    // pidfile was deleted read as "not running", so the launcher spawned a
    // duplicate that died on EADDRINUSE and then failed open for no reason.
    // The pidfile is still written below, as bookkeeping for anyone wanting to
    // kill the proxy by hand.
    //
    // Still deliberately deferred: two wrappers starting at the same instant
    // can both probe before either has spawned, and both try to spawn.
    if (await probeHealth(PORT, INITIAL_PROBE_TIMEOUT_MS)) {
      return true;
    }

    const entryPoint = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
    const upstream = resolveUpstreamForProxy(process.env, PORT);
    const child = spawn(process.execPath, [entryPoint], {
      detached: true,
      stdio: 'ignore',
      // On Windows a detached child gets its own console, which would flash a
      // window open every time a session starts one. No effect elsewhere.
      windowsHide: true,
      env: {
        ...process.env,
        RYUKPROXY_PORT: PORT,
        ...(upstream ? { RYUKPROXY_UPSTREAM_URL: upstream } : {}),
      },
    });
    child.unref();
    writeFileSync(PID_FILE, String(child.pid));

    if (!(await waitForProxyHealthy(PORT))) {
      return false;
    }

    // The probe confirms *a* Ryukproxy answers on the port -- it could still
    // be a stale orphaned one left over from an earlier run rather than the
    // child we just spawned (e.g. the new child hit EADDRINUSE against that
    // orphan and died immediately). Confirm the specific child is still alive
    // before declaring success; otherwise a dead child gets credited for a
    // stale listener's success and the pidfile ends up permanently tracking a
    // dead PID.
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

  // A shell is required on Windows and ONLY on Windows: `claude` resolves via
  // PATH to a claude.cmd/claude.ps1 shim rather than a real .exe, and spawnSync
  // cannot execute a shell shim without one.
  //
  // Everywhere else it must be off. With a shell, Node joins argv into a single
  // command string, so `--print "hello world"` reaches claude as three
  // arguments instead of two, and any backtick, $(), ;, | or > in a prompt is
  // interpreted by the shell rather than passed along -- the user's own text
  // silently becoming a command to run. Without a shell, argv is handed over
  // exactly as given.
  const result = spawnSync('claude', args, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });

  if (result.error) {
    // spawnSync failed outright (e.g. claude isn't installed at all).
    // result.status is null in this case, so falling through to
    // `result.status ?? 0` would silently exit 0 — mask the failure instead.
    process.stderr.write(`ryukproxy: failed to launch claude: ${result.error.message}\n`);
    process.exit(1);
    return;
  }

  if (result.signal) {
    // Report a signal death the way a shell does, as 128 + the signal number,
    // rather than flattening it to 1. The wrapper is meant to be transparent
    // enough to alias over `claude`, and a script checking the exit code should
    // be able to tell "interrupted" from "claude exited 1".
    const signalNumber = constants.signals[result.signal as keyof typeof constants.signals];

    // Ctrl-C and friends are how people end a session, not failures worth a
    // message. Anything else is unexpected enough to say out loud.
    if (!QUIET_SIGNALS.has(result.signal)) {
      process.stderr.write(`ryukproxy: claude was terminated by signal ${result.signal}\n`);
    }

    process.exit(signalNumber ? 128 + signalNumber : 1);
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
