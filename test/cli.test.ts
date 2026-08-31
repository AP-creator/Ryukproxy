import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const cliEntry = join(repoRoot, 'src', 'cli.ts');

let tempDir: string;
let logPath: string;

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, RYUKPROXY_LOG_PATH: logPath, ...env },
  });
}

/**
 * A stub `claude` that reports its argv exactly, so a test can tell one
 * argument containing spaces from several arguments.
 */
async function writeArgvStub(): Promise<string> {
  const binDir = join(tempDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const stub = join(binDir, 'claude');
  await writeFile(stub, '#!/usr/bin/env bash\necho "ARGC=$#"\nprintf \'ARG:[%s]\\n\' "$@"\n', 'utf8');
  await chmod(stub, 0o755);
  return binDir;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ryukproxy-cli-test-'));
  logPath = join(tempDir, 'events.jsonl');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ryukproxy CLI', () => {
  it('handles `stats` itself instead of forwarding it to claude', async () => {
    await writeFile(
      logPath,
      '{"timestamp":"2026-07-16T10:00:00.000Z","bytesBefore":2000,"bytesAfter":500}\n',
      'utf8'
    );

    const result = runCli(['stats']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 request');
    expect(result.stdout).toContain('75.0%');
  });

  it('emits machine-readable output for `stats --json`', async () => {
    await writeFile(
      logPath,
      '{"timestamp":"2026-07-16T10:00:00.000Z","bytesBefore":2000,"bytesAfter":500}\n',
      'utf8'
    );

    const result = runCli(['stats', '--json']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      requests: 1,
      bytesBefore: 2000,
      bytesAfter: 500,
      bytesSaved: 1500,
    });
  });

  it('reports an empty log without failing', () => {
    const result = runCli(['stats']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No requests logged yet');
  });

  it('passes an argument containing spaces through as a single argument', async () => {
    // Running claude through a shell joins argv into one command string, so a
    // quoted prompt arrives split into words. Claude Code prompts routinely
    // contain spaces.
    const binDir = await writeArgvStub();

    const result = runCli(['--print', 'hello there world'], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: tempDir,
      RYUKPROXY_PORT: '8977',
    });

    expect(result.stdout).toContain('ARGC=2');
    expect(result.stdout).toContain('ARG:[--print]');
    expect(result.stdout).toContain('ARG:[hello there world]');
  });

  it('never lets shell metacharacters in an argument be executed', async () => {
    // Through a shell, backticks and $() in a prompt are substituted before
    // claude ever sees them -- the user's own text silently becoming a command
    // to run. Proven by side effect: the payload would create this file.
    const binDir = await writeArgvStub();
    const marker = join(tempDir, 'executed-by-shell');
    const prompt = `explain \`touch ${marker}\` and $(touch ${marker}) please`;

    const result = runCli(['--print', prompt], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: tempDir,
      RYUKPROXY_PORT: '8977',
    });

    // Arrives verbatim, as one argument...
    expect(result.stdout).toContain('ARGC=2');
    expect(result.stdout).toContain(`ARG:[${prompt}]`);
    // ...and nothing in it ran.
    expect(existsSync(marker)).toBe(false);
  });

  it('still launches claude for every other argument list', async () => {
    // A stub `claude` on PATH proves the wrapper path is taken and that the
    // user's arguments reach it unchanged — `stats` interception must not
    // swallow anything else.
    const binDir = join(tempDir, 'bin');
    await mkdir(binDir, { recursive: true });
    const stub = join(binDir, 'claude');
    await writeFile(stub, '#!/usr/bin/env bash\necho "STUB_ARGS=$*"\nexit 0\n', 'utf8');
    await chmod(stub, 0o755);

    const result = runCli(['--print', 'hello stats'], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: tempDir,
      // Under tsx the launcher's sibling `index.js` doesn't exist, so the proxy
      // never comes up — which is exactly the fail-open path being asserted:
      // the wrapper falls back to launching claude directly and the stub runs.
      // An unused port keeps that failure local to this test.
      RYUKPROXY_PORT: '8977',
    });

    expect(result.stdout).toContain('STUB_ARGS=--print hello stats');
  });
});
