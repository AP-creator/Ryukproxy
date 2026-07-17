import { describe, it, expect } from 'vitest';
import { stripAnsiCodes, collapseCarriageReturns, collapseConsecutiveDuplicateLines, scrubToolResultText } from '../src/scrubber.js';
import { SPINNER_NOISE_FIXTURE, SPINNER_NOISE_EXPECTED } from './fixtures/spinner-noise.js';

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

describe('collapseConsecutiveDuplicateLines', () => {
  it('collapses immediately repeated lines to one', () => {
    const input = 'Cloning repository…\nCloning repository…\nCloning repository…\nRepository cloned';
    expect(collapseConsecutiveDuplicateLines(input)).toBe(
      'Cloning repository…\nRepository cloned'
    );
  });

  it('does not collapse duplicates separated by other content', () => {
    const input = 'A\nB\nA';
    expect(collapseConsecutiveDuplicateLines(input)).toBe('A\nB\nA');
  });

  it('never collapses consecutive blank lines (may be meaningful spacing)', () => {
    const input = 'para one\n\n\npara two';
    expect(collapseConsecutiveDuplicateLines(input)).toBe('para one\n\n\npara two');
  });
});

describe('scrubToolResultText', () => {
  it('reduces the real spinner-noise fixture to its final rendered state', () => {
    expect(scrubToolResultText(SPINNER_NOISE_FIXTURE)).toBe(SPINNER_NOISE_EXPECTED);
  });

  it('reduces the fixture size by at least 60%', () => {
    const scrubbed = scrubToolResultText(SPINNER_NOISE_FIXTURE);
    const reduction = 1 - scrubbed.length / SPINNER_NOISE_FIXTURE.length;
    expect(reduction).toBeGreaterThan(0.6);
  });

  it('leaves ordinary code/text content completely unchanged', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}\n';
    expect(scrubToolResultText(code)).toBe(code);
  });

  // Regression tests for I3: collapsing consecutive duplicate lines is only
  // lossless when the duplication is actually terminal-redraw noise (a line
  // that carried an ANSI escape or a bare \r before stripping). Two real,
  // independently-emitted identical lines -- e.g. two PASS results, or a
  // linter emitting the same message for two different locations -- must
  // never be collapsed, even though stripAnsiCodes running first can make
  // two originally-different lines byte-identical.

  it('preserves two identical adjacent PLAIN lines (no ANSI, no \\r) -- e.g. two real PASS results', () => {
    const input = 'PASS\nPASS';
    expect(scrubToolResultText(input)).toBe('PASS\nPASS');
  });

  it('collapses two adjacent redraw lines (carried ANSI) that render identically', () => {
    const redrawLine = '\x1b[1G\x1b[Jfoo';
    const input = `${redrawLine}\n${redrawLine}`;
    expect(scrubToolResultText(input)).toBe('foo');
  });
});
