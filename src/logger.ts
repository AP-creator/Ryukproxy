import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface ScrubEvent {
  timestamp: string;
  bytesBefore: number;
  bytesAfter: number;
}

export const DEFAULT_LOG_PATH = join(homedir(), '.ryukproxy', 'events.jsonl');

export async function logScrubEvent(event: ScrubEvent, logPath: string = DEFAULT_LOG_PATH): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const line = JSON.stringify({
    timestamp: event.timestamp,
    bytesBefore: event.bytesBefore,
    bytesAfter: event.bytesAfter,
  });
  await appendFile(logPath, line + '\n', 'utf8');
}
