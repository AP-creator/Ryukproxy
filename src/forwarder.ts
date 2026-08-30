export const DEFAULT_UPSTREAM_URL = process.env.RYUKPROXY_UPSTREAM_URL ?? 'https://api.anthropic.com';

// fetch() rejects a Request built with a body on these methods, and the
// Anthropic API never expects one there either.
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/**
 * Resolve an incoming request path against the upstream base URL, keeping any
 * base path the upstream carries.
 *
 * `new URL('/v1/messages', 'https://host/anthropic')` resolves against the
 * *origin* and yields 'https://host/v1/messages' -- silently dropping the
 * '/anthropic' prefix a gateway-style upstream needs. Joining the two paths
 * explicitly keeps the prefix, and normalising the trailing slash off the base
 * avoids emitting '//' at the seam.
 */
export function resolveUpstreamUrl(path: string, upstreamUrl: string): URL {
  const base = new URL(upstreamUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const requestPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(prefix + requestPath, base);
}

export async function forwardRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | Buffer,
  upstreamUrl: string = DEFAULT_UPSTREAM_URL
): Promise<Response> {
  const url = resolveUpstreamUrl(path, upstreamUrl);
  const forwardHeaders = { ...headers };
  delete forwardHeaders['host'];
  delete forwardHeaders['content-length'];
  delete forwardHeaders['transfer-encoding'];
  // Forward the caller's own method verbatim. Hardcoding POST here turned
  // every non-POST call Claude Code makes through the proxy (e.g.
  // `GET /v1/models`) into a POST against the same path, which the API
  // answers with a 404/405 the user sees as a broken client.
  const upstreamMethod = method.toUpperCase();
  return fetch(url, {
    method: upstreamMethod,
    headers: forwardHeaders,
    body: BODYLESS_METHODS.has(upstreamMethod) ? undefined : toBodyInit(body),
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
