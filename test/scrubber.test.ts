import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAnsiCodes, collapseCarriageReturns, collapseConsecutiveDuplicateLines, scrubToolResultText } from '../src/scrubber.js';
import {
  SPINNER_NOISE_FIXTURE,
  SPINNER_NOISE_EXPECTED,
  PROGRESS_BAR_NOISE_FIXTURE,
  PROGRESS_BAR_NOISE_EXPECTED,
} from './fixtures/spinner-noise.js';

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

  it('preserves CRLF line endings byte-for-byte', () => {
    // A tool that cats a Windows file emits CRLF and contains no noise at all;
    // rewriting those endings to LF would be a content change of its own, in
    // exactly the text the scrubber promises not to touch.
    const input = 'line one\r\nline two\r\nline three\r\n';
    expect(scrubToolResultText(input)).toBe(input);
  });

  it('preserves a mix of CRLF and LF endings exactly as they arrived', () => {
    const input = 'crlf\r\nlf\ncrlf again\r\n';
    expect(scrubToolResultText(input)).toBe(input);
  });

  it('does not collapse two identical CRLF-terminated lines', () => {
    // The CRLF is a line terminator, not a redraw, so these are two real lines.
    const input = 'error: unused variable\r\nerror: unused variable\r\n';
    expect(scrubToolResultText(input)).toBe(input);
  });

  it('still collapses a bare-\r redraw on a CRLF-terminated line', () => {
    const input = 'Cloning...\rCloning..\rDone\r\nnext line\r\n';
    expect(scrubToolResultText(input)).toBe('Done\r\nnext line\r\n');
  });

  it('keeps the last rendered text when the output ends with a bare carriage return', () => {
    // A bare \r parks the cursor at column 0 but erases nothing, so the
    // terminal still shows "Done". Treating the empty tail as the final state
    // would drop a real line of output.
    expect(scrubToolResultText('Cloning...\rDone\r')).toBe('Done');
    expect(scrubToolResultText('progress\r\n')).toBe('progress\r\n');
  });

  it('reduces an erase-line progress bar to its final rendered state', () => {
    expect(scrubToolResultText(PROGRESS_BAR_NOISE_FIXTURE)).toBe(PROGRESS_BAR_NOISE_EXPECTED);
  });

  it('reduces the progress-bar fixture size by at least 60%', () => {
    const scrubbed = scrubToolResultText(PROGRESS_BAR_NOISE_FIXTURE);
    const reduction = 1 - scrubbed.length / PROGRESS_BAR_NOISE_FIXTURE.length;
    expect(reduction).toBeGreaterThan(0.6);
  });

  it('leaves the superseded frames of a multi-line cursor-up redraw in place', () => {
    // Deliberate scope limit, pinned so nobody "optimises" it into a lossy
    // transform: working out which rows a cursor move overwrote is judgement,
    // and this pass does not make judgement calls. The escapes go, the frames
    // stay.
    const input =
      'Compiling a v0.1.0\nCompiling b v0.2.0\n' +
      '\x1b[2A\x1b[2K Compiling a v0.1.0\n\x1b[2K Compiling b v0.2.0\nFinished\n';

    expect(scrubToolResultText(input)).toBe(
      'Compiling a v0.1.0\nCompiling b v0.2.0\n' +
        ' Compiling a v0.1.0\n Compiling b v0.2.0\nFinished\n'
    );
  });

  it('is deterministic and idempotent', () => {
    // Claude Code replays the whole conversation every turn, and the prompt
    // cache only hits if the bytes are identical each time. A scrubber whose
    // output varied between runs would invalidate the cache on every turn and
    // cost far more than the noise it removed.
    for (const sample of [SPINNER_NOISE_FIXTURE, PROGRESS_BAR_NOISE_FIXTURE]) {
      const once = scrubToolResultText(sample);
      expect(scrubToolResultText(sample)).toBe(once);
      expect(scrubToolResultText(once)).toBe(once);
    }
  });

  it('never collapses two blank lines, even when both were redraws', () => {
    // Blank lines are spacing, and the collapse rule explicitly exempts them.
    // Nothing asserted it: removing the `renderedLine !== ''` guard from the
    // collapse condition passed the whole suite.
    const input = '\x1b[K\n\x1b[K\nafter\n';
    expect(scrubToolResultText(input)).toBe('\n\nafter\n');
  });

  it('passes noise-free content through byte-for-byte', () => {
    // The lossless guarantee stated plainly: text with no terminal-rendering
    // noise in it must come out exactly as it went in. Each entry is a shape
    // that really does turn up inside a tool_result.
    const noiseFree: Record<string, string> = {
      typescript: 'function add(a: number, b: number) {\n  return a + b;\n}\n',
      json: '{"id":"msg_01","n":1.0,"big":90071992547409911,"neg":-0}\n',
      crlf: 'first\r\nsecond\r\n',
      tabsAndTrailingSpace: 'col1\tcol2\ncode();   \n\ttabbed\n',
      unicode: 'héllo — 世界 🎉 ✓\nκόσμε\n',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8\n',
      unifiedDiff:
        '--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;\n const b = 3;\n',
      blankLines: 'para one\n\n\npara two\n',
      literalEscapeText: 'the sequence \\x1b[32m is written as text here\n',
      boxDrawing: '┌───┬───┐\n│ a │ b │\n└───┴───┘\n',
      repeatedIdenticalLines: 'WARN: deprecated\nWARN: deprecated\nWARN: deprecated\n',
      windowsPath: 'C:\\Users\\me\\project\\src\n',
      noTrailingNewline: 'last line without a newline',
      empty: '',
    };

    for (const [name, input] of Object.entries(noiseFree)) {
      expect(scrubToolResultText(input), `mutated the "${name}" sample`).toBe(input);
    }
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

  it('preserves two identical adjacent COLOR-only lines (SGR is not a redraw) -- e.g. two colored PASS results', () => {
    // How pytest/jest/eslint --color actually emit repeated results: wrapped in
    // SGR color, not cursor-movement codes. Stripping color is fine (cosmetic
    // noise), but dropping a whole duplicate line would lose real content.
    const coloredPass = '\x1b[32mPASS\x1b[0m';
    const input = `${coloredPass}\n${coloredPass}`;
    expect(scrubToolResultText(input)).toBe('PASS\nPASS');
  });
});

describe('a real captured git clone', () => {
  // Verbatim bytes from `git clone --progress` run under a PTY, which is what
  // a tool_result actually captures: ESC[K + bare \r redraw frames, with CRLF
  // line terminators from the pty's own \n translation. Neither synthetic
  // fixture above mixes the two, and mixing them is the common real case.
  const fixturePath = join(
    fileURLToPath(new URL('.', import.meta.url)),
    'fixtures',
    'git-clone-progress.txt'
  );
  const captured = readFileSync(fixturePath, 'utf8');

  const expected =
    "Cloning into 'repo1'...\r\n" +
    'remote: Enumerating objects: 1168, done.\r\n' +
    'remote: Counting objects: 100% (93/93), done.\r\n' +
    'remote: Compressing objects: 100% (90/90), done.\r\n' +
    'remote: Total 1168 (delta 22), reused 4 (delta 3), pack-reused 1075 (from 3)\r\n' +
    'Receiving objects: 100% (1168/1168), 4.44 MiB | 15.77 MiB/s, done.\r\n' +
    'Resolving deltas: 100% (395/395), done.\r\n';

  it('reduces it to exactly what the terminal finished showing', () => {
    expect(scrubToolResultText(captured)).toBe(expected);
  });

  it('keeps every phase git reported', () => {
    const scrubbed = scrubToolResultText(captured);
    for (const phase of [
      'Enumerating objects',
      'Counting objects',
      'Compressing objects',
      'Total 1168',
      'Receiving objects',
      'Resolving deltas',
    ]) {
      expect(scrubbed).toContain(phase);
    }
    // Only the final state of each phase survives; the intermediate percentages
    // are the noise.
    expect(scrubbed).not.toContain('1% (');
    expect(scrubbed).not.toContain('50%');
  });

  it('reduces the captured output by at least 95%', () => {
    const reduction = 1 - scrubToolResultText(captured).length / captured.length;
    expect(reduction).toBeGreaterThan(0.95);
  });

  it('preserves the pty CRLF line endings it arrived with', () => {
    const scrubbed = scrubToolResultText(captured);
    expect(scrubbed.split('\r\n')).toHaveLength(8);
    expect(scrubbed).not.toMatch(/[^\r]\n/);
  });
});
