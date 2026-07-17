import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createProxyServer } from '../src/server.js';

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

  it('forwards the original raw body unmodified when scrubRequestBody throws (messages not an array)', async () => {
    // `messages` must be an array per AnthropicRequestBody; scrubRequestBody calls
    // body.messages.map(...), which throws a TypeError when messages is e.g. a string.
    // The body is still valid JSON, so this exercises the scrub-time failure path
    // rather than the JSON.parse failure path exercised above.
    const bodyWithInvalidMessages = JSON.stringify({ messages: 'not-an-array' });

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyWithInvalidMessages,
    });

    expect(response.status).toBe(200);
    expect(receivedBody).toBe(bodyWithInvalidMessages);
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
