# Ryukproxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Ryukproxy, a local Node.js/TypeScript HTTP proxy that sits in front of Claude Code's own traffic to `api.anthropic.com`, losslessly stripping ANSI/spinner rendering noise from `tool_result` content before forwarding — plus a wrapper launcher that makes it the default for every `claude` invocation.

**Architecture:** A single HTTP server (`src/server.ts`) parses each outgoing request, runs a pure scrubber over `tool_result` blocks only, forwards the scrubbed body upstream with a streaming passthrough response, and logs byte counts (never content). A separate wrapper script (`src/wrapper.ts`) ensures the server is running (via pidfile) and execs the real `claude` binary with `ANTHROPIC_BASE_URL` pointed at it.

**Tech Stack:** Node.js 24 (native `fetch`, ESM), TypeScript, Vitest for testing.

## Global Constraints

- Lossless only: no transform may alter, reinterpret, or drop content that isn't a recognized noise pattern (spec: "Non-goals").
- Default port `8931`, configurable via `RYUKPROXY_PORT` (spec: "Architecture").
- Scrubber only ever touches `tool_result` content blocks; `system`, tool definitions, and all other message content pass through byte-for-byte (spec: "Components", item 2).
- Logger writes only `{timestamp, bytesBefore, bytesAfter}` — never request/response content or the API key (spec: "Components", item 4; "Error handling").
- On any scrubber failure or upstream failure, fail open — pass the original/unmodified data through rather than blocking or corrupting it (spec: "Error handling").

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/smoke.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm test` command any later task can run.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ryukproxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, `package-lock.json` created, no errors.

- [ ] **Step 6: Write the failing smoke test**

`test/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ping } from '../src/smoke.js';

describe('smoke', () => {
  it('proves the toolchain works', () => {
    expect(ping()).toBe('pong');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/smoke.ts` does not exist / `ping` is not exported.

- [ ] **Step 8: Write minimal implementation**

`src/smoke.ts`:
```ts
export function ping(): string {
  return 'pong';
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test`
Expected: PASS (1 test).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/smoke.ts test/smoke.test.ts
git commit -m "chore: scaffold Ryukproxy project (TypeScript + Vitest)"
```

---

### Task 2: Strip ANSI/cursor-control escape sequences

**Files:**
- Create: `src/scrubber.ts`
- Test: `test/scrubber.test.ts`

**Interfaces:**
- Produces: `stripAnsiCodes(text: string): string`

- [ ] **Step 1: Write the failing test**

`test/scrubber.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { stripAnsiCodes } from '../src/scrubber.js';

describe('stripAnsiCodes', () => {
  it('removes CSI escape sequences', () => {
    const input = '\x1b[?25l\x1b[1G\x1b[JHello\x1b[?25h';
    expect(stripAnsiCodes(input)).toBe('Hello');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsiCodes('no escapes here')).toBe('no escapes here');
  });

  it('does not touch a literal backslash-r-n string (not a real escape)', () => {
    expect(stripAnsiCodes('path\\r\\n more text')).toBe('path\\r\\n more text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/scrubber.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/scrubber.ts`:
```ts
const ANSI_CSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_CSI_PATTERN, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests total, including Task 1's smoke test).

- [ ] **Step 5: Commit**

```bash
git add src/scrubber.ts test/scrubber.test.ts
git commit -m "feat: strip ANSI/cursor-control escape sequences"
```

---

### Task 3: Collapse carriage-return redraws to final rendered state

**Files:**
- Modify: `src/scrubber.ts`
- Modify: `test/scrubber.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2's function directly (independent transform, composed later in Task 5).
- Produces: `collapseCarriageReturns(text: string): string`

- [ ] **Step 1: Write the failing test**

Append to `test/scrubber.test.ts`:
```ts
import { collapseCarriageReturns } from '../src/scrubber.js';

describe('collapseCarriageReturns', () => {
  it('keeps only the final segment of a mid-line redraw', () => {
    const input = 'Cloning...\rCloning..\rCloning.\rDone';
    expect(collapseCarriageReturns(input)).toBe('Done');
  });

  it('preserves CRLF line endings as real line breaks', () => {
    const input = 'line one\r\nline two\r\n';
    expect(collapseCarriageReturns(input)).toBe('line one\nline two\n');
  });

  it('preserves lines with no carriage return at all', () => {
    const input = 'plain\nlines\nhere';
    expect(collapseCarriageReturns(input)).toBe('plain\nlines\nhere');
  });

  it('handles a redraw line followed by a real newline', () => {
    const input = 'a\rb\rc\nnext line\n';
    expect(collapseCarriageReturns(input)).toBe('c\nnext line\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `collapseCarriageReturns` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/scrubber.ts`:
```ts
export function collapseCarriageReturns(text: string): string {
  // Protect real CRLF line endings before treating bare \r as a redraw marker.
  const withoutCrlf = text.replace(/\r\n/g, '\n');
  return withoutCrlf
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r');
      return segments[segments.length - 1];
    })
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/scrubber.ts test/scrubber.test.ts
git commit -m "feat: collapse carriage-return redraws to final rendered state"
```

---

### Task 4: Collapse consecutive duplicate lines

**Files:**
- Modify: `src/scrubber.ts`
- Modify: `test/scrubber.test.ts`

**Interfaces:**
- Produces: `collapseConsecutiveDuplicateLines(text: string): string`

- [ ] **Step 1: Write the failing test**

Append to `test/scrubber.test.ts`:
```ts
import { collapseConsecutiveDuplicateLines } from '../src/scrubber.js';

describe('collapseConsecutiveDuplicateLines', () => {
  it('collapses immediately repeated lines to one', () => {
    const input = 'Cloning repository…\nCloning repository…\nCloning repository…\nRepository cloned';
    expect(collapseConsecutiveDuplicateLines(input)).toBe(
      'Cloning repository…\nRepository cloned'
    );
  });

  it('does not collapse duplicates separated by other content', () => {
    const input = 'A\nB\nA';
    expect(collapseConsecutiveDuplicateLines(input)).toBe('A\nB\nA');
  });

  it('never collapses consecutive blank lines (may be meaningful spacing)', () => {
    const input = 'para one\n\n\npara two';
    expect(collapseConsecutiveDuplicateLines(input)).toBe('para one\n\n\npara two');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `collapseConsecutiveDuplicateLines` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/scrubber.ts`:
```ts
export function collapseConsecutiveDuplicateLines(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    const previous = result[result.length - 1];
    if (line === '' || previous !== line) {
      result.push(line);
    }
  }
  return result.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/scrubber.ts test/scrubber.test.ts
git commit -m "feat: collapse consecutive duplicate lines"
```

---

### Task 5: Compose scrubToolResultText, verify against a real captured fixture, and guard the savings ratio

**Files:**
- Modify: `src/scrubber.ts`
- Create: `test/fixtures/spinner-noise.ts`
- Modify: `test/scrubber.test.ts`

**Interfaces:**
- Consumes: `stripAnsiCodes`, `collapseCarriageReturns`, `collapseConsecutiveDuplicateLines` (Tasks 2-4, all in `src/scrubber.ts`).
- Produces: `scrubToolResultText(text: string): string` — the single entry point Task 6 will call per content block.

- [ ] **Step 1: Create the fixture**

This reconstructs the actual noise pattern observed in this project's own session history when running `npx skills add` — repeated cursor-hide/redraw codes around a spinner, ending in a final rendered line.

`test/fixtures/spinner-noise.ts`:
```ts
const ESC = '\x1b';
const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'];

function frame(glyph: string): string {
  return `${ESC}[1G${ESC}[J${glyph}  Cloning repository…`;
}

const redrawFrames = Array.from({ length: 40 }, (_, i) =>
  frame(SPINNER_FRAMES[i % SPINNER_FRAMES.length])
).join('\r');

export const SPINNER_NOISE_FIXTURE =
  `${ESC}[?25l│\n` +
  `◇  Source: https://github.com/example/example-skills.git\n` +
  `${ESC}[?25h${ESC}[?25l│\n` +
  `${redrawFrames}\r${ESC}[1G${ESC}[J◇  Repository cloned\n` +
  `${ESC}[?25h│\n` +
  `${ESC}[1G${ESC}[J◇  Found 4 skills\n`;

export const SPINNER_NOISE_EXPECTED =
  '│\n' +
  '◇  Source: https://github.com/example/example-skills.git\n' +
  '│\n' +
  '◇  Repository cloned\n' +
  '│\n' +
  '◇  Found 4 skills\n';
```

- [ ] **Step 2: Write the failing tests**

Append to `test/scrubber.test.ts`:
```ts
import { scrubToolResultText } from '../src/scrubber.js';
import { SPINNER_NOISE_FIXTURE, SPINNER_NOISE_EXPECTED } from './fixtures/spinner-noise.js';

describe('scrubToolResultText', () => {
  it('reduces the real spinner-noise fixture to its final rendered state', () => {
    expect(scrubToolResultText(SPINNER_NOISE_FIXTURE)).toBe(SPINNER_NOISE_EXPECTED);
  });

  it('reduces the fixture size by at least 60%', () => {
    const scrubbed = scrubToolResultText(SPINNER_NOISE_FIXTURE);
    const reduction = 1 - scrubbed.length / SPINNER_NOISE_FIXTURE.length;
    expect(reduction).toBeGreaterThan(0.6);
  });

  it('leaves ordinary code/text content completely unchanged', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}\n';
    expect(scrubToolResultText(code)).toBe(code);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `scrubToolResultText` is not exported.

- [ ] **Step 4: Write minimal implementation**

Add to `src/scrubber.ts`:
```ts
export function scrubToolResultText(text: string): string {
  return collapseConsecutiveDuplicateLines(collapseCarriageReturns(stripAnsiCodes(text)));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (14 tests total).

- [ ] **Step 6: Commit**

```bash
git add src/scrubber.ts test/scrubber.test.ts test/fixtures/spinner-noise.ts
git commit -m "feat: compose scrubToolResultText, verify against real spinner-noise fixture"
```

---

### Task 6: Walk request bodies and scrub only tool_result content

**Files:**
- Create: `src/types.ts`
- Create: `src/scrub-body.ts`
- Test: `test/scrub-body.test.ts`

**Interfaces:**
- Consumes: `scrubToolResultText` from `src/scrubber.ts` (Task 5).
- Produces: `scrubRequestBody(body: AnthropicRequestBody): AnthropicRequestBody`, and the types `AnthropicRequestBody`, `Message`, `MessageContentBlock`, `ToolResultContentBlock`, `TextContentBlock` from `src/types.ts` — Task 9 (server) imports `scrubRequestBody` and `AnthropicRequestBody`.

- [ ] **Step 1: Create the types module**

`src/types.ts`:
```ts
export interface TextContentBlock {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextContentBlock | { type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type MessageContentBlock = ToolResultContentBlock | { type: string; [key: string]: unknown };

export interface Message {
  role: string;
  content: string | MessageContentBlock[];
  [key: string]: unknown;
}

export interface AnthropicRequestBody {
  messages: Message[];
  [key: string]: unknown;
}
```

- [ ] **Step 2: Write the failing tests**

`test/scrub-body.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { scrubRequestBody } from '../src/scrub-body.js';
import type { AnthropicRequestBody } from '../src/types.js';

describe('scrubRequestBody', () => {
  it('scrubs a string-form tool_result content block', () => {
    const body: AnthropicRequestBody = {
      system: 'you are a helpful assistant',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'abc',
              content: 'line\rline\rDone',
            },
          ],
        },
      ],
    };
    const result = scrubRequestBody(body);
    const block = (result.messages[0].content as any[])[0];
    expect(block.content).toBe('Done');
  });

  it('scrubs only type:"text" sub-blocks of an array-form tool_result, leaving others alone', () => {
    const body: AnthropicRequestBody = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'xyz',
              content: [
                { type: 'text', text: 'noisy\rnoisy\rDone' },
                { type: 'image', source: { data: 'base64==' } },
              ],
            },
          ],
        },
      ],
    };
    const result = scrubRequestBody(body);
    const block = (result.messages[0].content as any[])[0];
    expect(block.content[0]).toEqual({ type: 'text', text: 'Done' });
    expect(block.content[1]).toEqual({ type: 'image', source: { data: 'base64==' } });
  });

  it('leaves system, non-tool_result blocks, and string-only messages untouched', () => {
    const body: AnthropicRequestBody = {
      system: 'unchanged system prompt',
      tools: [{ name: 'bash' }],
      messages: [
        { role: 'user', content: 'plain string message' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'assistant reply' }],
        },
      ],
    };
    const result = scrubRequestBody(body);
    expect(result).toEqual(body);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/scrub-body.ts` does not exist.

- [ ] **Step 4: Write minimal implementation**

`src/scrub-body.ts`:
```ts
import { scrubToolResultText } from './scrubber.js';
import type {
  AnthropicRequestBody,
  Message,
  MessageContentBlock,
  ToolResultContentBlock,
  TextContentBlock,
} from './types.js';

function isToolResultBlock(block: MessageContentBlock): block is ToolResultContentBlock {
  return block.type === 'tool_result';
}

function scrubToolResultBlock(block: ToolResultContentBlock): ToolResultContentBlock {
  if (typeof block.content === 'string') {
    return { ...block, content: scrubToolResultText(block.content) };
  }
  if (Array.isArray(block.content)) {
    const scrubbedSubBlocks = block.content.map((sub) =>
      sub.type === 'text'
        ? { ...sub, text: scrubToolResultText((sub as TextContentBlock).text) }
        : sub
    );
    return { ...block, content: scrubbedSubBlocks };
  }
  return block;
}

function scrubMessage(message: Message): Message {
  if (typeof message.content === 'string') {
    return message;
  }
  const content = message.content.map((block) =>
    isToolResultBlock(block) ? scrubToolResultBlock(block) : block
  );
  return { ...message, content };
}

export function scrubRequestBody(body: AnthropicRequestBody): AnthropicRequestBody {
  return { ...body, messages: body.messages.map(scrubMessage) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (17 tests total).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/scrub-body.ts test/scrub-body.test.ts
git commit -m "feat: walk request bodies, scrub only tool_result content"
```

---

### Task 7: JSONL event logger (sizes only, never content)

**Files:**
- Create: `src/logger.ts`
- Test: `test/logger.test.ts`

**Interfaces:**
- Produces: `logScrubEvent(event: ScrubEvent, logPath?: string): Promise<void>`, `ScrubEvent`, `DEFAULT_LOG_PATH` — Task 9 (server) calls `logScrubEvent` after each request.

- [ ] **Step 1: Write the failing tests**

`test/logger.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/logger.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/logger.ts`:
```ts
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface ScrubEvent {
  timestamp: string;
  bytesBefore: number;
  bytesAfter: number;
}

export const DEFAULT_LOG_PATH = join(homedir(), '.ryukproxy', 'events.jsonl');

export async function logScrubEvent(event: ScrubEvent, logPath: string = DEFAULT_LOG_PATH): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const line = JSON.stringify({
    timestamp: event.timestamp,
    bytesBefore: event.bytesBefore,
    bytesAfter: event.bytesAfter,
  });
  await appendFile(logPath, line + '\n', 'utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (19 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts test/logger.test.ts
git commit -m "feat: add JSONL event logger recording byte counts only"
```

---

### Task 8: Forwarder — send scrubbed body upstream, never touch the response

**Files:**
- Create: `src/forwarder.ts`
- Test: `test/forwarder.test.ts`

**Interfaces:**
- Produces: `forwardRequest(path: string, headers: Record<string, string>, body: string, upstreamUrl?: string): Promise<Response>`, `DEFAULT_UPSTREAM_URL` — Task 9 (server) calls `forwardRequest`.

- [ ] **Step 1: Write the failing tests**

`test/forwarder.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { forwardRequest } from '../src/forwarder.js';

let mockUpstream: Server;
let mockUpstreamUrl: string;
let receivedBody = '';
let receivedHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  mockUpstream = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      receivedBody = data;
      receivedHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const address = mockUpstream.address();
  if (address && typeof address === 'object') {
    mockUpstreamUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(() => {
  mockUpstream.close();
});

describe('forwardRequest', () => {
  it('sends the given body and headers to the upstream URL', async () => {
    const response = await forwardRequest(
      '/v1/messages',
      { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      '{"scrubbed":true}',
      mockUpstreamUrl
    );

    expect(response.status).toBe(200);
    expect(receivedBody).toBe('{"scrubbed":true}');
    expect(receivedHeaders['x-api-key']).toBe('test-key');
  });

  it('returns the upstream response unmodified for the caller to stream back', async () => {
    const response = await forwardRequest('/v1/messages', {}, '{}', mockUpstreamUrl);
    const json = await response.json();
    expect(json).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/forwarder.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/forwarder.ts`:
```ts
export const DEFAULT_UPSTREAM_URL = process.env.RYUKPROXY_UPSTREAM_URL ?? 'https://api.anthropic.com';

export async function forwardRequest(
  path: string,
  headers: Record<string, string>,
  body: string,
  upstreamUrl: string = DEFAULT_UPSTREAM_URL
): Promise<Response> {
  const url = new URL(path, upstreamUrl);
  const forwardHeaders = { ...headers };
  delete forwardHeaders['host'];
  return fetch(url, {
    method: 'POST',
    headers: forwardHeaders,
    body,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (21 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/forwarder.ts test/forwarder.test.ts
git commit -m "feat: add forwarder that streams upstream responses back unmodified"
```

---

### Task 9: HTTP server — wire scrubbing, forwarding, and logging together

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Test: `test/server.integration.test.ts`

**Interfaces:**
- Consumes: `scrubRequestBody` (`src/scrub-body.ts`, Task 6), `forwardRequest` (`src/forwarder.ts`, Task 8), `logScrubEvent` (`src/logger.ts`, Task 7).
- Produces: `createProxyServer(): http.Server` — Task 10's wrapper spawns `src/index.ts`, which calls this.

- [ ] **Step 1: Write the failing integration test**

`test/server.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../src/server.js';

let mockUpstream: Server;
let mockUpstreamUrl: string;
let proxyServer: ReturnType<typeof createProxyServer>;
let proxyUrl: string;
let receivedBody = '';
let tempDir: string;
let logPath: string;

beforeAll(async () => {
  mockUpstream = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      receivedBody = data;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_test', content: [{ type: 'text', text: 'hi' }] }));
    });
  });
  await new Promise<void>((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = mockUpstream.address();
  if (upstreamAddress && typeof upstreamAddress === 'object') {
    mockUpstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  }

  tempDir = await mkdtemp(join(tmpdir(), 'ryukproxy-server-test-'));
  logPath = join(tempDir, 'events.jsonl');

  process.env.RYUKPROXY_UPSTREAM_URL = mockUpstreamUrl;
  process.env.RYUKPROXY_LOG_PATH = logPath;

  proxyServer = createProxyServer();
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxyServer.address();
  if (proxyAddress && typeof proxyAddress === 'object') {
    proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.RYUKPROXY_UPSTREAM_URL;
  delete process.env.RYUKPROXY_LOG_PATH;
});

describe('createProxyServer', () => {
  it('scrubs tool_result noise, forwards the request, and streams the response back unmodified', async () => {
    const requestBody = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'abc',
              content: 'Cloning...\rCloning..\rCloning.\rDone',
            },
          ],
        },
      ],
    });

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ id: 'msg_test', content: [{ type: 'text', text: 'hi' }] });

    const forwarded = JSON.parse(receivedBody);
    expect(forwarded.messages[0].content[0].content).toBe('Done');
  });

  it('logs a byte-count event and never logs request content', async () => {
    await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });

    const logContents = await readFile(logPath, 'utf8');
    const lastLine = logContents.trim().split('\n').pop()!;
    const parsed = JSON.parse(lastLine);
    expect(Object.keys(parsed).sort()).toEqual(['bytesAfter', 'bytesBefore', 'timestamp']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/server.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/server.ts`:
```ts
import { createServer, IncomingMessage, Server } from 'node:http';
import { scrubRequestBody } from './scrub-body.js';
import type { AnthropicRequestBody } from './types.js';
import { forwardRequest, DEFAULT_UPSTREAM_URL } from './forwarder.js';
import { logScrubEvent, DEFAULT_LOG_PATH } from './logger.js';

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createProxyServer(): Server {
  const upstreamUrl = process.env.RYUKPROXY_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL;
  const logPath = process.env.RYUKPROXY_LOG_PATH ?? DEFAULT_LOG_PATH;

  return createServer(async (req, res) => {
    try {
      const rawBody = await readRequestBody(req);
      const bytesBefore = Buffer.byteLength(rawBody, 'utf8');

      let scrubbedBody = rawBody;
      try {
        const parsed = JSON.parse(rawBody) as AnthropicRequestBody;
        scrubbedBody = JSON.stringify(scrubRequestBody(parsed));
      } catch {
        // Not valid JSON, or not the shape we expect — forward unmodified rather than guess.
        scrubbedBody = rawBody;
      }

      const bytesAfter = Buffer.byteLength(scrubbedBody, 'utf8');

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      headers['content-length'] = String(bytesAfter);

      const upstreamResponse = await forwardRequest(req.url ?? '/', headers, scrubbedBody, upstreamUrl);

      const responseHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      res.writeHead(upstreamResponse.status, responseHeaders);

      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();

      await logScrubEvent({ timestamp: new Date().toISOString(), bytesBefore, bytesAfter }, logPath);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'ryukproxy_error', message: String(err) }));
    }
  });
}
```

`src/index.ts`:
```ts
import { createProxyServer } from './server.js';

const port = Number(process.env.RYUKPROXY_PORT ?? 8931);
const server = createProxyServer();
server.listen(port, '127.0.0.1', () => {
  console.log(`Ryukproxy listening on http://127.0.0.1:${port}`);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (23 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/index.ts test/server.integration.test.ts
git commit -m "feat: wire scrubbing, forwarding, and logging into an HTTP server"
```

---

### Task 10: Wrapper launcher — auto-start Ryukproxy, exec claude, fail open

**Files:**
- Create: `src/wrapper.ts`
- Test: `test/wrapper.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (spawns `src/index.ts`, built by Task 9, as a subprocess rather than importing it).
- Produces: `ensureProxyRunning(): boolean`, `runClaudeWithProxy(args: string[]): void` — the CLI entry point end users invoke instead of `claude` directly.

- [ ] **Step 1: Write the failing tests**

`test/wrapper.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsState = {
  pidFileExists: false,
  pidFileContents: '',
};

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => fsState.pidFileExists),
  readFileSync: vi.fn(() => fsState.pidFileContents),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureProxyRunning } from '../src/wrapper.js';

beforeEach(() => {
  fsState.pidFileExists = false;
  fsState.pidFileContents = '';
  spawnMock.mockReset();
  vi.mocked(writeFileSync).mockClear();
});

describe('ensureProxyRunning', () => {
  it('spawns the proxy and writes a pidfile when none exists', () => {
    spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const started = ensureProxyRunning();

    expect(started).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining('ryukproxy.pid'), '4242');
  });

  it('does not spawn a second proxy if the pidfile points at a live process', () => {
    fsState.pidFileExists = true;
    fsState.pidFileContents = String(process.pid); // our own test process is definitely running

    const started = ensureProxyRunning();

    expect(started).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('respawns if the pidfile points at a dead process', () => {
    fsState.pidFileExists = true;
    fsState.pidFileContents = '999999999'; // extremely unlikely to be a live pid
    spawnMock.mockReturnValue({ pid: 5555, unref: vi.fn() });

    const started = ensureProxyRunning();

    expect(started).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('returns false (fail open) if spawning throws', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const started = ensureProxyRunning();

    expect(started).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/wrapper.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/wrapper.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (27 tests total).

- [ ] **Step 5: Manual verification (auto-start behavior can't be fully unit-tested against a real `claude` binary)**

Run: `node --loader tsx dist_or_direct_check` is unnecessary — instead build and try it directly:
```bash
npm run build
node dist/wrapper.js --version
```
Expected: prints the real `claude --version` output, and `~/.ryukproxy/ryukproxy.pid` now exists. Run it a second time and confirm (via `cat ~/.ryukproxy/events.jsonl` after using `claude` normally through the wrapper) that a second proxy process was not spawned.

- [ ] **Step 6: Commit**

```bash
git add src/wrapper.ts test/wrapper.test.ts
git commit -m "feat: add wrapper launcher for pidfile-guarded auto-start"
```

---

## Self-Review

**Spec coverage:**
- Server on `127.0.0.1:8931`, configurable via `RYUKPROXY_PORT` → Task 9 (`src/index.ts`).
- Scrubber: strip ANSI, collapse `\r` redraws, collapse consecutive duplicate lines, string-or-array `tool_result` content, non-text sub-blocks untouched → Tasks 2-6.
- Forwarder: preserve headers, stream response unmodified → Task 8, wired in Task 9.
- Logger: `{timestamp, bytesBefore, bytesAfter}` only, no content/key → Task 7.
- Wrapper: pidfile-guarded auto-start, exec real `claude` with `ANTHROPIC_BASE_URL`, fail open on proxy-start failure → Task 10.
- Error handling: scrubber failure falls back to unmodified body (Task 9, `catch` around `JSON.parse`/`scrubRequestBody`); upstream errors pass through (the `fetch` call's response, including non-2xx, streams back as-is; only a genuine `forwardRequest` throw — e.g. DNS failure — hits the 502 fallback, and that fallback is Ryukproxy's own error, not a masked upstream one) → Task 9.
- Testing: real fixture unit test, integration test against mock upstream, savings-regression test → Tasks 5 and 9.

**Placeholder scan:** No TBD/TODO markers; every step has complete, runnable code.

**Type consistency:** `AnthropicRequestBody`/`Message`/`MessageContentBlock`/`ToolResultContentBlock`/`TextContentBlock` (Task 6) are used identically in Task 9's `server.ts` import. `scrubRequestBody` (Task 6) matches its call site in Task 9. `forwardRequest`'s signature (Task 8) matches its call site in Task 9. `logScrubEvent`'s signature (Task 7) matches its call site in Task 9. `DEFAULT_UPSTREAM_URL`/`DEFAULT_LOG_PATH` are both overridable via env vars consumed in Task 9, which is what makes Task 9's integration test possible without hitting the real Anthropic API.
