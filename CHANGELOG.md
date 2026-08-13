# Changelog

## 0.8.3 — 2026-08-13

### Fixed

- Republish of 0.8.2, whose npm tarball shipped a stale `dist/` carrying none of its
  advertised changes (no `prepublishOnly` hook meant the publishing checkout's last local
  build went out). `prepublishOnly` now rebuilds and tests before every publish. 0.8.2 is
  deprecated on npm — its features below only actually exist from 0.8.3.

## 0.8.2 — 2026-08-13 (deprecated: published with stale dist)

### Added

- `modelSettings.toolCallStreaming` streams tool calls incrementally: the data-protocol
  response emits a tool-call-streaming-start part (`b:`) the moment the model begins
  composing a tool call, plus argument deltas (`c:`), instead of a single `9:` part only
  after the arguments fully generate. Built for realtime consumers that flush buffered
  speech when the tool phase starts.
- Workers AI partner-catalog model ids (`google/*`, e.g. `google/gemini-3.5-flash-lite`)
  route through the AI binding with Cloudflare unified billing — no provider API key.

## 0.8.1 — 2026-08-13

### Added

- Agent turns now emit phase timings for model resolution, tool setup, history loading,
  semantic/recursive/graph memory, prompt construction, provider stream creation, first output,
  every model step, persistence, and the complete turn.
- `captureEvents: false` streams events through `onEvent` without retaining an unbounded
  isolate-local event history.
- `modelSettings` exposes AI SDK generation controls and its provider-specific `providerOptions`
  escape hatch, including thinking/reasoning controls, without Honi translating or dropping them.
- Async observers are attached to the Durable Object lifetime, while observer failures remain
  isolated from learner turns. Terminal events now cover success, persistence failure, provider
  stream failure, and cancellation without exposing raw error messages.

### Security

- Tool observability no longer records tool arguments or raw error messages. Events retain only
  the tool name, argument count, duration, outcome, and error class.

## 0.8.0 — 2026-08-12

### Added

- Invalid AI SDK tool calls now get one model-side repair attempt using the same model before the stream fails.
- `tool()` accepts an optional `onInvalidArguments(rawArgs, zodError)` callback. Return a tool result to let the model self-correct within `maxSteps`, or `null` to use the default repair attempt.
- Observability collectors receive `tool.repair` events with the tool, attempt number, and repair outcome.
- Terminal tool-related SSE error frames include the public error name and tool name, such as `InvalidToolArgumentsError:submitRatings:`.

### Compatibility

- Existing tool definitions remain source-compatible.
- Valid tool calls keep their existing handler and observability behavior, with no repair request and no changes to cache-sensitive system, message, or tool references.
