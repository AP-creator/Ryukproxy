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
