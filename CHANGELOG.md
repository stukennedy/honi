# Changelog

## 0.9.0 — 2026-08-31

Migrates from AI SDK 4 to AI SDK 7 (`ai@^7`, provider packages at their
current majors). The driving reason is Gemini thought signatures: Gemini 3
rejects (400 `INVALID_ARGUMENT`) any history `functionCall` part without a
`thoughtSignature`, and the AI SDK 4-era `@ai-sdk/google` predated signatures
entirely, forcing honidev to patch request bodies in a fetch wrapper. On
`@ai-sdk/google@4` the provider owns the whole story natively.

### Changed — thought signatures (the headline)

- **Native `gemini-*` models now round-trip thought signatures.** The provider
  returns `providerOptions.google.thoughtSignature` on assistant tool-call
  parts; honidev's memory persists them as plain JSON and replays them next
  turn. New regression tests (`tests/thought-signature.test.ts`) pin all three
  legs: replay of a stored signature, response signatures surviving
  JSON persistence, and the fallback below.
- **honidev's fetch-level sentinel hack is gone.** For history with no
  signatures (threads saved by honidev < 0.9, or histories built by hand) the
  provider itself injects Google's documented
  `skip_thought_signature_validator` sentinel — old threads keep working with
  no action needed.

### Breaking — API renames inherited from AI SDK 5–7

- **Wire format:** `/chat` now streams the AI SDK UI message stream (SSE),
  consumed by `useChat()` from `@ai-sdk/react`. Consumers of the old v4 data
  protocol (`0:`/`9:`/`3:` frames) must migrate. Per-turn token usage rides
  the finish frame's `messageMetadata` (`{ usage, finishReason }`).
- **`ModelSettings.maxTokens` → `maxOutputTokens`.** Deprecated, not removed:
  a leftover `maxTokens` (e.g. from JSON-driven config) is mapped onto
  `maxOutputTokens` with a one-time warning rather than silently dropped —
  losing the output cap without a sound would be an unbounded-cost bug.
- **`ModelSettings.toolCallStreaming` deprecated and ignored** — tool-call
  streaming is always on in AI SDK 5+. The key is stripped before reaching
  the SDK.
- **Message type:** honidev's memory APIs (`ThreadMemory`, `EpisodicMemory`)
  now type messages as `ModelMessage` (was `CoreMessage`). Stored 0.8.x
  threads are upgraded ON LOAD (`upgradeLegacyMessage`): AI SDK 7 VALIDATES
  message shapes where v4 never did, so a stored v4 tool turn (`args`,
  `result`/`isError`) would otherwise throw `InvalidPromptError` on every
  subsequent turn of the thread. System messages seeded into history remain
  legal via `allowSystemInMessages`.
- **Peer dependencies:** optional provider packages must be on their AI SDK
  5-compatible majors (`@ai-sdk/groq@^4`, `@ai-sdk/deepseek@^3`, …); `zod`
  minimum is 3.25.76.
- **OpenAI-family models pin Chat Completions.** `gpt-*`, `azure/*` and the
  OpenAI-compatible bridges now call `.chat()` explicitly — the bare factory
  in `@ai-sdk/openai@4` defaults to the Responses API, which gateway/proxy
  routes don't uniformly support.

### Changed

- **Telemetry field names follow the SDK:** `agent.step` events carry
  `inputTokens`/`outputTokens` (was `promptTokens`/`completionTokens`);
  `agent.response` usage is the SDK's aggregated `LanguageModelUsage` (cache
  reads/writes now live in `usage.inputTokenDetails`).
- **Prompt-cache breakpoints ride `instructions`.** AI SDK 7 rejects system
  messages inside `messages`, so a cached system prompt is now passed as a
  `SystemModelMessage` (carrying `providerOptions`) via the `instructions`
  option instead of being moved into the message array. Behaviour on the wire
  is unchanged.
- **`GOOGLE_THINKING_CONFIG` stays on the fetch wrapper** even though
  `@ai-sdk/google@4` accepts `thinkingLevel` via providerOptions: the
  empty-stream retry escalation switches configs per request, which a static
  providerOptions value cannot express.
- **Tool execution failures still fail the turn (0.8.x parity).** AI SDK 5+
  converts a tool handler throw into a `tool-error` part and keeps the loop
  running — the model would recover in prose, the broken turn would persist
  to memory, and turn-level telemetry would report success. honidev restores
  the old contract: the loop stops after the failed step (no further model
  calls billed), nothing is persisted, `agent.turn.complete` reports
  `failed`, and the client receives a formatted error naming the tool
  (`ToolExecutionError:<tool>: <message>` — the SDK's own ToolExecutionError
  class was removed, so honidev ships its replacement).
- **A failed turn is never finalized on the wire.** The terminal `finish`
  part is held until the turn's fate is known (the SDK settles `onEnd` —
  where persistence runs — before closing the stream): a failed turn gets an
  `error` frame in place of `finish` and a rejected body, instead of a
  completed message followed by an inexplicable abort. AI SDK 7 swallows
  `onEnd` errors entirely; without this a lost memory write looked like a
  success everywhere but server-side telemetry.
- **Time-to-first-token telemetry ignores synthetic parts.** AI SDK 7 invokes
  `onChunk` for bookkeeping parts (`start`, `start-step`) enqueued before any
  provider I/O; `agent.stream.first_chunk` now latches only on genuine
  provider output, keeping the TTFT metric honest.
- **`stream_options` is stripped on the Workers AI binding path.**
  `@ai-sdk/openai@4` unconditionally adds `stream_options: {include_usage:
  true}` to streaming bodies (the v4-era `compatibility` opt-out is gone),
  and the partner endpoint's strict schema 400s on unexpected keys.

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
- **Cancellation reaches the provider.** With an empty-stream retry enabled the
  wrapper pumps eagerly in `start()`, so a consumer that cancelled — a client
  disconnecting mid-turn — left the upstream body locked and the model
  generating, and billing, until it finished on its own. Cancellation now
  propagates to the active reader; a cancelled stream never opens a retry (it
  reads as "no content", which would otherwise fire a fresh request for a
  consumer that has already gone); and a cancellation that lands DURING the
  network wait to open a retry — when there is no active reader to cancel —
  disposes of the stream it just opened instead of pumping it.
- **`OPENROUTER_STRICT_TOOLS` handles `$ref`/`oneOf`/`allOf` and `$defs`.**
  Optional properties of those shapes fell through the nullable conversion
  unchanged while still being moved into `required` — the same
  optional-becomes-mandatory trap as the enum case — and objects inside
  `$defs`/`definitions`, reachable only through `$ref`, were never rewritten at
  all, so a function marked `strict: true` was rejected before generation.

- **An empty-stream retry that starts emitting and then dies no longer closes
  cleanly.** Its parts are already downstream, so reporting success handed the
  consumer a truncated turn — and the give-up path then appended the FIRST
  attempt's held parts on top of them. The failure now propagates; a retry that
  dies before emitting anything still degrades to the documented give-up.
- **`OPENROUTER_STRICT_TOOLS` keeps optional enum/const arguments optional.**
  Strict mode moves every property into `required`, so an optional one survives
  only if the rewrite genuinely admits null — and a value must satisfy `type`
  AND `enum`/`const`, so widening `type` alone did not. Optional enums now gain
  a `null` member and optional consts become a union, instead of silently
  turning into mandatory arguments.

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
