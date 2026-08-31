import { scrubToolResultText } from './scrubber.js';
import type {
  AnthropicRequestBody,
  Message,
  MessageContentBlock,
  ToolResultContentBlock,
  TextContentBlock,
} from './types.js';

function isToolResultBlock(block: MessageContentBlock): block is ToolResultContentBlock {
  return block?.type === 'tool_result';
}

/**
 * Run a transform, falling back to the untouched original if it throws.
 *
 * The spec's error handling is per block, not per request: a block the scrubber
 * cannot make sense of passes through unmodified while everything around it is
 * still scrubbed. Letting the throw escape the whole walk instead would cost the
 * entire conversation its savings -- and keep costing them, since Claude Code
 * replays the same history on every subsequent turn.
 */
function orOriginal<T>(value: T, transform: (value: T) => T): T {
  try {
    return transform(value);
  } catch {
    return value;
  }
}

function scrubToolResultBlock(block: ToolResultContentBlock): ToolResultContentBlock {
  if (typeof block.content === 'string') {
    return { ...block, content: scrubToolResultText(block.content) };
  }
  if (Array.isArray(block.content)) {
    const scrubbedSubBlocks = block.content.map((sub) =>
      orOriginal(sub, (s) =>
        s.type === 'text' ? { ...s, text: scrubToolResultText((s as TextContentBlock).text) } : s
      )
    );
    return { ...block, content: scrubbedSubBlocks };
  }
  return block;
}

function scrubMessage(message: Message): Message {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const content = message.content.map((block) =>
    orOriginal(block, (b) => (isToolResultBlock(b) ? scrubToolResultBlock(b) : b))
  );
  return { ...message, content };
}

export function scrubRequestBody(body: AnthropicRequestBody): AnthropicRequestBody {
  // A body with no messages array isn't an error — plenty of endpoints have
  // none — so leave it exactly as it came.
  if (!Array.isArray(body?.messages)) {
    return body;
  }
  return { ...body, messages: body.messages.map((m) => orOriginal(m, scrubMessage)) };
}
