import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { forwardRequest } from '../src/forwarder.js';

let mockUpstream: Server;
let mockUpstreamUrl: string;
let receivedBody = '';
let receivedMethod = '';
let receivedUrl = '';
let receivedHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  mockUpstream = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      receivedBody = data;
      receivedMethod = req.method ?? '';
      receivedUrl = req.url ?? '';
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
      'POST',
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
    const response = await forwardRequest('POST', '/v1/messages', {}, '{}', mockUpstreamUrl);
    const json = await response.json();
    expect(json).toEqual({ ok: true });
  });

  it('strips host, content-length, and transfer-encoding headers before forwarding', async () => {
    const testBody = '{"scrubbed":true}';
    const response = await forwardRequest(
      'POST',
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

  it('forwards the caller-supplied method rather than rewriting everything to POST', async () => {
    const response = await forwardRequest('GET', '/v1/models', { 'x-api-key': 'test-key' }, '', mockUpstreamUrl);

    expect(response.status).toBe(200);
    expect(receivedMethod).toBe('GET');
    expect(receivedUrl).toBe('/v1/models');
  });

  it('omits the body on methods that cannot carry one', async () => {
    // fetch() throws TypeError if a GET/HEAD request is given a body, so a
    // bodyless method must reach fetch with body: undefined, not ''.
    const response = await forwardRequest('GET', '/v1/models', {}, '', mockUpstreamUrl);

    expect(response.status).toBe(200);
    expect(receivedBody).toBe('');
    expect(receivedHeaders['content-type']).toBeUndefined();
  });

  it('preserves the query string when resolving the upstream URL', async () => {
    const response = await forwardRequest('GET', '/v1/models?limit=2&after_id=x', {}, '', mockUpstreamUrl);

    expect(response.status).toBe(200);
    expect(receivedUrl).toBe('/v1/models?limit=2&after_id=x');
  });

  it('keeps a base path on the upstream URL instead of resolving it away', async () => {
    // An upstream behind a gateway prefix (https://host/anthropic) must keep
    // that prefix: `new URL('/v1/messages', base)` resolves against the origin
    // and silently drops it, sending every request to the wrong path.
    const response = await forwardRequest(
      'POST',
      '/v1/messages',
      { 'content-type': 'application/json' },
      '{}',
      `${mockUpstreamUrl}/gateway`
    );

    expect(response.status).toBe(200);
    expect(receivedUrl).toBe('/gateway/v1/messages');
  });

  it('does not double up slashes when the base path has a trailing slash', async () => {
    const response = await forwardRequest(
      'GET',
      '/v1/models?limit=2',
      {},
      '',
      `${mockUpstreamUrl}/gateway/`
    );

    expect(response.status).toBe(200);
    expect(receivedUrl).toBe('/gateway/v1/models?limit=2');
  });

  it('never lets a request path move the request to another origin', async () => {
    // A protocol-relative target resolves to a whole different host under
    // relative URL resolution. Anything that can reach the local port could
    // otherwise use the proxy to post the user's x-api-key to a server of its
    // choosing, so the upstream origin has to be pinned, not derived.
    const response = await forwardRequest(
      'POST',
      '//attacker.example.com/v1/messages',
      { 'x-api-key': 'test-key' },
      '{}',
      mockUpstreamUrl
    );

    expect(response.status).toBe(200);
    expect(receivedUrl).toBe('/v1/messages');
  });

  it('keeps a pinned origin even when the upstream has a base path', async () => {
    const response = await forwardRequest(
      'POST',
      '//attacker.example.com/v1/messages?x=1',
      {},
      '{}',
      `${mockUpstreamUrl}/gateway`
    );

    expect(response.status).toBe(200);
    expect(receivedUrl).toBe('/gateway/v1/messages?x=1');
  });

  it('leaves the path untouched when the upstream URL is a bare origin', async () => {
    const response = await forwardRequest('POST', '/v1/messages', {}, '{}', `${mockUpstreamUrl}/`);

    expect(response.status).toBe(200);
    expect(receivedUrl).toBe('/v1/messages');
  });
});
