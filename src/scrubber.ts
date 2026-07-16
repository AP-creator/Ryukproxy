const ANSI_CSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_CSI_PATTERN, '');
}

export function collapseCarriageReturns(text: string): string {
  // Protect real CRLF line endings before treating bare \r as a redraw marker.
  const withoutCrlf = text.replace(/\r\n/g, '\n');
  return withoutCrlf
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r');
      return segments[segments.length - 1];
    })
    .join('\n');
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
