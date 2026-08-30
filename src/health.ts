/**
 * Local health endpoint served by the proxy itself rather than forwarded.
 *
 * The path is namespaced under `__ryukproxy/` so it cannot collide with the
 * Anthropic API surface (everything real lives under `/v1/`), and so a request
 * Claude Code makes can never be swallowed by it.
 */
export const HEALTH_PATH = '/__ryukproxy/health';

/** Value of the `service` field, used to tell Ryukproxy from any other listener on the port. */
export const HEALTH_SERVICE_ID = 'ryukproxy';
