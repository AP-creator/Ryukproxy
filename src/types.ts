export interface TextContentBlock {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextContentBlock | { type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type MessageContentBlock = ToolResultContentBlock | { type: string; [key: string]: unknown };

export interface Message {
  role: string;
  content: string | MessageContentBlock[];
  [key: string]: unknown;
}

export interface AnthropicRequestBody {
  messages: Message[];
  [key: string]: unknown;
}
