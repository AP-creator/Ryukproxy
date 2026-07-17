import { scrubToolResultText } from './scrubber.js';
import type {
  AnthropicRequestBody,
  Message,
  MessageContentBlock,
  ToolResultContentBlock,
  TextContentBlock,
} from './types.js';

function isToolResultBlock(block: MessageContentBlock): block is ToolResultContentBlock {
  return block.type === 'tool_result';
}

function scrubToolResultBlock(block: ToolResultContentBlock): ToolResultContentBlock {
  if (typeof block.content === 'string') {
    return { ...block, content: scrubToolResultText(block.content) };
  }
  if (Array.isArray(block.content)) {
    const scrubbedSubBlocks = block.content.map((sub) =>
      sub.type === 'text'
        ? { ...sub, text: scrubToolResultText((sub as TextContentBlock).text) }
        : sub
    );
    return { ...block, content: scrubbedSubBlocks };
  }
  return block;
}

function scrubMessage(message: Message): Message {
  if (typeof message.content === 'string') {
    return message;
  }
  const content = message.content.map((block) =>
    isToolResultBlock(block) ? scrubToolResultBlock(block) : block
  );
  return { ...message, content };
}

export function scrubRequestBody(body: AnthropicRequestBody): AnthropicRequestBody {
  return { ...body, messages: body.messages.map(scrubMessage) };
}
