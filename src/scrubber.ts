const ANSI_CSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g;

// Non-global detector for "did this line carry a cursor-movement/erase CSI"
// — the escapes a spinner/progress redraw actually uses (cursor moves A–H,
// erase J/K, scroll S/T, position f, save/restore s/u). Deliberately EXCLUDES
// SGR color codes (final byte `m`): a colored line like `\x1b[32mPASS\x1b[0m`
// is cosmetic, not a redraw, and two of them must NOT be treated as duplicate
// noise. Kept non-global so its lastIndex can never leak into a .test() call.
const REDRAW_CSI = /\x1b\[[0-9;?]*[A-HJKSTfsu]/;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_CSI_PATTERN, '');
}

// Render a single line's carriage-return redraws to their final state: a bare
// \r overwrites everything before it, so only the last segment survives.
//
// A *trailing* \r is the exception: it parks the cursor at column 0 but erases
// nothing, so the terminal still shows the segment before it. Taking the empty
// tail as the final state would drop a real line of output, so trailing empty
// segments are discarded. Where that guess is wrong (a preceding erase-line
// escape did blank the row) it errs toward keeping content, which is the only
// safe direction for a lossless scrubber.
function finalRedrawSegment(line: string): string {
  if (!line.includes('\r')) return line;
  const segments = line.split('\r');
  while (segments.length > 1 && segments[segments.length - 1] === '') {
    segments.pop();
  }
  return segments[segments.length - 1];
}

// NOTE: collapseCarriageReturns and collapseConsecutiveDuplicateLines are no
// longer part of the active scrubToolResultText pipeline (which processes lines
// with redraw-awareness inline). They are retained as independently-tested,
// standalone text primitives — kept intentionally, not dead code to delete
// blindly.
export function collapseCarriageReturns(text: string): string {
  // Protect real CRLF line endings before treating bare \r as a redraw marker.
  const withoutCrlf = text.replace(/\r\n/g, '\n');
  return withoutCrlf.split('\n').map(finalRedrawSegment).join('\n');
}

export function collapseConsecutiveDuplicateLines(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    const previous = result[result.length - 1];
    if (line === '' || previous !== line) {
      result.push(line);
    }
  }
  return result.join('\n');
}

export function scrubToolResultText(text: string): string {
  // Split on \n and remember which lines were CRLF-terminated, so the original
  // bytes can be put back. Only a \r immediately before a \n is a line
  // terminator; any other \r is a redraw marker. Rewriting \r\n to \n instead
  // (the obvious way to disambiguate) is itself a content change: a Windows
  // file echoed by a tool would come back with different line endings than it
  // went in with, in text containing no noise whatsoever.
  //
  // Collapsing consecutive duplicate lines is only lossless when the
  // duplication is genuine terminal-redraw noise: a line that carried an ANSI
  // escape or a bare \r before stripping. Two real, independently-emitted
  // identical lines (e.g. two PASS results, or a linter repeating a message for
  // two locations) must be preserved untouched — even though stripping ANSI
  // first can make two originally-distinct lines render identically.
  const segments = text.split('\n');

  const kept: Array<{ text: string; crlf: boolean }> = [];
  let prevWasRedraw = false;
  let prevRendered: string | undefined;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const crlf = i < segments.length - 1 && segment.endsWith('\r');
    const rawLine = crlf ? segment.slice(0, -1) : segment;

    const isRedraw = REDRAW_CSI.test(rawLine) || rawLine.includes('\r');
    const renderedLine = stripAnsiCodes(finalRedrawSegment(rawLine));

    const collapsible =
      isRedraw && prevWasRedraw && renderedLine !== '' && renderedLine === prevRendered;
    if (collapsible) continue;

    kept.push({ text: renderedLine, crlf });
    prevWasRedraw = isRedraw;
    prevRendered = renderedLine;
  }

  return kept.map((line) => (line.crlf ? `${line.text}\r` : line.text)).join('\n');
}
