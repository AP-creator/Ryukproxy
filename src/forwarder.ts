export const DEFAULT_UPSTREAM_URL = process.env.RYUKPROXY_UPSTREAM_URL ?? 'https://api.anthropic.com';

export async function forwardRequest(
  path: string,
  headers: Record<string, string>,
  body: string,
  upstreamUrl: string = DEFAULT_UPSTREAM_URL
): Promise<Response> {
  const url = new URL(path, upstreamUrl);
  const forwardHeaders = { ...headers };
  delete forwardHeaders['host'];
  return fetch(url, {
    method: 'POST',
    headers: forwardHeaders,
    body,
  });
}
