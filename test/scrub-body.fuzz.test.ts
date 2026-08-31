import { describe, it, expect } from 'vitest';
import { parse as losslessParse, stringify as losslessStringify } from 'lossless-json';
import { scrubRequestBody } from '../src/scrub-body.js';
import type { AnthropicRequestBody } from '../src/types.js';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: T[]): T {
  return items[Math.floor(random() * items.length)];
}

/** Strings with nothing in them the scrubber is allowed to touch. */
function quietString(random: () => number): string {
  const pieces = ['ok', 'done', 'line one', 'café 世界', 'a\tb', 'x\ny', 'p\r\nq', '', '{"n":1}'];
  let out = '';
  for (let i = 0, n = Math.floor(random() * 4); i <= n; i++) out += pick(random, pieces);
  return out;
}

/** Anything at all, including shapes the walker has no business understanding. */
function junk(random: () => number, depth: number): unknown {
  const roll = random();
  if (depth > 3 || roll < 0.25) {
    return pick(random, [null, true, false, 0, -1, 42, 'text', '\x1b[2K\rnoise', 'a\rb', '']);
  }
  if (roll < 0.55) {
    return Array.from({ length: Math.floor(random() * 4) }, () => junk(random, depth + 1));
  }
  const object: Record<string, unknown> = {};
  for (let i = 0, n = Math.floor(random() * 4); i < n; i++) {
    object[pick(random, ['type', 'content', 'text', 'role', 'tool_use_id', 'k'])] = junk(
      random,
      depth + 1
    );
  }
  return object;
}

function quietMessage(random: () => number): unknown {
  const roll = random();
  if (roll < 0.2) return { role: 'user', content: quietString(random) };
  if (roll < 0.5) {
    return {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: quietString(random) },
        { type: 'text', text: quietString(random) },
      ],
    };
  }
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't2',
        content: [
          { type: 'text', text: quietString(random) },
          { type: 'image', source: { type: 'base64', data: 'aGk=' } },
        ],
      },
    ],
  };
}

describe('scrubRequestBody invariants (fuzz)', () => {
  it('is a byte-for-byte no-op on bodies whose tool_results hold no noise', () => {
    // The end-to-end guarantee the server depends on: parse -> scrub ->
    // stringify must reproduce the exact bytes when there was nothing to
    // remove. Anything else would change the cached prefix on every turn.
    const random = mulberry32(0x1234);
    for (let i = 0; i < 300; i++) {
      const body = {
        model: 'claude-opus-4',
        max_tokens: 4096,
        system: quietString(random),
        messages: Array.from({ length: Math.floor(random() * 4) }, () => quietMessage(random)),
      };
      const json = JSON.stringify(body);

      const scrubbed = losslessStringify(
        scrubRequestBody(losslessParse(json) as AnthropicRequestBody)
      );

      expect(scrubbed, `seed 0x1234, iteration ${i}, body ${json}`).toBe(json);
    }
  });

  it('never throws, whatever shape the body turns out to be', () => {
    // A throw here means the server falls back to forwarding the whole body
    // unscrubbed -- for the rest of the conversation, since the same history
    // is replayed every turn.
    const random = mulberry32(0x9abc);
    for (let i = 0; i < 500; i++) {
      const body = junk(random, 0) as AnthropicRequestBody;
      expect(
        () => scrubRequestBody(body),
        `seed 0x9abc, iteration ${i}, body ${JSON.stringify(body)}`
      ).not.toThrow();
    }
  });

  it('leaves a body it cannot walk exactly as it found it', () => {
    const random = mulberry32(0xdef0);
    for (let i = 0; i < 300; i++) {
      const body = { messages: junk(random, 1) } as unknown as AnthropicRequestBody;
      const before = JSON.stringify(body);

      const result = scrubRequestBody(body);

      // The input object itself must not be mutated, whatever is returned.
      expect(JSON.stringify(body), `seed 0xdef0, iteration ${i}`).toBe(before);
      if (!Array.isArray((body as { messages?: unknown }).messages)) {
        expect(result, `seed 0xdef0, iteration ${i}`).toBe(body);
      }
    }
  });
});
