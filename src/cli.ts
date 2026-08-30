#!/usr/bin/env node
// Dedicated bin entrypoint. Unlike the import.meta/argv guard inside wrapper.ts
// (which only fires when the path node received matches the resolved module URL
// exactly — fragile across npm's global shim, where casing/symlink differences
// make them differ and silently no-op), this file is only ever run as the
// program, so it can invoke the launcher unconditionally.
import { runClaudeWithProxy } from './wrapper.js';
import { runStatsCommand } from './stats.js';

const args = process.argv.slice(2);

// `stats` is Ryukproxy's own subcommand and is NOT forwarded to claude. Only a
// bare leading `stats` is intercepted; every other argument list — claude's own
// flags and subcommands included — passes through untouched, so the wrapper
// stays transparent.
if (args[0] === 'stats') {
  void runStatsCommand(args.slice(1));
} else {
  void runClaudeWithProxy(args);
}
