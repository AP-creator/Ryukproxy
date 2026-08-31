import { describe, it, expect } from 'vitest';
import { scrubRequestBody } from '../src/scrub-body.js';
import type { AnthropicRequestBody } from '../src/types.js';

describe('scrubRequestBody', () => {
  it('scrubs a string-form tool_result content block', () => {
    const body: AnthropicRequestBody = {
      system: 'you are a helpful assistant',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'abc',
              content: 'line\rline\rDone',
            },
          ],
        },
      ],
    };
    const result = scrubRequestBody(body);
    const block = (result.messages[0].content as any[])[0];
    expect(block.content).toBe('Done');
  });

  it('scrubs only type:"text" sub-blocks of an array-form tool_result, leaving others alone', () => {
    const body: AnthropicRequestBody = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'xyz',
              content: [
                { type: 'text', text: 'noisy\rnoisy\rDone' },
                { type: 'image', source: { data: 'base64==' } },
              ],
            },
          ],
        },
      ],
    };
    const result = scrubRequestBody(body);
    const block = (result.messages[0].content as any[])[0];
    expect(block.content[0]).toEqual({ type: 'text', text: 'Done' });
    expect(block.content[1]).toEqual({ type: 'image', source: { data: 'base64==' } });
  });

  it('leaves a non-tool_result block alone even when it carries a content field', () => {
    // isToolResultBlock is the only thing keeping the scrubber off other block
    // types, and a block type with its own `content` is exactly where that
    // guard earns its keep.
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', content: 'looks\rlike\rnoise' },
            { type: 'tool_result', tool_use_id: 'a', content: 'is\rreally\rnoise' },
          ],
        },
      ],
    } as unknown as AnthropicRequestBody;

    const blocks = scrubRequestBody(body).messages[0].content as any[];

    expect(blocks[0].content).toBe('looks\rlike\rnoise');
    expect(blocks[1].content).toBe('noise');
  });

  it('keeps scrubbing the other messages when one message is malformed', () => {
    // Spec, "Error handling": a scrubber failure on a given block falls back to
    // passing THAT BLOCK through unmodified. Throwing out of the whole walk
    // instead costs the entire conversation its savings, on every turn from
    // then on, because Claude Code replays the same history each time.
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x\rx\rDone' }],
        },
        // content is neither a string nor an array -- .map() would throw here.
        { role: 'user', content: null },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'b', content: 'y\ry\rAlso done' }],
        },
      ],
    } as unknown as AnthropicRequestBody;

    const result = scrubRequestBody(body);

    expect((result.messages[0].content as any[])[0].content).toBe('Done');
    expect(result.messages[1].content).toBeNull();
    expect((result.messages[2].content as any[])[0].content).toBe('Also done');
  });

  it('keeps scrubbing the other blocks when one block in the same message is malformed', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'x\rx\rDone' },
            // A null sub-block makes the array walk throw on sub.type.
            { type: 'tool_result', tool_use_id: 'bad', content: [null] },
            { type: 'tool_result', tool_use_id: 'c', content: 'y\ry\rAlso done' },
          ],
        },
      ],
    } as unknown as AnthropicRequestBody;

    const result = scrubRequestBody(body);
    const blocks = result.messages[0].content as any[];

    expect(blocks[0].content).toBe('Done');
    expect(blocks[1].content).toEqual([null]);
    expect(blocks[2].content).toBe('Also done');
  });

  it('returns a body with no messages array unchanged rather than throwing', () => {
    // /v1/models and friends have no messages at all; that is not an error.
    const body = { model: 'claude-opus-4' } as unknown as AnthropicRequestBody;
    expect(scrubRequestBody(body)).toEqual(body);
  });

  it('leaves system, non-tool_result blocks, and string-only messages untouched', () => {
    const body: AnthropicRequestBody = {
      system: 'unchanged system prompt',
      tools: [{ name: 'bash' }],
      messages: [
        { role: 'user', content: 'plain string message' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'assistant reply' }],
        },
      ],
    };
    const result = scrubRequestBody(body);
    expect(result).toEqual(body);
  });
});
