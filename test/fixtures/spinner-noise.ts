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
