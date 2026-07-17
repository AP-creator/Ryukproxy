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
