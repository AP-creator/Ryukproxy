#!/usr/bin/env node
// Dedicated bin entrypoint. Unlike the import.meta/argv guard inside wrapper.ts
// (which only fires when the path node received matches the resolved module URL
// exactly — fragile across npm's global shim, where casing/symlink differences
// make them differ and silently no-op), this file is only ever run as the
// program, so it can invoke the launcher unconditionally.
import { runClaudeWithProxy } from './wrapper.js';

void runClaudeWithProxy(process.argv.slice(2));
