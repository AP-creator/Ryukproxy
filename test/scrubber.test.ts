import { describe, it, expect } from 'vitest';
import { stripAnsiCodes } from '../src/scrubber.js';

describe('stripAnsiCodes', () => {
  it('removes CSI escape sequences', () => {
    const input = '\x1b[?25l\x1b[1G\x1b[JHello\x1b[?25h';
    expect(stripAnsiCodes(input)).toBe('Hello');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsiCodes('no escapes here')).toBe('no escapes here');
  });

  it('does not touch a literal backslash-r-n string (not a real escape)', () => {
    expect(stripAnsiCodes('path\\r\\n more text')).toBe('path\\r\\n more text');
  });
});
