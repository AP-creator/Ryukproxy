import { describe, it, expect } from 'vitest';
import { resolvePort, DEFAULT_PORT } from '../src/server.js';

describe('resolvePort', () => {
  it('defaults when RYUKPROXY_PORT is unset or empty', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
    expect(resolvePort('')).toBe(DEFAULT_PORT);
  });

  it('accepts a valid port', () => {
    expect(resolvePort('8931')).toBe(8931);
    expect(resolvePort('1')).toBe(1);
    expect(resolvePort('65535')).toBe(65535);
  });

  it('rejects values listen() would silently turn into a random port', () => {
    // Number('nope') is NaN and listen(NaN) binds a free port instead of
    // failing, so a typo would disable proxying with no visible cause.
    for (const bad of ['nope', '80.5', '0', '-1', '65536', ' ']) {
      expect(() => resolvePort(bad), `accepted ${JSON.stringify(bad)}`).toThrow(/RYUKPROXY_PORT/);
    }
  });

  it('names the offending value in the error', () => {
    expect(() => resolvePort('eighty')).toThrow(/"eighty"/);
  });
});
