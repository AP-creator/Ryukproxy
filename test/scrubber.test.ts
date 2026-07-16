import { describe, it, expect } from 'vitest';
import { stripAnsiCodes, collapseCarriageReturns } from '../src/scrubber.js';

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

describe('collapseCarriageReturns', () => {
  it('keeps only the final segment of a mid-line redraw', () => {
    const input = 'Cloning...\rCloning..\rCloning.\rDone';
    expect(collapseCarriageReturns(input)).toBe('Done');
  });

  it('preserves CRLF line endings as real line breaks', () => {
    const input = 'line one\r\nline two\r\n';
    expect(collapseCarriageReturns(input)).toBe('line one\nline two\n');
  });

  it('preserves lines with no carriage return at all', () => {
    const input = 'plain\nlines\nhere';
    expect(collapseCarriageReturns(input)).toBe('plain\nlines\nhere');
  });

  it('handles a redraw line followed by a real newline', () => {
    const input = 'a\rb\rc\nnext line\n';
    expect(collapseCarriageReturns(input)).toBe('c\nnext line\n');
  });
});
