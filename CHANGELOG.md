# Changelog

## 0.8.5 — 2026-08-28

Folds in behaviour that had been living as a downstream `dist/` patch
(`patches/honidev@0.8.4.patch`, applied via bun `patchedDependencies` in the
consuming monorepo). Patching built output cannot survive a release and is
invisible to this repo's tests: a surface that moved out of the monorepo lost
the patch silently and only found out from three failing guard tests. Nothing
below is new behaviour for those consumers — it is the same code, now with a
home, types and tests.

### Added

- **`openrouter/*` models.** Any OpenRouter catalogue id behind the prefix
  (`openrouter/anthropic/claude-haiku-4.5`, …), served over OpenRouter's
  OpenAI-compatible endpoint. Requires `OPENROUTER_API_KEY`.
  - `OPENROUTER_REASONING` (raw JSON) injects OpenRouter's `reasoning` body
    param — the knob that disables thinking on models honouring it
    (`{"effort":"minimal"}` for gemini-3.6-flash, `{"enabled":false}` for qwen).
  - `OPENROUTER_REASONING_RETRY` escalates that config on an empty-stream retry
    only, so the fast path keeps its TTFT and only the rescue pays.
  - `OPENROUTER_STRICT_TOOLS=1` rewrites tool schemas into OpenAI's strict
    shape — gpt-5-family models reject tools otherwise.
  - `OPENROUTER_RETRY_EMPTY=1` re-issues a stream that closed cleanly with zero
    output.
  - 429s (OpenRouter's new-account rate caps) are absorbed with header-aware
    backoff before any stream starts, so a turn gets slower rather than dying
    mid-stream.
- **`GOOGLE_THINKING_CONFIG` / `GOOGLE_THINKING_CONFIG_RETRY`** inject
  `generationConfig.thinkingConfig` into every Gemini request. This cannot go
  through `modelSettings.providerOptions`: `@ai-sdk/google`'s provider-options
  schema admits only `thinkingBudget`/`includeThoughts` and silently strips
  unknown keys, so `thinkingLevel` (the 3.x control) can only reach the wire
  here. Malformed JSON throws at resolve rather than on the wire.
- **`GOOGLE_RETRY_EMPTY=1`** — the same empty-stream retry for the Google
  direct API, where `gemini-3.5-flash-lite` at `thinkingLevel: minimal`
  intermittently returns `MALFORMED_RESPONSE` with zero output.

### Fixed

- **Gemini 3.x post-tool-call turns no longer 400.** The API rejects any
  history `functionCall` part without a `thoughtSignature`, and `@ai-sdk/google`
  predates signatures entirely (strips them from responses, never replays
  them). Google's documented bypass sentinel is now injected into
  signature-less parts, so the wrapper is installed on every `gemini-*` model
  regardless of thinking config.
- **`ThreadMemory.append` survives unclonable decoration.** DO storage uses the
  v8 structured-clone serializer, which throws on functions — seen live as
  `DataCloneError` at `working_memory.save` when a `ZodError` (carrying its own
  issue-pusher closure) rode an invalid-tool-args marker into a tool call's
  args. Messages are provider-wire JSON semantically, so a round-trip before
  `put` is lossless for real content and drops only the unclonable decoration
  instead of killing the turn.
- **A failing stream no longer masks its own cause.** The error crosses the
  DO → Worker boundary and is structured-cloned; a rich error graph throws
  `DataCloneError` at the consumer's `read()`. Errors are now probed for
  clonability and flattened ONLY when they cannot survive, so ordinary errors
  keep their class — a consumer catching `TypeError`/`RangeError` still gets one.
- **`gemini-*` without `GOOGLE_AI_API_KEY` fails at resolve**, naming the
  variable, instead of surfacing as an anonymous per-turn 401/403. Google 4xx
  bodies (which name the offending field, never conversation content) are
  logged, so a caller's content-free logging no longer reduces every failure to
  an opaque `AI_APICallError`.

## 0.8.4 — 2026-08-13

### Fixed

- Workers AI partner-catalog ids (`google/*`, and now `anthropic/*`) no longer route
  through `workers-ai-provider`, whose native-schema translation broke partner models
  both ways: tool payloads were rejected with a 400 "User Input Error", and streamed
  responses collapsed to a single delta (measured live against
  `google/gemini-3.5-flash-lite`). Partner ids now use the provider family's own AI SDK
  package — `@ai-sdk/openai` for `google/*` (the partner endpoint accepts OpenAI
  chat.completions), `@ai-sdk/anthropic` for `anthropic/*` (the Messages API passes
  through natively) — with a fetch that hands the request to `binding.run()`: the
  binding does auth + unified billing, the provider does the schema, and tool-call
  streaming (`b:`/`c:` parts) works.

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
