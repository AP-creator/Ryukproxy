import { createServer, IncomingMessage, Server } from 'node:http';
import { parse as losslessParse, stringify as losslessStringify } from 'lossless-json';
import { scrubRequestBody } from './scrub-body.js';
import type { AnthropicRequestBody } from './types.js';
import { forwardRequest, DEFAULT_UPSTREAM_URL } from './forwarder.js';
import { logScrubEvent, DEFAULT_LOG_PATH } from './logger.js';
import { HEALTH_PATH, HEALTH_SERVICE_ID } from './health.js';

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createProxyServer(): Server {
  const upstreamUrl = process.env.RYUKPROXY_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL;
  const logPath = process.env.RYUKPROXY_LOG_PATH ?? DEFAULT_LOG_PATH;

  return createServer(async (req, res) => {
    try {
      // Ryukproxy's own liveness probe: answered here, never forwarded, and
      // never logged as a scrub event (it isn't proxied traffic, and counting
      // it would skew `ryukproxy stats`). The launcher uses it to tell an
      // actual Ryukproxy from any other process that happens to hold the port.
      if (req.method === 'GET' && (req.url ?? '').split('?')[0] === HEALTH_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ service: HEALTH_SERVICE_ID, pid: process.pid }));
        return;
      }

      const rawBody = await readRequestBody(req);
      const bytesBefore = Buffer.byteLength(rawBody, 'utf8');

      let scrubbedBody = rawBody;
      try {
        // Use lossless-json instead of JSON.parse/JSON.stringify: a plain
        // parse->stringify round-trip is NOT an identity transform for numbers
        // outside the safe integer range, -0, 1e21, or trailing-zero decimals
        // like 1.0 -- all of which would be silently rewritten even in content
        // the scrubber never touches (e.g. a tool_use input echoed back on every
        // subsequent turn). lossless-json preserves the exact source text of
        // every number via LosslessNumber, so the only bytes that ever change
        // are the ones scrubToolResultText actually rewrites.
        const parsed = losslessParse(rawBody) as AnthropicRequestBody;
        scrubbedBody = losslessStringify(scrubRequestBody(parsed)) ?? rawBody;
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

      const upstreamResponse = await forwardRequest(
        req.method ?? 'POST',
        req.url ?? '/',
        headers,
        scrubbedBody,
        upstreamUrl
      );

      const responseHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      // undici transparently decompresses gzip/br upstream bodies, so the
      // upstream's content-encoding and (compressed) content-length no longer
      // describe the bytes we actually send. Drop those plus hop-by-hop framing
      // headers and let Node reframe the response from the real decompressed
      // bytes; otherwise a compressed upstream response reaches the client as a
      // gzip-labelled but already-decompressed body (decode failure/truncation).
      // This list is deliberately scoped to the framing headers that break given
      // undici's auto-decompression — not a general hop-by-hop header scrub.
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      delete responseHeaders['transfer-encoding'];
      delete responseHeaders['connection'];
      res.writeHead(upstreamResponse.status, responseHeaders);

      // A client that disconnects mid-stream makes `res` emit 'error' (EPIPE /
      // write-after-end) asynchronously — the surrounding try/catch cannot catch
      // an emitter event on a later tick, so an unhandled 'error' would crash the
      // whole proxy. Swallow it (a dead client socket is not a proxy failure) and
      // stop pumping an upstream body nobody is listening to.
      let clientGone = false;
      res.on('error', () => {
        clientGone = true;
      });
      req.on('aborted', () => {
        clientGone = true;
      });
      res.on('close', () => {
        if (!res.writableEnded) clientGone = true;
      });

      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        while (true) {
          if (clientGone) {
            await reader.cancel().catch(() => {});
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (clientGone) {
            await reader.cancel().catch(() => {});
            break;
          }
          res.write(value);
        }
      }
      if (!res.writableEnded) res.end();

      try {
        await logScrubEvent({ timestamp: new Date().toISOString(), bytesBefore, bytesAfter }, logPath);
      } catch (logErr) {
        // Logging is best-effort and must never affect a response that has already
        // been sent to the client. Report to stderr and move on (fail open).
        console.error('ryukproxy: failed to log scrub event', logErr);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'ryukproxy_error', message: String(err) }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
}
