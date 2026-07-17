import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { createProxyServer } from '../src/server.js';

// Regression test for the Critical fix (C1): server.ts used to round-trip the
// request body through JSON.parse -> ... -> JSON.stringify. That round-trip is
// NOT an identity transform for numbers outside the safe integer range, -0,
// 1e21, or trailing-zero decimals like 1.0 -- all of which get silently
// rewritten even in content the scrubber never touches (e.g. a tool_use input
// echoed back on every subsequent turn). This directly violates the project's
// core lossless invariant. See docs/final-review findings, item C1.

let mockUpstream: Server;
let mockUpstreamUrl: string;
let proxyServer: ReturnType<typeof createProxyServer>;
let proxyUrl: string;
let receivedBody = '';

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

  process.env.RYUKPROXY_UPSTREAM_URL = mockUpstreamUrl;

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
  delete process.env.RYUKPROXY_UPSTREAM_URL;
});

describe('lossless number round-trip (C1)', () => {
  it('scrubs tool_result noise while forwarding untouched numbers byte-for-byte identical', async () => {
    // Hand-written JSON text (not built via a JS object + JSON.stringify) so the
    // exact digit sequences below are never coerced through a JS `number` at any
    // point before hitting the wire -- that would itself lose the precision this
    // test is trying to verify the proxy preserves.
    const requestBody =
      '{"messages":[' +
      '{"role":"assistant","content":[{"type":"tool_use","id":"call1","name":"create_issue","input":' +
      '{"issueId":1234567890123456789,"weight":-0,"huge":1e21,"price":1.0}}]},' +
      '{"role":"user","content":[{"type":"tool_result","tool_use_id":"call1",' +
      '"content":"Cloning...\\rCloning..\\rCloning.\\rDone"}]}' +
      ']}';

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });

    expect(response.status).toBe(200);

    // The tool_result content, which the scrubber IS supposed to touch, must
    // still be reduced to its final rendered state.
    expect(receivedBody).toContain('"content":"Done"');

    // Every number outside the tool_result -- which the scrubber never touches
    // -- must survive byte-for-byte, including cases plain JSON.parse/stringify
    // silently corrupts.
    expect(receivedBody).toContain('"issueId":1234567890123456789');
    expect(receivedBody).toContain('"weight":-0');
    expect(receivedBody).toContain('"huge":1e21');
    expect(receivedBody).toContain('"price":1.0');
  });
});
