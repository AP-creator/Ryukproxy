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

  it('strips host, content-length, and transfer-encoding headers before forwarding', async () => {
    const testBody = '{"scrubbed":true}';
    const response = await forwardRequest(
      '/v1/messages',
      {
        'content-type': 'application/json',
        'x-api-key': 'test-key',
        'host': 'proxy.example.com',
        'content-length': '9999',
        'transfer-encoding': 'chunked',
      },
      testBody,
      mockUpstreamUrl
    );

    expect(response.status).toBe(200);
    // Verify the forwarded host header is NOT the one we tried to send
    expect(receivedHeaders['host']).not.toBe('proxy.example.com');
    // Verify content-length is recalculated correctly, not the stale value we passed
    expect(receivedHeaders['content-length']).not.toBe('9999');
    expect(receivedHeaders['content-length']).toBe(String(Buffer.byteLength(testBody)));
    // Verify transfer-encoding was stripped and not forwarded
    expect(receivedHeaders['transfer-encoding']).toBeUndefined();
    // Verify other headers still came through
    expect(receivedHeaders['x-api-key']).toBe('test-key');
    expect(receivedHeaders['content-type']).toBe('application/json');
  });
});
