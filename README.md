# Ryukproxy

A local HTTP proxy that sits in front of Claude Code's own traffic to
`api.anthropic.com` and strips terminal-rendering noise out of `tool_result`
blocks before they are sent — **losslessly**.

Running something like `npx skills add ...` inside a Claude Code session
embeds dozens of ANSI spinner-redraw frames into the captured tool output:

```
◒ Cloning repository…◐ Cloning repository…◓ Cloning repository…◑ Cloning repository…
```

That is pure rendering noise carrying zero information, and it is billed at
full token cost on *every subsequent turn* that replays the conversation
history. Ryukproxy removes it on the way out.

On the captured spinner fixture in `test/fixtures/`, scrubbing takes the block
from 1512 bytes to 114 — a 92.5% reduction. Real-world savings depend entirely
on how much spinner output a session captures; CI enforces a 60% floor on that
fixture so a change that weakens scrubbing fails the build.

## Guarantees

- **Lossless only.** No summarization, no semantic compression, no image
  conversion. The scrubber has no code path that removes content it does not
  recognize as terminal-redraw noise.
- **Requests only.** Responses stream back byte-for-byte untouched, so
  Ryukproxy can never alter what the model says.
- **`tool_result` only.** `system`, tool definitions, your messages, and
  Claude's messages pass through unmodified.
- **Your API key is never read, logged, or stored.** It passes through in the
  headers as-is.
- **Fails open.** A scrubber error, a malformed body, or a proxy that won't
  start degrades to "no savings", never to a blocked session or corrupted
  content.

## What gets scrubbed

Only inside `tool_result` content (a raw string, or the `type: "text"`
sub-blocks of an array — images and other sub-block types are left alone):

1. **ANSI/CSI escape sequences** are stripped.
2. **Carriage-return redraws** collapse to their final rendered state — a bare
   `\r` overwrites what came before it on that line.
3. **Consecutive duplicate lines** collapse, *but only when both lines were
   actual redraws* (they carried a cursor-movement/erase escape or a bare
   `\r`). Two genuinely emitted identical lines — two `PASS` results, a linter
   repeating one message for two locations — survive untouched. Colour-only
   SGR codes do not count as a redraw, and blank lines are never collapsed.

Duplicates separated by other content are never touched: deciding those are
safe to drop would require judgement about meaning.

## Install

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm link          # puts `ryukproxy` on your PATH
```

## Usage

Run your session through the wrapper instead of calling `claude` directly:

```bash
ryukproxy               # same as `claude`
ryukproxy --print "hi"  # every argument is passed straight through
```

The wrapper:

1. Checks `~/.ryukproxy/ryukproxy.pid` and starts the proxy in the background
   if it isn't already running, waiting (up to ~2s) for it to actually
   accept connections.
2. Execs the real `claude` binary with
   `ANTHROPIC_BASE_URL=http://127.0.0.1:8931` set **for that invocation only**.
3. Falls back to launching `claude` untouched if the proxy fails to start
   (port conflict, crash) — it never blocks you from starting a session.

Nothing global is mutated; `claude` invoked directly still goes straight to
`api.anthropic.com`, and there is nothing to clean up if you stop using it.

To make it the default, alias it in your shell profile:

```bash
alias claude='ryukproxy'
```

You can also run the proxy on its own (without the wrapper) and point any
client at it:

```bash
npm run dev             # or: node dist/index.js
ANTHROPIC_BASE_URL=http://127.0.0.1:8931 claude
```

## Configuration

| Variable                 | Default                      | Purpose                                     |
| ------------------------ | ---------------------------- | ------------------------------------------- |
| `RYUKPROXY_PORT`         | `8931`                       | Port the proxy listens on (127.0.0.1 only). |
| `RYUKPROXY_UPSTREAM_URL` | `https://api.anthropic.com`  | Upstream API base URL.                      |
| `RYUKPROXY_LOG_PATH`     | `~/.ryukproxy/events.jsonl`  | Where byte-count events are appended.       |

## Logging

One JSONL line per request, sizes only — never content, never the API key:

```json
{"timestamp":"2026-07-16T12:00:00.000Z","bytesBefore":48211,"bytesAfter":9033}
```

Logging is best-effort; a failure to write is reported on stderr and never
affects a response that has already been sent.

## Development

```bash
npm test          # vitest, includes the savings-regression test
npm run typecheck # tsc --noEmit
npm run build     # emit dist/
```

CI runs all three on Node 22.x and 24.x for every push and pull request.

## Known limitations

- The pidfile check can produce a false positive if the OS recycles the
  recorded PID for an unrelated process, and two wrappers launched at the same
  instant can race and both spawn a proxy. Both are deliberately deferred: the
  cost is a stray process, not a broken session.
- The proxy speaks plain HTTP, bound to `127.0.0.1` only. It is a local dev
  tool, not a shared or network-exposed service.
- A query string on `RYUKPROXY_UPSTREAM_URL` itself is not merged into the
  forwarded request; a base *path* prefix is preserved, a base query is not.

## Out of scope (for now)

- Tuning `cache_control` breakpoint placement for better cache-hit rates.
- A passive-analyzer mode that reports bloat from exported transcripts without
  proxying anything live.

Design notes live in `docs/superpowers/specs/` and the task-by-task build plan
in `docs/superpowers/plans/`.
