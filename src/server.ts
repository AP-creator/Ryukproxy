import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { parse as losslessParse, stringify as losslessStringify } from 'lossless-json';
import { scrubRequestBody } from './scrub-body.js';
import type { AnthropicRequestBody } from './types.js';
import {
  forwardRequest,
  DEFAULT_UPSTREAM_URL,
  HOP_BY_HOP_HEADERS,
  connectionScopedNames,
} from './forwarder.js';
import { logScrubEvent, DEFAULT_LOG_PATH } from './logger.js';
import { HEALTH_PATH, HEALTH_SERVICE_ID } from './health.js';

/**
 * Collect the request body as raw bytes.
 *
 * Deliberately NOT decoded to a string here: Claude Code also posts
 * multipart/form-data with raw binary in it (file uploads), and decoding those
 * bytes as UTF-8 replaces every invalid sequence with U+FFFD — corrupting the
 * upload on the way through. Only the JSON path below decodes, where the bytes
 * are valid UTF-8 by definition and the round-trip is exact.
 */
function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Resolve once the response socket can accept more data.
 *
 * Also resolves on 'close' and 'error': a client that disappears mid-stream
 * never drains, and waiting for a 'drain' that can no longer come would hang
 * this request forever, holding the upstream stream open with it. The caller's
 * clientGone check then ends the pump on the next turn of the loop.
 */
function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      res.off('drain', finish);
      res.off('close', finish);
      res.off('error', finish);
      resolve();
    };
    res.once('drain', finish);
    res.once('close', finish);
    res.once('error', finish);
  });
}

/** Whether this request is worth handing to the JSON scrubber at all. */
function looksLikeJson(contentType: string | undefined): boolean {
  // An absent content-type still gets a try — the parse itself is the real
  // gate, and any failure falls back to the untouched original bytes.
  return contentType === undefined || contentType === '' || contentType.includes('json');
}

export const DEFAULT_PORT = 8931;

/**
 * Turn RYUKPROXY_PORT into a port number, or say clearly why it can't.
 *
 * `Number('eight thousand')` is NaN, and `listen(NaN)` quietly binds a random
 * free port instead of failing — the launcher would then probe 8931, find
 * nothing, and fall back to an unproxied session with no indication that a
 * typo was the cause.
 */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`RYUKPROXY_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
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
      const bytesBefore = rawBody.length;

      // Anything that isn't JSON is forwarded as the exact bytes that arrived.
      let scrubbedBody: string | Buffer = rawBody;
      if (looksLikeJson(req.headers['content-type'])) {
        try {
          // Use lossless-json instead of JSON.parse/JSON.stringify: a plain
          // parse->stringify round-trip is NOT an identity transform for
          // numbers outside the safe integer range, -0, 1e21, or trailing-zero
          // decimals like 1.0 -- all of which would be silently rewritten even
          // in content the scrubber never touches (e.g. a tool_use input echoed
          // back on every subsequent turn). lossless-json preserves the exact
          // source text of every number via LosslessNumber, so the only bytes
          // that ever change are the ones scrubToolResultText actually
          // rewrites.
          const parsed = losslessParse(rawBody.toString('utf8')) as AnthropicRequestBody;
          scrubbedBody = losslessStringify(scrubRequestBody(parsed)) ?? rawBody;
        } catch {
          // Not valid JSON, or not the shape we expect — forward the original
          // bytes rather than guess, and never a re-encoded approximation of them.
          scrubbedBody = rawBody;
        }
      }

      const bytesAfter = Buffer.byteLength(scrubbedBody);

      // Node gives a string for every header it keeps; the only array-valued
      // one is set-cookie, which has no meaning on a request.
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      // Note: content-length is deliberately NOT set here. The scrub usually
      // changes the body's length, and forwardRequest drops the header anyway
      // so fetch can size the request it actually sends.

      const upstreamResponse = await forwardRequest(
        req.method ?? 'POST',
        req.url ?? '/',
        headers,
        scrubbedBody,
        upstreamUrl
      );

      // Headers scoped to the proxy's connection with the upstream describe a
      // hop the client is not on. Relaying them misinforms it at best, and an
      // `upgrade` can invite it to attempt a protocol switch this proxy cannot
      // service. Same rule as the request direction, including any header the
      // upstream's own Connection value names.
      const upstreamConnectionScoped = connectionScopedNames(
        upstreamResponse.headers.get('connection') ?? undefined
      );
      const responseHeaders: Record<string, string | string[]> = {};
      upstreamResponse.headers.forEach((value, key) => {
        const name = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(name) || upstreamConnectionScoped.has(name)) return;
        responseHeaders[key] = value;
      });
      // forEach visits each set-cookie separately and the assignment above
      // keeps only the last, silently dropping the rest -- a session cookie
      // destroyed in transit. Every other header is safe to join per RFC 7230;
      // set-cookie is the one that isn't, so it comes from getSetCookie() as an
      // array, which Node writes back out as separate headers.
      const setCookies = upstreamResponse.headers.getSetCookie?.() ?? [];
      if (setCookies.length > 0) {
        responseHeaders['set-cookie'] = setCookies;
      } else {
        delete responseHeaders['set-cookie'];
      }
      // A separate concern from the hop-by-hop scrub above: these two are
      // dropped because the bytes no longer match what they describe, not
      // because they belong to another hop. undici transparently decompresses
      // gzip/br upstream bodies, so the upstream's content-encoding and its
      // compressed content-length both describe something other than what we
      // are about to send. Dropping them lets Node reframe the response from
      // the real decompressed bytes; keeping them delivers a gzip-labelled body
      // that is already decompressed, which the client fails to decode.
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
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
          // res.write() returning false means the socket buffer is full.
          // Ignoring it and reading on regardless would accumulate the whole
          // upstream body in this process's memory whenever the client reads
          // slower than the API sends. Waiting for 'drain' pushes that
          // backpressure up to the upstream read instead.
          if (!res.write(value)) {
            await waitForDrain(res);
          }
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
