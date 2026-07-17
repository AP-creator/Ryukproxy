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
