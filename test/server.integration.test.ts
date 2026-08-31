import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createProxyServer } from '../src/server.js';
import { HEALTH_PATH, HEALTH_SERVICE_ID } from '../src/health.js';

// Spin up a fresh proxy pointed at a specific upstream URL, without disturbing
// the shared proxy/upstream env used by the other tests.
async function startProxyAgainst(upstreamUrl: string): Promise<{ url: string; server: Server }> {
  const previousUpstream = process.env.RYUKPROXY_UPSTREAM_URL;
  process.env.RYUKPROXY_UPSTREAM_URL = upstreamUrl;
  const server = createProxyServer();
  process.env.RYUKPROXY_UPSTREAM_URL = previousUpstream;

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : '';
  return { url, server };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : '';
}

let mockUpstream: Server;
let mockUpstreamUrl: string;
let proxyServer: ReturnType<typeof createProxyServer>;
let proxyUrl: string;
let receivedBody = '';
let receivedMethod = '';
let receivedUrl = '';
let tempDir: string;
let logPath: string;

beforeAll(async () => {
  mockUpstream = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      receivedBody = data;
      receivedMethod = req.method ?? '';
      receivedUrl = req.url ?? '';
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

  it('passes non-POST API traffic through with its method, path, and query intact', async () => {
    const response = await fetch(`${proxyUrl}/v1/models?limit=2`, {
      method: 'GET',
      headers: { 'x-api-key': 'test-key' },
    });

    expect(response.status).toBe(200);
    expect(receivedMethod).toBe('GET');
    expect(receivedUrl).toBe('/v1/models?limit=2');
  });

  it('answers its own health endpoint locally instead of forwarding it upstream', async () => {
    receivedUrl = '';
    const response = await fetch(`${proxyUrl}${HEALTH_PATH}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: HEALTH_SERVICE_ID, pid: process.pid });
    // The upstream must never see it — that is the whole point of a local probe.
    expect(receivedUrl).toBe('');
  });

  it('does not log a scrub event for a health check', async () => {
    // A dedicated proxy with its own untouched log path: the shared one is
    // written asynchronously after each response, so counting lines around a
    // request would race the other tests in this file.
    const ownLogPath = join(tempDir, 'health-only.jsonl');
    const previousLogPath = process.env.RYUKPROXY_LOG_PATH;
    process.env.RYUKPROXY_LOG_PATH = ownLogPath;
    const { url, server } = await startProxyAgainst(mockUpstreamUrl);
    process.env.RYUKPROXY_LOG_PATH = previousLogPath;

    try {
      const health = await fetch(`${url}${HEALTH_PATH}`);
      expect(health.status).toBe(200);

      // Then a request that SHOULD be logged. Waiting for its line to land is
      // what makes this race-free: logging happens after the response is sent,
      // so simply checking for an absent file right after the probe would pass
      // even if the probe had been logged.
      const proxied = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(proxied.status).toBe(200);

      let lines: string[] = [];
      for (let attempt = 0; attempt < 50 && lines.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lines = (await readFile(ownLogPath, 'utf8').catch(() => ''))
          .split('\n')
          .filter((line) => line.trim() !== '');
      }

      // Exactly one: the proxied request. A probe is not proxied traffic, and
      // counting it would skew `ryukproxy stats`.
      expect(lines).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('forwards a POST to a non-messages endpoint without disturbing its body', async () => {
    const body = JSON.stringify({ model: 'claude-x', messages: [] });
    const response = await fetch(`${proxyUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    expect(receivedMethod).toBe('POST');
    expect(receivedUrl).toBe('/v1/messages/count_tokens');
    expect(receivedBody).toBe(body);
  });
});

describe('concurrent requests', () => {
  it('keeps parallel requests independent and logs each one exactly once', async () => {
    // Claude Code issues requests in parallel (a background haiku call
    // alongside the main stream). Any shared mutable state in the handler would
    // show up here as a body scrubbed into the wrong response, or as torn log
    // lines from interleaved appends.
    const concurrency = 12;
    const bodies = new Map<number, string>();
    const parallelUpstream = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(data);
        bodies.set(parsed.marker, parsed.messages[0].content[0].content);
        // Stagger the replies so responses complete out of request order.
        setTimeout(
          () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ marker: parsed.marker }));
          },
          (parsed.marker % 4) * 15
        );
      });
    });
    const parallelUpstreamUrl = await listen(parallelUpstream);

    const ownLogPath = join(tempDir, `concurrent-${Date.now()}.jsonl`);
    const previousLogPath = process.env.RYUKPROXY_LOG_PATH;
    process.env.RYUKPROXY_LOG_PATH = ownLogPath;
    const { url, server } = await startProxyAgainst(parallelUpstreamUrl);
    process.env.RYUKPROXY_LOG_PATH = previousLogPath;

    try {
      const results = await Promise.all(
        Array.from({ length: concurrency }, async (_, marker) => {
          const noisy = `\x1b[2K\r working ${marker}…\x1b[2K\r working ${marker}..\x1b[2K\r done ${marker}\n`;
          const response = await fetch(`${url}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              marker,
              messages: [
                {
                  role: 'user',
                  content: [{ type: 'tool_result', tool_use_id: `t${marker}`, content: noisy }],
                },
              ],
            }),
          });
          return { marker, status: response.status, echoed: (await response.json()).marker };
        })
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      // Each caller got its own response back, not another request's.
      expect(results.map((r) => r.echoed)).toEqual(results.map((r) => r.marker));
      // And each body was scrubbed on its own, with no cross-contamination.
      expect(bodies.size).toBe(concurrency);
      for (const [marker, content] of bodies) {
        expect(content).toBe(` done ${marker}\n`);
      }

      // Logging happens after each response is sent, so give the appends a beat.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const logLines = (await readFile(ownLogPath, 'utf8')).trim().split('\n');
      expect(logLines).toHaveLength(concurrency);
      for (const line of logLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => parallelUpstream.close(() => resolve()));
    }
  });
});

describe('upstream origin pinning', () => {
  it('does not forward off-host when the request line names another origin', async () => {
    // fetch() would normalise this away, so the request target is written
    // straight onto the wire. Anything that can reach 127.0.0.1 could otherwise
    // use the proxy to post the user's x-api-key wherever it liked.
    receivedUrl = '';
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: Number(new URL(proxyUrl).port),
          path: '//attacker.example.com/v1/messages',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end('{"messages":[]}');
    });

    expect(status).toBe(200);
    // The mock upstream saw it, so it never left for attacker.example.com.
    expect(receivedUrl).toBe('/v1/messages');
  });
});

describe('upstream redirects', () => {
  it('passes a 3xx back to the client instead of following it', async () => {
    // fetch() follows redirects by default. For a proxy that is wrong twice
    // over: the 3xx is the client's to act on, and following it would resend
    // the request -- x-api-key included -- to whatever host the Location names.
    let redirectTargetHit = false;
    const redirectTarget = createServer((req, res) => {
      redirectTargetHit = true;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"followed":true}');
    });
    const redirectTargetUrl = await listen(redirectTarget);

    const redirectingUpstream = createServer((req, res) => {
      req.resume();
      res.writeHead(302, { location: `${redirectTargetUrl}/v1/messages` });
      res.end();
    });
    const redirectingUpstreamUrl = await listen(redirectingUpstream);
    const { url, server } = await startProxyAgainst(redirectingUpstreamUrl);

    try {
      const response = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        body: '{"messages":[]}',
        redirect: 'manual',
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${redirectTargetUrl}/v1/messages`);
      expect(redirectTargetHit).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => redirectingUpstream.close(() => resolve()));
      await new Promise<void>((resolve) => redirectTarget.close(() => resolve()));
    }
  });
});

describe('response header fidelity', () => {
  it('does not relay headers scoped to the upstream connection', async () => {
    // These describe the proxy's hop to the upstream, not the client's hop to
    // the proxy. An `upgrade` in particular can invite the client to attempt a
    // protocol switch this proxy cannot service.
    const hopUpstream = createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        'content-type': 'application/json',
        'keep-alive': 'timeout=5, max=100',
        'upgrade': 'h2c',
        'proxy-connection': 'keep-alive',
        'connection': 'keep-alive, x-hop-header',
        'x-hop-header': 'should-not-reach-client',
        'x-real-header': 'should-reach-client',
      });
      res.end('{"ok":true}');
    });
    const hopUpstreamUrl = await listen(hopUpstream);
    const { url, server } = await startProxyAgainst(hopUpstreamUrl);

    try {
      const response = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"messages":[]}',
      });

      expect(response.status).toBe(200);
      for (const dropped of ['upgrade', 'proxy-connection', 'x-hop-header']) {
        expect(response.headers.get(dropped), `relayed ${dropped}`).toBeNull();
      }
      // Node sets its own Keep-Alive for the client's connection, which is
      // legitimate; what must not survive is the upstream's, describing a hop
      // the client is not on.
      expect(response.headers.get('keep-alive') ?? '').not.toContain('max=100');
      // Everything the upstream actually meant for the client still arrives.
      expect(response.headers.get('x-real-header')).toBe('should-reach-client');
      expect(response.headers.get('content-type')).toBe('application/json');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => hopUpstream.close(() => resolve()));
    }
  });

  it('keeps multiple Set-Cookie headers separate', async () => {
    // Iterating a fetch Headers object joins repeated values with ', ', which
    // is fine for most headers and wrong for set-cookie: two cookies become
    // one malformed one. api.anthropic.com sets none, but a gateway upstream
    // is explicitly supported now, and those do.
    const cookieUpstream = createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['session=abc; Path=/; HttpOnly', 'tracking=xyz; Path=/'],
      });
      res.end('{"ok":true}');
    });
    const cookieUpstreamUrl = await listen(cookieUpstream);
    const { url, server } = await startProxyAgainst(cookieUpstreamUrl);

    try {
      const cookies = await new Promise<string[] | undefined>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port: Number(new URL(url).port),
            path: '/v1/messages',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.headers['set-cookie']));
            response.on('error', reject);
          }
        );
        request.on('error', reject);
        request.end('{"messages":[]}');
      });

      expect(cookies).toEqual(['session=abc; Path=/; HttpOnly', 'tracking=xyz; Path=/']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => cookieUpstream.close(() => resolve()));
    }
  });
});

describe('backpressure', () => {
  it('delivers a large response intact to a slow reader', async () => {
    // Big enough to overflow the socket buffer several times, so res.write()
    // returns false and the drain path actually runs. If that path hung or
    // dropped a chunk, the bytes here would not add up.
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const chunkCount = 64; // 4 MiB total
    const clientStallMs = 250;
    const slowUpstream = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let index = 0;
      const pump = () => {
        while (index < chunkCount) {
          index++;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const slowUpstreamUrl = await listen(slowUpstream);
    const { url, server } = await startProxyAgainst(slowUpstreamUrl);

    try {
      const { total, allBytesCorrect } = await new Promise<{
        total: number;
        allBytesCorrect: boolean;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port: Number(new URL(url).port),
            path: '/v1/messages',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (response) => {
            let received = 0;
            let correct = true;
            let firstChunk = true;
            response.on('data', (data: Buffer) => {
              received += data.length;
              if (!data.every((byte) => byte === 0x61)) correct = false;
              if (firstChunk) {
                // Stall once so the proxy's socket buffer fills while the
                // upstream keeps pushing — that is the condition drain exists
                // for.
                firstChunk = false;
                response.pause();
                setTimeout(() => response.resume(), clientStallMs);
              }
            });
            response.on('end', () => resolve({ total: received, allBytesCorrect: correct }));
            response.on('error', reject);
          }
        );
        request.on('error', reject);
        request.end(JSON.stringify({ messages: [] }));
      });

      expect(total).toBe(chunk.length * chunkCount);
      expect(allBytesCorrect).toBe(true);

      // NOTE ON WHAT THIS DOES AND DOES NOT PROVE. It exercises the drain path
      // (instrumented at the time: the wait is entered once here) and pins that
      // the path delivers every byte in order rather than hanging or dropping a
      // chunk. It does NOT assert that backpressure reaches the upstream, and
      // it passes with the drain wait removed. Two black-box signals were tried
      // and rejected as unreliable: timing, because the socket and undici
      // buffers absorb anything under ~16 MiB so the upstream finishes either
      // way; and peak memory, which does differ (~30 MiB against ~43 MiB) but
      // by a margin too environment-dependent to assert on. Left honest rather
      // than dressed up as a guarantee it cannot make.
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => slowUpstream.close(() => resolve()));
    }
  }, 20000);
});

describe('binary and non-JSON request bodies', () => {
  it('forwards a binary body byte-for-byte instead of round-tripping it through UTF-8', async () => {
    // Claude Code uploads to /v1/files as multipart/form-data with raw bytes in
    // it. Decoding that to a UTF-8 string and re-encoding replaces every
    // invalid sequence with U+FFFD, silently corrupting the upload -- exactly
    // the class of damage this proxy exists to avoid.
    let receivedBytes = Buffer.alloc(0);
    const binaryUpstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        receivedBytes = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    const binaryUpstreamUrl = await listen(binaryUpstream);
    const { url, server } = await startProxyAgainst(binaryUpstreamUrl);

    try {
      // A PNG magic number plus a lone 0xFF/0xFE pair: none of it is valid UTF-8.
      const payload = Buffer.concat([
        Buffer.from('--boundary\r\nContent-Type: image/png\r\n\r\n', 'utf8'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]),
        Buffer.from('\r\n--boundary--\r\n', 'utf8'),
      ]);

      const response = await fetch(`${url}/v1/files`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
        body: payload,
      });

      expect(response.status).toBe(200);
      expect(receivedBytes.equals(payload)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => binaryUpstream.close(() => resolve()));
    }
  });
});

describe('streaming passthrough', () => {
  it('delivers streamed chunks as they arrive instead of buffering the whole response', async () => {
    // Claude Code renders /v1/messages token by token off an SSE stream. If the
    // proxy ever accumulated the upstream body before writing it back, every
    // session would go silent until the response completed -- and every other
    // test here would still pass, because the final bytes would be identical.
    // This pins the timing: the client must see the first chunk *before* the
    // upstream has even written the second.
    const secondChunkDelayMs = 200;
    let firstChunkSeenAt = 0;
    let secondChunkWrittenAt = 0;

    const streamingUpstream = createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => {
        secondChunkWrittenAt = Date.now();
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      }, secondChunkDelayMs);
    });
    const streamingUpstreamUrl = await listen(streamingUpstream);
    const { url, server } = await startProxyAgainst(streamingUpstreamUrl);
    const proxyPort = Number(new URL(url).port);

    try {
      const chunks: string[] = [];
      const contentType = await new Promise<string | undefined>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/v1/messages',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            res.on('data', (chunk) => {
              if (chunks.length === 0) firstChunkSeenAt = Date.now();
              chunks.push(chunk.toString());
            });
            res.on('end', () => resolve(res.headers['content-type']));
            res.on('error', reject);
          }
        );
        req.on('error', reject);
        req.end(JSON.stringify({ messages: [] }));
      });

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]).toContain('message_start');
      expect(firstChunkSeenAt).toBeLessThan(secondChunkWrittenAt);
      // The full stream still arrives intact, and stays labelled as SSE.
      expect(chunks.join('')).toBe(
        'event: message_start\ndata: {"type":"message_start"}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      );
      expect(contentType).toBe('text/event-stream');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => streamingUpstream.close(() => resolve()));
    }
  });
});

describe('fail-open guarantees', () => {
  it('forwards a malformed JSON body unmodified rather than dropping it or erroring', async () => {
    const malformedBody = '{ "messages": [ this is not valid json';

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: malformedBody,
    });

    expect(response.status).toBe(200);
    expect(receivedBody).toBe(malformedBody);
  });

  it('forwards a body whose messages is not an array unmodified', async () => {
    // Valid JSON, so this exercises the scrub path rather than the JSON.parse
    // failure path above. `messages` must be an array per AnthropicRequestBody;
    // anything else the scrubber declines to walk at all, and the body goes
    // upstream exactly as it arrived.
    const bodyWithInvalidMessages = JSON.stringify({ messages: 'not-an-array' });

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyWithInvalidMessages,
    });

    expect(response.status).toBe(200);
    expect(receivedBody).toBe(bodyWithInvalidMessages);
  });

  it('still scrubs the healthy messages when one message in the request is malformed', async () => {
    // Failing open per block rather than per request: Claude Code replays the
    // whole history every turn, so one odd block dropping the scrub for the
    // entire conversation would keep costing on every turn after it appears.
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x\rx\rDone' }],
        },
        { role: 'user', content: null },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'b', content: 'y\ry\rAlso done' }],
        },
      ],
    });

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    const forwarded = JSON.parse(receivedBody);
    expect(forwarded.messages[0].content[0].content).toBe('Done');
    expect(forwarded.messages[1].content).toBeNull();
    expect(forwarded.messages[2].content[0].content).toBe('Also done');
  });

  it('survives a client vanishing mid-request and keeps serving later requests', async () => {
    // The suite covers a client aborting mid-RESPONSE; this is the other half.
    // readRequestBody rejects, and the handler then tries to send a 502 on a
    // socket that is already gone -- an 'error' emitted on `res` at that point
    // has no listener yet, which is how a proxy dies from a client hanging up.
    const abortPort = Number(new URL(proxyUrl).port);

    await new Promise<void>((resolve) => {
      const socket = netConnect({ host: '127.0.0.1', port: abortPort }, () => {
        // Announce a body far larger than what actually gets sent.
        socket.write(
          'POST /v1/messages HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${abortPort}\r\n` +
            'Content-Type: application/json\r\n' +
            'Content-Length: 100000\r\n\r\n' +
            '{"messages":'
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 60);
      });
      socket.on('error', () => resolve());
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(200);
  });

  it('returns a clean 502 (not a crash) when the upstream is unreachable, and keeps serving later requests', async () => {
    // Bind a server to get a free port, then close it immediately so the port is
    // guaranteed to refuse connections.
    const deadServer = createServer();
    await new Promise<void>((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
    const deadAddress = deadServer.address();
    const deadPort = deadAddress && typeof deadAddress === 'object' ? deadAddress.port : 0;
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    const previousUpstream = process.env.RYUKPROXY_UPSTREAM_URL;
    process.env.RYUKPROXY_UPSTREAM_URL = `http://127.0.0.1:${deadPort}`;
    const brokenProxy = createProxyServer();
    process.env.RYUKPROXY_UPSTREAM_URL = previousUpstream;

    await new Promise<void>((resolve) => brokenProxy.listen(0, '127.0.0.1', resolve));
    const brokenAddress = brokenProxy.address();
    const brokenProxyUrl =
      brokenAddress && typeof brokenAddress === 'object' ? `http://127.0.0.1:${brokenAddress.port}` : '';

    try {
      const response = await fetch(`${brokenProxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });

      expect(response.status).toBe(502);
      const json = (await response.json()) as { error: string };
      expect(json.error).toBe('ryukproxy_error');

      // The proxy process must still be alive and serving other requests fine.
      const followUp = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(followUp.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => brokenProxy.close(() => resolve()));
    }
  });

  it('does not crash when logScrubEvent fails after the response has already been sent', async () => {
    // Regression test for the Critical fix: a request that already succeeded and
    // already got res.end()'d must not be affected by a logging failure. Before the
    // fix, the outer catch would call res.writeHead(502, ...) on an already-ended
    // response, throwing ERR_HTTP_HEADERS_SENT as an unhandled rejection and crashing
    // the process. We force logScrubEvent to fail by pointing its log path at a
    // location where a path *file* (not a directory) sits where a directory is
    // expected, so `mkdir(dirname(logPath), { recursive: true })` fails with ENOTDIR.
    const blockerDir = await mkdtemp(join(tmpdir(), 'ryukproxy-log-blocker-'));
    const blockerFile = join(blockerDir, 'blocker.txt');
    await writeFile(blockerFile, 'not a directory');
    const brokenLogPath = join(blockerFile, 'sub', 'events.jsonl');

    const previousLogPath = process.env.RYUKPROXY_LOG_PATH;
    process.env.RYUKPROXY_LOG_PATH = brokenLogPath;
    const brokenLogProxy = createProxyServer();
    process.env.RYUKPROXY_LOG_PATH = previousLogPath;

    await new Promise<void>((resolve) => brokenLogProxy.listen(0, '127.0.0.1', resolve));
    const brokenAddress = brokenLogProxy.address();
    const brokenLogProxyUrl =
      brokenAddress && typeof brokenAddress === 'object' ? `http://127.0.0.1:${brokenAddress.port}` : '';

    try {
      const response = await fetch(`${brokenLogProxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ id: 'msg_test', content: [{ type: 'text', text: 'hi' }] });

      // Prove the server (and process) is still alive after the logging failure.
      const followUp = await fetch(`${brokenLogProxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(followUp.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => brokenLogProxy.close(() => resolve()));
      await rm(blockerDir, { recursive: true, force: true });
    }
  });

  it('reassembles a multi-byte UTF-8 character split across separate TCP chunks without corruption', async () => {
    // Regression test for the Important #2 fix: readRequestBody used to call
    // chunk.toString() on each Buffer independently, which corrupts a multi-byte
    // UTF-8 character that straddles a chunk boundary. We force a split mid-character
    // by writing the request body in two separate socket writes with a delay between
    // them, using Node's own http client so chunk timing (not buffering) drives it.
    const emoji = '\u{1F389}'; // multi-byte (4-byte) UTF-8 character
    const payload = JSON.stringify({ messages: [], note: emoji.repeat(20) });
    const bodyBuffer = Buffer.from(payload, 'utf8');
    const emojiByteIndex = payload.indexOf(emoji); // preceding chars are all ASCII
    const splitIndex = emojiByteIndex + 2; // land inside the 4-byte sequence
    const firstHalf = bodyBuffer.subarray(0, splitIndex);
    const secondHalf = bodyBuffer.subarray(splitIndex);

    const proxyAddress = proxyServer.address();
    const port = proxyAddress && typeof proxyAddress === 'object' ? proxyAddress.port : 0;

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': bodyBuffer.length,
          },
        },
        (res) => {
          let responseData = '';
          res.on('data', (chunk) => (responseData += chunk));
          res.on('end', () => {
            try {
              expect(res.statusCode).toBe(200);
              expect(JSON.parse(responseData)).toEqual({
                id: 'msg_test',
                content: [{ type: 'text', text: 'hi' }],
              });
              const forwarded = JSON.parse(receivedBody);
              expect(forwarded.note).toBe(emoji.repeat(20));
              resolve();
            } catch (err) {
              reject(err as Error);
            }
          });
        }
      );
      req.on('error', reject);
      req.write(firstHalf);
      setTimeout(() => req.end(secondHalf), 20);
    });
  });
});

describe('response passthrough hardening', () => {
  it('survives a client aborting mid-stream and keeps serving later requests (I1)', async () => {
    // Slow upstream: send headers + one chunk, then hold the connection open so
    // the client can drop its socket while the proxy is mid-write. Without
    // res.on('error') + abort handling, the client disconnect makes `res` emit
    // an uncaught 'error' and crashes the proxy process. fetch() resolves on
    // headers (not full body), so we use Node's http client and destroy the
    // socket after the first response chunk to force a true mid-stream abort.
    let holdOpen: ReturnType<typeof setTimeout> | undefined;
    const slowUpstream = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial":');
        // Hold, then finish — the proxy's stream loop resumes here and hits the
        // write/end-after-client-disconnect path that pre-fix would crash on.
        holdOpen = setTimeout(() => res.end('"done"}'), 300);
      });
    });
    const slowUpstreamUrl = await listen(slowUpstream);
    const { url: proxyAbortUrl, server: abortProxy } = await startProxyAgainst(slowUpstreamUrl);
    const abortPort = Number(new URL(proxyAbortUrl).port);

    try {
      // Fire a request, then drop the client socket ~150ms in — while the proxy
      // is mid-stream (upstream hasn't finished). fetch() resolves on headers, so
      // Node's http client is used to control the raw socket. Timing (not a data
      // event) drives the abort, since a tiny first chunk may be buffered.
      await new Promise<void>((resolve) => {
        const req = httpRequest(
          { hostname: '127.0.0.1', port: abortPort, path: '/v1/messages', method: 'POST' },
          (res) => {
            res.on('data', () => {});
            res.on('error', () => {});
          }
        );
        req.on('error', () => {}); // ignore the ECONNRESET from our own destroy
        req.end(JSON.stringify({ messages: [] }));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 150);
      });

      // Let the upstream finish and the proxy process the client disconnect (the
      // crash, if any, happens here), then prove the process is still alive.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { url: healthyUrl, server: healthyProxy } = await startProxyAgainst(mockUpstreamUrl);
      try {
        const followUp = await fetch(`${healthyUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [] }),
        });
        expect(followUp.status).toBe(200);
      } finally {
        await new Promise<void>((resolve) => healthyProxy.close(() => resolve()));
      }
    } finally {
      if (holdOpen) clearTimeout(holdOpen);
      await new Promise<void>((resolve) => abortProxy.close(() => resolve()));
      await new Promise<void>((resolve) => slowUpstream.close(() => resolve()));
    }
  });

  it('delivers a gzip-compressed upstream response as intact decompressed content (I2)', async () => {
    // undici (the proxy's fetch) transparently decompresses the gzip body, so if
    // the proxy forwards the upstream's `content-encoding: gzip` verbatim the
    // client tries to gunzip already-plain bytes and the read fails/corrupts.
    const payload = JSON.stringify({ id: 'msg_gzip', content: [{ type: 'text', text: 'compressed-ok' }] });
    const gzipped = gzipSync(Buffer.from(payload, 'utf8'));
    const gzipUpstream = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': String(gzipped.length),
        });
        res.end(gzipped);
      });
    });
    const gzipUpstreamUrl = await listen(gzipUpstream);
    const { url: gzipProxyUrl, server: gzipProxy } = await startProxyAgainst(gzipUpstreamUrl);

    try {
      const response = await fetch(`${gzipProxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ id: 'msg_gzip', content: [{ type: 'text', text: 'compressed-ok' }] });
    } finally {
      await new Promise<void>((resolve) => gzipProxy.close(() => resolve()));
      await new Promise<void>((resolve) => gzipUpstream.close(() => resolve()));
    }
  });
});
