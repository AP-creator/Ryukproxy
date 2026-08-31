import { describe, it, expect } from 'vitest';
import { resolveUpstreamForProxy } from '../src/wrapper.js';

describe('resolveUpstreamForProxy', () => {
  it('adopts an ANTHROPIC_BASE_URL the user already had set', () => {
    // Otherwise inserting the proxy silently moves their traffic from their
    // own gateway to api.anthropic.com.
    expect(resolveUpstreamForProxy({ ANTHROPIC_BASE_URL: 'https://gw.corp.example' }, '8931')).toBe(
      'https://gw.corp.example'
    );
  });

  it('lets an explicit RYUKPROXY_UPSTREAM_URL win', () => {
    expect(
      resolveUpstreamForProxy(
        {
          ANTHROPIC_BASE_URL: 'https://gw.corp.example',
          RYUKPROXY_UPSTREAM_URL: 'https://explicit.example',
        },
        '8931'
      )
    ).toBe('https://explicit.example');
  });

  it('leaves the default in place when nothing is set', () => {
    expect(resolveUpstreamForProxy({}, '8931')).toBeUndefined();
  });

  it('refuses a base URL pointing at the proxy itself', () => {
    // Exporting ANTHROPIC_BASE_URL to make the setting stick is the obvious
    // thing to do, and adopting it would have the proxy forward to itself.
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(
        resolveUpstreamForProxy({ ANTHROPIC_BASE_URL: `http://${host}:8931` }, '8931'),
        `adopted ${host}`
      ).toBeUndefined();
    }
  });

  it('still adopts a loopback URL on a different port', () => {
    // A local mock or a second proxy is a legitimate upstream.
    expect(resolveUpstreamForProxy({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' }, '8931')).toBe(
      'http://127.0.0.1:9999'
    );
  });

  it('ignores a value that is not a URL at all', () => {
    expect(resolveUpstreamForProxy({ ANTHROPIC_BASE_URL: 'not a url' }, '8931')).toBeUndefined();
  });
});
