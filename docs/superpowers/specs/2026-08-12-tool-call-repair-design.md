# Tool Call Repair Design

## Summary

Honidev 0.8.0 will make invalid model-generated tool arguments recoverable without changing valid tool behavior or the existing public API. Ordinary tools will use AI SDK v4's native `experimental_repairToolCall` hook for one model-side repair attempt. Tools that opt into `onInvalidArguments` can instead turn a Zod validation failure into a normal tool result so the model can self-correct within the existing `maxSteps` loop.

The change is additive. Existing tools require no changes, valid tool calls continue through the same handlers, and failed repair retains the current stream-fatal outcome with a more useful SSE error payload.

## Public API

`tool()` and `ToolDefinition` gain one optional callback:

```ts
onInvalidArguments?: (
  rawArgs: unknown,
  zodError: z.ZodError,
) => unknown | Promise<unknown>;
```

The callback receives the parsed JSON value emitted by the model and the Zod error produced by the tool's declared input schema.

- A non-`null` return value is the tool result. The normal handler is not called, and AI SDK includes the result in the next model step.
- `null` declines local handling. Honidev attempts the same one-shot model repair used for ordinary tools.
- If that repair cannot produce valid arguments, the stream terminates as it does today.

`null` is reserved as the decline value and therefore cannot itself be used as a handled tool result. The callback is invoked only when JSON parsing succeeds but Zod validation fails. Malformed JSON remains eligible for the default AI SDK repair path but cannot supply a parsed `rawArgs` value to this callback.

If the callback throws or rejects, the exception follows ordinary tool-execution error semantics; Honidev does not interpret an exception as a request for model repair.

## Architecture

### Shared repair function

A focused repair helper will own the one-shot model interaction. It receives the AI SDK repair context, the original tool definition, the resolved model, and optional observability context.

For `NoSuchToolError`, it returns `null` without asking the model. For `InvalidToolArgumentsError`, it:

1. Parses the failing argument JSON when possible and validates it against the original Zod schema to obtain stable Zod issues.
2. Calls `generateText` exactly once with the same model instance.
3. Supplies the failing tool name and arguments, the tool's JSON Schema, and a corrective instruction of the form: `Your arguments for <tool> failed validation: <issues>. Return corrected arguments only.`
4. Parses and validates the returned JSON against the original Zod schema.
5. Returns the original tool call with only its `args` replaced when validation succeeds; otherwise returns `null`.

The helper catches generation, JSON parsing, and validation failures and returns `null`. This lets AI SDK rethrow the original invalid-arguments error rather than replacing it with `ToolCallRepairError`.

The repair request does not mutate or rebuild the primary stream's `system`, `messages`, or `tools` values. In particular, the cache-relevant prefix passed to `streamText` remains referentially stable.

### Ordinary tool path

Tools without `onInvalidArguments` continue to expose their Zod schema directly as AI SDK `parameters`. `streamText` receives `experimental_repairToolCall`, which delegates invalid calls to the shared repair helper. AI SDK validates the returned repaired call and executes the existing handler normally.

This path uses the SDK's intended v4 repair surface and leaves valid calls unchanged.

### `onInvalidArguments` path

AI SDK's repair hook can return only a repaired tool call, not a tool result. Opted-in tools therefore use an AI SDK custom schema whose public JSON Schema is identical to the tool's original Zod-derived JSON Schema, while its validator returns one of two internal values:

- the original schema's parsed value for valid input;
- a private validation-failure marker containing `rawArgs` and `ZodError` for invalid input.

The model sees the same schema either way. The wrapped `execute` function detects the marker before emitting a normal `tool.call` event or invoking the handler.

It first calls `onInvalidArguments`:

- A non-`null` result is returned directly as the tool result.
- `null` invokes the shared one-shot repair helper using the tool execution context's messages and tool-call ID. A successful repair is passed through the original Zod parser and then to the normal handler.
- Failed repair throws an `InvalidToolArgumentsError`. AI SDK may wrap it as a `ToolExecutionError`; error formatting will unwrap this chain.

The local callback itself does not consume an additional model call. Its result is a standard tool result, so any model self-correction consumes only the next step already governed by `maxSteps`.

## Error Frames

`toDataStreamResponse` will receive a `getErrorMessage` formatter. For tool-related errors, it follows AI SDK wrapper causes and `ToolCallRepairError.originalError` until it finds `InvalidToolArgumentsError`, `NoSuchToolError`, or `ToolExecutionError`.

The payload format is:

```text
<ErrorName>:<toolName>: <message>
```

Public names omit AI SDK's internal `AI_` prefix, producing payloads such as:

```text
InvalidToolArgumentsError:submitRatings: Invalid arguments for tool submitRatings: ...
```

Non-tool errors retain the AI SDK data stream's existing generic error behavior so the change does not disclose unrelated internal details.

## Observability

`HoniEventType` gains `tool.repair`. Every repair decision emits one event through the existing collector with:

```ts
{
  type: 'tool.repair',
  metadata: {
    tool: string,
    attempt: 1,
    outcome: 'repaired' | 'handled' | 'failed' | 'no-such-tool',
  },
}
```

- `handled`: `onInvalidArguments` returned a tool result.
- `repaired`: model-generated replacement arguments passed the original Zod schema.
- `failed`: generation, parsing, or validation did not yield valid arguments.
- `no-such-tool`: repair was skipped because the requested tool is unavailable.

Only actual invalid-call paths emit `tool.repair`; valid tool calls emit no new event.

## Data Flow

For an ordinary invalid call:

```text
model tool call -> AI SDK validation fails -> repair hook -> one generateText call
  -> repaired args validate -> normal execute -> tool result -> next step/onFinish
  -> repair fails -> original invalid-arguments error -> enriched 3: frame
```

For an opted-in invalid call:

```text
model tool call -> custom validator records Zod failure -> execute
  -> onInvalidArguments returns result -> tool result -> next step/onFinish
  -> callback returns null -> one generateText repair -> normal handler on success
  -> repair fails -> enriched 3: frame
```

## Testing

Deterministic AI SDK v4 language-model stubs will exercise the real `streamText` tool loop rather than only testing helper calls.

The suite will verify:

1. An off-enum argument triggers exactly one repair request, repaired arguments reach the handler, a `tool.repair` event reports `repaired`, the SSE stream remains alive, and `onFinish` runs.
2. `onInvalidArguments` receives the original parsed arguments and a `ZodError`; its non-`null` return becomes the streamed tool result and the normal handler is not called.
3. A failed repair emits `failed` and produces an enriched `3:` error frame naming `InvalidToolArgumentsError` and the tool.
4. Valid calls invoke the original handler without repair or new observability events. The `system` and `tools` references supplied to the primary `streamText` call remain unchanged, and repair code does not mutate the cached prefix.
5. `NoSuchToolError` performs no repair model call and returns `null` from the hook.

Existing tool, cache, observability, provider, memory, workflow, and recursive-memory tests remain part of regression verification. Type checking and the production build must also pass.

## Release

- Set the package version to `0.8.0` and update the lockfile's workspace metadata if needed.
- Add a changelog documenting one-shot tool-call repair, `onInvalidArguments`, enriched tool error frames, and `tool.repair` observability events.
- Do not change dependency major versions; the implementation targets the installed AI SDK `4.3.19` surface compatible with `ai@^4.0.0` and Zod 3.

## Out of Scope

- Multiple repair attempts, backoff, or a configurable repair model.
- Repairing unavailable tool names.
- Changing `maxSteps` semantics.
- Persisting partial turns when all repair paths fail.
- Changing MCP tool execution behavior; this design applies to agent turns driven by AI SDK `streamText`.
