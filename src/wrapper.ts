import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function ensureProxyRunning(): boolean {
  try {
    mkdirSync(dirname(PID_FILE), { recursive: true });

    if (existsSync(PID_FILE)) {
      const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
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
    return true;
  } catch {
    return false;
  }
}

export function runClaudeWithProxy(args: string[]): void {
  const proxyStarted = ensureProxyRunning();
  const env = { ...process.env };
  if (proxyStarted) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}`;
  }
  const result = spawnSync('claude', args, { stdio: 'inherit', env });
  process.exit(result.status ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runClaudeWithProxy(process.argv.slice(2));
}
