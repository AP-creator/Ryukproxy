import { describe, it, expect } from 'vitest';
import { scrubToolResultText } from '../src/scrubber.js';

/**
 * Seeded so a failure is reproducible: the seed and the offending input are
 * both printed with the assertion.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ESC = '\x1b';

// Everything the scrubber must never touch. Excludes a BARE \r and ESC, but
// deliberately includes CRLF: a \r immediately before a \n is a line
// terminator, not a redraw marker, and must survive byte for byte. Leaving it
// out would let a scrubber that rewrites every CRLF to LF pass this fuzz.
const QUIET_CHARS = [
  ...'abcdefghijklmnopqrstuvwxyzABCXYZ0123456789',
  ...' \t.,;:!?()[]{}<>/\\|@#$%^&*-_=+"\'`~',
  '\n',
  '\n',
  '\r\n',
  '\r\n',
  'é',
  '世',
  '\u{1f389}',
  '─',
];

// Escape sequences real terminal output emits, plus malformed ones -- captured
// output is not guaranteed to be well formed.
const ESCAPES = [
  ESC + '[K',
  ESC + '[2K',
  ESC + '[1G',
  ESC + '[J',
  ESC + '[2A',
  ESC + '[32m',
  ESC + '[0m',
  ESC + '[?25l',
  ESC + '[?25h',
  ESC + '[10;20H',
  ESC, // a bare ESC is not a recognised sequence and must survive
  ESC + 'X',
];

function pick<T>(random: () => number, items: T[]): T {
  return items[Math.floor(random() * items.length)];
}

function randomQuietText(random: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += pick(random, QUIET_CHARS);
  return out;
}

function randomNoisyText(random: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const roll = random();
    if (roll < 0.15) out += pick(random, ESCAPES);
    else if (roll < 0.3) out += '\r';
    else out += pick(random, QUIET_CHARS);
  }
  return out;
}

/**
 * The scrubber may only ever DELETE. If every character of the output can be
 * matched, in order, against the input, then nothing was inserted, reordered,
 * or substituted -- whatever survived is genuinely the original bytes.
 */
function isSubsequence(candidate: string, source: string): boolean {
  const target = Array.from(candidate);
  let index = 0;
  for (const char of source) {
    if (index < target.length && target[index] === char) index++;
  }
  return index === target.length;
}

describe('scrubToolResultText invariants (fuzz)', () => {
  it('returns text containing no redraw markers byte-identical', () => {
    const random = mulberry32(0xc0ffee);
    for (let i = 0; i < 500; i++) {
      const input = randomQuietText(random, Math.floor(random() * 200));
      expect(scrubToolResultText(input), `seed 0xc0ffee, iteration ${i}`).toBe(input);
    }
  });

  it('only ever deletes: output is always a subsequence of the input', () => {
    const random = mulberry32(0x5eed);
    for (let i = 0; i < 500; i++) {
      const input = randomNoisyText(random, Math.floor(random() * 300));
      const output = scrubToolResultText(input);
      expect(
        isSubsequence(output, input),
        `seed 0x5eed, iteration ${i}, input ${JSON.stringify(input)} -> ${JSON.stringify(output)}`
      ).toBe(true);
    }
  });

  it('never grows the text', () => {
    const random = mulberry32(0xbeef);
    for (let i = 0; i < 500; i++) {
      const input = randomNoisyText(random, Math.floor(random() * 300));
      expect(
        scrubToolResultText(input).length,
        `seed 0xbeef, iteration ${i}, input ${JSON.stringify(input)}`
      ).toBeLessThanOrEqual(input.length);
    }
  });

  it('is idempotent on arbitrary noisy input', () => {
    // Claude Code replays history every turn; unstable output would invalidate
    // the prompt cache on each one.
    const random = mulberry32(0xfeed);
    for (let i = 0; i < 500; i++) {
      const input = randomNoisyText(random, Math.floor(random() * 300));
      const once = scrubToolResultText(input);
      expect(
        scrubToolResultText(once),
        `seed 0xfeed, iteration ${i}, input ${JSON.stringify(input)}`
      ).toBe(once);
    }
  });
});
