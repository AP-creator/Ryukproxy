export const DEFAULT_UPSTREAM_URL = process.env.RYUKPROXY_UPSTREAM_URL ?? 'https://api.anthropic.com';

// fetch() rejects a Request built with a body on these methods, and the
// Anthropic API never expects one there either.
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/**
 * Headers that describe the client's connection to *us*, not the request
 * itself (RFC 7230 section 6.1), plus the two the transport must recompute.
 *
 * Beyond being wrong to relay, some of these are actively fatal: fetch()
 * throws outright on `keep-alive` and `upgrade`, so a client sending either
 * turned into a 502 and the request never reached the API at all -- a
 * fail-closed path in a proxy whose whole design is to fail open.
 */
export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers the transport recomputes for the request it actually sends. */
const TRANSPORT_HEADERS = new Set(['host', 'content-length']);

/**
 * The header names a `Connection` value marks as scoped to that hop, which is
 * the actual RFC rule rather than a fixed list.
 */
export function connectionScopedNames(connectionValue: string | undefined): Set<string> {
  return new Set(
    (connectionValue ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Drop the connection-scoped headers, keeping everything the API cares about
 * (x-api-key, anthropic-version, anthropic-beta, content-type, ...) untouched.
 *
 * `Connection` may also *name* further headers that are connection-scoped for
 * this hop, so those are dropped too.
 */
function forwardableHeaders(headers: Record<string, string>): Record<string, string> {
  const connectionScoped = connectionScopedNames(headers['connection']);

  const forwardable: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || TRANSPORT_HEADERS.has(key) || connectionScoped.has(key)) {
      continue;
    }
    forwardable[name] = value;
  }
  return forwardable;
}

/**
 * Resolve an incoming request path against the upstream base URL, keeping any
 * base path the upstream carries and never leaving the upstream's origin.
 *
 * Two things go wrong if the path is simply resolved relative to the base.
 *
 * `new URL('/v1/messages', 'https://host/anthropic')` resolves against the
 * *origin* and yields 'https://host/v1/messages' -- silently dropping the
 * '/anthropic' prefix a gateway-style upstream needs.
 *
 * Worse, the path comes from whatever connected to the local port, and a
 * protocol-relative one ('//elsewhere.example/v1/messages') resolves to a
 * different host entirely. Since every request is forwarded with the user's
 * x-api-key attached, that would turn the proxy into a way for anything able
 * to reach 127.0.0.1 to post that key to a server of its choosing. So the
 * origin is pinned from the configured upstream and only the path and query
 * are taken from the request.
 */
export function resolveUpstreamUrl(path: string, upstreamUrl: string): URL {
  const base = new URL(upstreamUrl);
  const prefix = base.pathname.replace(/\/+$/, '');

  // Parsed against a throwaway origin purely to split path from query; any
  // host the request tried to smuggle in is discarded with it.
  const requested = new URL(path, 'http://ryukproxy.invalid');

  const url = new URL(base);
  url.pathname = prefix + requested.pathname;
  url.search = requested.search;
  url.hash = '';
  return url;
}

export async function forwardRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | Buffer,
  upstreamUrl: string = DEFAULT_UPSTREAM_URL
): Promise<Response> {
  const url = resolveUpstreamUrl(path, upstreamUrl);
  const forwardHeaders = forwardableHeaders(headers);
  // Forward the caller's own method verbatim. Hardcoding POST here turned
  // every non-POST call Claude Code makes through the proxy (e.g.
  // `GET /v1/models`) into a POST against the same path, which the API
  // answers with a 404/405 the user sees as a broken client.
  const upstreamMethod = method.toUpperCase();
  return fetch(url, {
    method: upstreamMethod,
    headers: forwardHeaders,
    body: BODYLESS_METHODS.has(upstreamMethod) ? undefined : toBodyInit(body),
    // fetch() follows redirects by default, which is wrong for a proxy twice
    // over: a 3xx is the client's to act on, and following it would resend the
    // request -- x-api-key included -- to whatever host the Location names.
    // Hand the 3xx back and let the client decide.
    redirect: 'manual',
  });
}

/**
 * Hand fetch() something it accepts without reinterpreting the bytes.
 *
 * A Buffer must be narrowed to its own region of the underlying ArrayBuffer:
 * Node allocates small Buffers out of a shared pool, so passing `.buffer`
 * directly would send the whole pool — other requests' bytes included.
 */
function toBodyInit(body: string | Buffer): string | ArrayBuffer {
  if (typeof body === 'string') return body;
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}
