# Changelog

## 0.8.0 — 2026-08-12

### Added

- Invalid AI SDK tool calls now get one model-side repair attempt using the same model before the stream fails.
- `tool()` accepts an optional `onInvalidArguments(rawArgs, zodError)` callback. Return a tool result to let the model self-correct within `maxSteps`, or `null` to use the default repair attempt.
- Observability collectors receive `tool.repair` events with the tool, attempt number, and repair outcome.
- Terminal tool-related SSE error frames include the public error name and tool name, such as `InvalidToolArgumentsError:submitRatings:`.

### Compatibility

- Existing tool definitions remain source-compatible.
- Valid tool calls keep their existing handler and observability behavior, with no repair request and no changes to cache-sensitive system, message, or tool references.
