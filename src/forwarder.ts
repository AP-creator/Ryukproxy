export const DEFAULT_UPSTREAM_URL = process.env.RYUKPROXY_UPSTREAM_URL ?? 'https://api.anthropic.com';

// fetch() rejects a Request built with a body on these methods, and the
// Anthropic API never expects one there either.
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export async function forwardRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string,
  upstreamUrl: string = DEFAULT_UPSTREAM_URL
): Promise<Response> {
  const url = new URL(path, upstreamUrl);
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
    body: BODYLESS_METHODS.has(upstreamMethod) ? undefined : body,
  });
}
