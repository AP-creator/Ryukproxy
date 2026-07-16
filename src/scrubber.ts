const ANSI_CSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_CSI_PATTERN, '');
}
