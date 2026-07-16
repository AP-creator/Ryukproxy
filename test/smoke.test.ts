import { describe, it, expect } from 'vitest';
import { ping } from '../src/smoke.js';

describe('smoke', () => {
  it('proves the toolchain works', () => {
    expect(ping()).toBe('pong');
  });
});
