# Ryukproxy — Design

**Date:** 2026-07-16
**Status:** Approved for planning

## Problem

Claude Code sessions accumulate token-costly noise inside captured tool output. Concretely observed in a real session: running `npx skills add ...` embedded dozens of repeated ANSI spinner-redraw frames (`◒ Cloning repository…◐ Cloning repository…◓ ...`) into the conversation's `tool_result` blocks — pure terminal-rendering noise, carrying zero information, billed at full token cost on every subsequent turn that includes that history.

pxpipe (github.com/teamchong/pxpipe) addresses token cost in a different, riskier way: it converts bulky context into lossy PNG images before sending to the model. Its own benchmark shows ~13/15 hex strings misread after the image round-trip — unacceptable for a tool that will see code, hashes, and secrets in tool output.

## Goal

A local dev tool, run in front of Claude Code's own API traffic, that removes only unambiguous rendering noise from outgoing requests — losslessly. No semantic compression, no summarization, no image conversion.

## Non-goals

- Not a general Anthropic API cost-reduction product for arbitrary third-party apps (personal dev tool for Claude Code specifically).
- Not lossy. No technique that can alter, reinterpret, or drop meaningful content ships in v1.
- Not a `cache_control` optimizer. Deferred — see Future Work.

## Architecture

```
Claude Code → ANTHROPIC_BASE_URL=http://127.0.0.1:8931 → [Ryukproxy] → api.anthropic.com
```

Default port: `8931` (configurable via `RYUKPROXY_PORT`).

Ryukproxy only rewrites the **outgoing request body**. Responses stream back byte-for-byte untouched, so it can never alter what the model says. The Anthropic API key passes through in headers unmodified; Ryukproxy never reads, logs, or stores it.

## Components

1. **Server** — local HTTP listener (Node.js + TypeScript) on `127.0.0.1:<port>`. Accepts Claude Code's requests to `/v1/messages` and forwards upstream.
2. **Scrubber** — pure function operating on the parsed request body. Walks every `tool_result` content block in `messages[]` (a `tool_result` block's `content` is either a raw string or an array of sub-blocks — the scrubber processes the string case and every `type: "text"` sub-block in the array case; non-text sub-blocks, e.g. images, are left alone) and applies only these transforms:
   - Strip ANSI/cursor-control escape sequences (`\x1b[...`)
   - Collapse `\r`-redrawn lines to their final rendered state
   - Collapse **consecutive** duplicate lines only (line N+1 identical to line N) — never deduplicates repeats separated by other content, since that would require judgment about what's safe to remove

   Everything else — `system`, tool definitions, the user's and Claude's own messages, and any `tool_result` content that doesn't match a known noise pattern — passes through unmodified. The scrubber has no code path that can remove or rewrite content it doesn't recognize as noise.
3. **Forwarder** — sends the scrubbed body upstream with original headers intact (`x-api-key`, `anthropic-version`, etc.). Pipes the (streaming) response back unmodified.
4. **Logger** — appends `{timestamp, bytesBefore, bytesAfter}` per request to a local JSONL file (`~/.ryukproxy/events.jsonl`). Never logs request/response content or the API key.

## Data flow

1. Claude Code sends `POST /v1/messages` to `127.0.0.1:<port>` with the full JSON body.
2. Ryukproxy parses the JSON and runs the scrubber over `tool_result` blocks only.
3. Ryukproxy forwards the scrubbed body upstream with original headers.
4. Anthropic's streaming response is piped straight back to Claude Code, untouched.
5. Ryukproxy logs byte-count-before/after for that request.

## Error handling

- Scrubber failures on a given block (malformed/unexpected structure) fall back to passing that block through unmodified — a bug degrades to "no savings this request," never to corrupted content.
- Upstream errors (network failure, non-200, rate limit) pass straight through to Claude Code unchanged.
- If Ryukproxy itself fails to start, the launcher (see below) falls back to running Claude Code directly against `api.anthropic.com` rather than blocking startup.
- Logging never writes request/response bodies or the API key — sizes only.

## Auto-start ("on by default every session")

A `SessionStart` hook cannot set `ANTHROPIC_BASE_URL` for its own session — hook subprocess env changes don't propagate to the already-starting parent process. `ANTHROPIC_BASE_URL` must be set before Claude Code launches.

**Chosen approach: wrapper launcher.** A small `claude` wrapper script:
1. Checks whether Ryukproxy is already running via a pidfile (`~/.ryukproxy/ryukproxy.pid`); starts it in the background if not.
2. Execs the real `claude` binary with `ANTHROPIC_BASE_URL=http://127.0.0.1:8931` set for that invocation only.
3. If Ryukproxy fails to start (port conflict, crash), falls back to exec-ing `claude` unmodified — never blocks the user from starting a session.

No persistent global environment mutation; trivially bypassed by invoking the real `claude` binary directly; nothing to clean up if abandoned.

## Testing

- Unit tests for the scrubber using the actual spinner-noise sample captured from this session as a fixture. Assert noise is stripped and all other content survives byte-for-byte.
- Integration test: Ryukproxy against a mock upstream server. Assert the scrubbed body arrives as expected and streaming passthrough is untouched end-to-end.
- A savings-regression test against the real fixture, so a future change that weakens scrubbing is caught by CI rather than discovered later.

## Future work (explicitly out of scope for v1)

- Analyzing and improving `cache_control` breakpoint placement in Claude Code's own requests for better cache-hit rates.
- Passive-analyzer mode (report bloat from exported transcripts without live proxying).
