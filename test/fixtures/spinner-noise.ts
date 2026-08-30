const ESC = '\x1b';
const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'];

function frame(glyph: string): string {
  return `${ESC}[1G${ESC}[J${glyph}  Cloning repository…`;
}

const redrawFrames = Array.from({ length: 40 }, (_, i) =>
  frame(SPINNER_FRAMES[i % SPINNER_FRAMES.length])
).join('\r');

export const SPINNER_NOISE_FIXTURE =
  `${ESC}[?25l│\n` +
  `◇  Source: https://github.com/example/example-skills.git\n` +
  `${ESC}[?25h${ESC}[?25l│\n` +
  `${redrawFrames}\r${ESC}[1G${ESC}[J◇  Repository cloned\n` +
  `${ESC}[?25h│\n` +
  `${ESC}[1G${ESC}[J◇  Found 4 skills\n`;

export const SPINNER_NOISE_EXPECTED =
  '│\n' +
  '◇  Source: https://github.com/example/example-skills.git\n' +
  '│\n' +
  '◇  Repository cloned\n' +
  '│\n' +
  '◇  Found 4 skills\n';

// A second, structurally different noise shape: a single-line progress bar
// redrawn with erase-line + carriage return (npm/pip/curl style), rather than
// the braille spinner above. It exercises the erase-line path, which the
// spinner fixture does not, so a regression there can't hide behind the
// spinner's savings figure.
const progressFrames = [0, 20, 40, 60, 80, 100].map(
  (pct) => `${ESC}[2K\r[${'#'.repeat(pct / 10).padEnd(10, ' ')}] ${pct}%`
);

export const PROGRESS_BAR_NOISE_FIXTURE =
  progressFrames.join('') + '\n' + 'Downloaded 42 packages in 6.1s\n';

export const PROGRESS_BAR_NOISE_EXPECTED =
  '[##########] 100%\n' + 'Downloaded 42 packages in 6.1s\n';
