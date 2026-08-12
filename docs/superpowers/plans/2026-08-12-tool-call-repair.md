# Resilient Tool Argument Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep agent streams alive when a model emits invalid tool arguments by repairing once or returning a per-tool corrective result, while making terminal tool errors and repair frequency observable.

**Architecture:** Add a focused `tool-runtime` module between honidev tool definitions and AI SDK v4 tools. It preserves each original JSON Schema, owns the native repair hook and optional in-execute invalid-argument handling, and supplies a tool-aware SSE error formatter; `agent.ts` remains responsible for prompt/memory orchestration and only wires this runtime into `streamText`.

**Tech Stack:** TypeScript 5.9, Bun test, AI SDK 4.3.19, Zod 3.25, zod-to-json-schema 3.25, Hono/Cloudflare Durable Objects.

## Global Constraints

- Version must be `0.8.0` with no breaking API changes.
- Keep `ai@^4.0.0` and Zod 3; do not introduce a dependency major upgrade.
- Default repair makes at most one `generateText` call using the same resolved model.
- `NoSuchToolError` is not model-repaired.
- Existing tools remain source-compatible; `onInvalidArguments` is optional.
- Valid calls must not trigger repair and must retain the original system/tools references and cached prompt prefix.
- Failed repair must degrade to a terminal `3:` frame containing at least the public error name and tool name.

---

### Task 1: Add the public invalid-argument and observability contracts

**Files:**
- Modify: `src/types.ts:17-23`
- Modify: `src/tool.ts:4-11`
- Modify: `src/observability.ts:10-20`
- Test: `tests/tool.test.ts`
- Test: `tests/observability.test.ts`

**Interfaces:**
- Produces: `ToolDefinition<T>['onInvalidArguments']?: (rawArgs: unknown, zodError: z.ZodError) => unknown | Promise<unknown>`.
- Produces: `tool()` accepts and preserves the same optional callback.
- Produces: `HoniEventType` includes `'tool.repair'`.

- [ ] **Step 1: Write failing public-contract tests**

Add a `tool()` test that constructs a tool with `onInvalidArguments`, calls the preserved callback with an off-enum object and a literal `new z.ZodError([...])`, and expects its result. Add an observability test that emits a literal `tool.repair` event with `{ tool: 'submitRatings', attempt: 1, outcome: 'handled' }` and expects it to be collected.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test tests/tool.test.ts tests/observability.test.ts`

Expected: TypeScript/test loading fails because `onInvalidArguments` and `'tool.repair'` are not accepted by current types.

- [ ] **Step 3: Add the minimal additive types**

Use an imported Zod namespace type so the callback exposes the real Zod error:

```ts
export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: T;
  handler: (input: z.infer<T>, ctx?: ToolContext) => Promise<unknown>;
  onInvalidArguments?: (
    rawArgs: unknown,
    zodError: z.ZodError,
  ) => unknown | Promise<unknown>;
}
```

Mirror that member in the `tool()` config type and append `'tool.repair'` to `HoniEventType`. Do not change runtime behavior yet; `tool()` continues returning its config unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `bun test tests/tool.test.ts tests/observability.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit the public contract**

```bash
git add src/types.ts src/tool.ts src/observability.ts tests/tool.test.ts tests/observability.test.ts
git commit -m "feat: add invalid tool argument hook contract"
```

---

### Task 2: Build and test the tool runtime's valid and local-handler paths

**Files:**
- Create: `src/tool-runtime.ts`
- Create: `tests/tool-runtime.test.ts`
- Modify: `src/agent.ts:1-138`

**Interfaces:**
- Consumes: `ToolDefinition`, `ToolContext`, AI SDK `LanguageModel`, and `ObservabilityCollector`.
- Produces:

```ts
export interface ToolRuntime {
  tools: Record<string, Tool<any, unknown>>;
  repairToolCall: ToolCallRepairFunction<any>;
}

export function buildToolRuntime(input: {
  definitions: ToolDefinition[];
  context: ToolContext;
  model: LanguageModel;
  collector?: ObservabilityCollector;
  agentName: string;
  threadId?: string;
}): ToolRuntime;
```

- Produces an internal invalid-input marker that cannot collide with user data (use a module-private `unique symbol`).
- Preserves existing `tool.call` / `tool.result` timing and error behavior for normal handler execution.

- [ ] **Step 1: Write failing runtime tests for valid calls and local handling**

In `tests/tool-runtime.test.ts`, create a literal enum tool definition and build the runtime with a deterministic no-network model stub. Assert these consumer-visible behaviors:

1. The AI SDK tool `parameters` exposes the same JSON Schema enum whether or not `onInvalidArguments` is present.
2. Calling the wrapped `execute` with valid parsed input invokes the real handler and emits only `tool.call` then `tool.result`.
3. Passing off-enum input through the opted-in schema validator and then `execute` calls `onInvalidArguments` with the literal raw object and a real `ZodError`, returns the callback's literal nudge result, never calls the normal handler, and emits one `tool.repair` event with outcome `handled`.

Use the schema's validation boundary rather than constructing the private marker in the test. The production change each test catches is respectively schema drift, valid-call interception, and failure to turn the hook result into a normal tool result.

- [ ] **Step 2: Run the runtime tests and verify RED**

Run: `bun test tests/tool-runtime.test.ts`

Expected: FAIL because `src/tool-runtime.ts` and `buildToolRuntime` do not exist.

- [ ] **Step 3: Implement schema-preserving local validation**

Create `src/tool-runtime.ts` using AI SDK's `tool`, `jsonSchema`, `InvalidToolArgumentsError`, and tool types plus `zodToJsonSchema`.

For definitions without `onInvalidArguments`, pass `definition.input` directly as `parameters`.

For opted-in definitions, create a custom `jsonSchema` with the original Zod-derived schema and a validator:

```ts
const result = definition.input.safeParse(value);
return result.success
  ? { success: true, value: result.data }
  : { success: true, value: { [invalidArguments]: true, rawArgs: value, error: result.error } };
```

The wrapper's `execute` detects this marker, awaits `onInvalidArguments`, and returns non-`null` results directly. Emit `tool.repair` with `{ tool, attempt: 1, outcome: 'handled' }`. For valid data, route through a shared `executeHandler` helper containing the existing `tool.call` / `tool.result` collector behavior copied from `agent.ts`.

For now, if the callback returns `null`, throw an `InvalidToolArgumentsError` using `JSON.stringify(rawArgs)` and the retained `ZodError`; Task 3 replaces this branch with repair.

- [ ] **Step 4: Remove the old builder from `agent.ts` without wiring the new runtime yet**

Delete `buildTools` from `agent.ts` and import `buildToolRuntime`. Update only enough code to compile temporarily in Task 2: construct `runtime` after resolving `model`, use `runtime.tools`, and leave the repair hook wiring for Task 3.

- [ ] **Step 5: Run focused tests, typecheck, and verify GREEN**

Run: `bun test tests/tool-runtime.test.ts tests/tool.test.ts tests/observability.test.ts && bun run typecheck`

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 6: Commit the runtime foundation**

```bash
git add src/tool-runtime.ts src/agent.ts tests/tool-runtime.test.ts
git commit -m "refactor: isolate AI SDK tool runtime"
```

---

### Task 3: Add one-shot model repair and diagnosable terminal errors

**Files:**
- Modify: `src/tool-runtime.ts`
- Modify: `src/agent.ts:320-390`
- Modify: `tests/tool-runtime.test.ts`

**Interfaces:**
- Produces: `ToolRuntime.repairToolCall`, matching AI SDK 4.3.19's exact callback arguments `{ toolCall, tools, error, messages, system, parameterSchema }`.
- Produces: `formatToolError(error: unknown): string`, returning `'An error occurred.'` for non-tool failures and `<ErrorName>:<toolName>: <message>` for tool failures.
- Uses `generateText({ model, system, messages })` exactly once per invalid call; the repair request has no tools and does not mutate the primary stream inputs.

- [ ] **Step 1: Add a deterministic AI SDK model fixture**

In `tests/tool-runtime.test.ts`, define a complete `LanguageModelV1`-shaped test double:

- `doStream` dequeues scripted streams containing `tool-call`, `text-delta`, and `finish` parts.
- `doGenerate` dequeues scripted repair text results.
- Every result contains literal usage, finish reason, raw call, response metadata, warnings, and provider metadata fields matching AI SDK v4.
- Record the exact prompt passed into each method so tests can inspect object identity and repair instructions without asserting on the mock merely existing.

- [ ] **Step 2: Write the failing off-enum repair integration test**

Run real AI SDK `streamText` with the runtime tools and repair hook. Script the first stream step to call `submitRatings` with `{"seniorityBand":"Senior Manager"}`, `doGenerate` to return `{"seniorityBand":"Manager"}`, and the final stream step to return farewell text.

Assert:

- the real handler receives exactly `{ seniorityBand: 'Manager' }`;
- the resulting full/data stream completes and contains the final farewell;
- `onFinish` runs once with a completed response;
- one `tool.repair` event has `{ tool: 'submitRatings', attempt: 1, outcome: 'repaired' }`;
- the repair instruction includes the failing tool, literal enum issue, and `Return corrected arguments only`;
- no second repair generation occurs.

Run: `bun test tests/tool-runtime.test.ts -t "repairs an off-enum call"`

Expected: FAIL because the runtime currently rethrows invalid arguments and is not wired to `generateText`.

- [ ] **Step 3: Implement the shared one-shot repair function**

Add a private helper that:

1. Returns `null` for `NoSuchToolError` after emitting outcome `no-such-tool`.
2. Looks up the original `ToolDefinition`; returns `null` if absent.
3. Derives issues by JSON-parsing `error.toolArgs`, calling `definition.input.safeParse`, and serializing `ZodError.issues` as compact JSON. If parsing itself failed, serialize the SDK error/cause message.
4. Calls `generateText` once with the same model and a repair-only prompt containing the failed call, `parameterSchema({ toolName })`, and corrective instruction.
5. Trims optional Markdown JSON fences, parses the returned text, validates with the original Zod schema, and returns `{ ...toolCall, args: JSON.stringify(parsed.data) }` only on success.
6. Catches every generation/parsing/validation failure, emits outcome `failed`, and returns `null`.

Emit outcome `repaired` only after original-schema validation succeeds.

- [ ] **Step 4: Wire repair into both invalid paths**

Set `ToolRuntime.repairToolCall` to the shared helper with the exact AI SDK v4 signature.

For opted-in tools whose callback returns `null`, synthesize the original raw tool call using `ToolExecutionOptions.toolCallId` and messages, invoke the same helper once, parse its returned args with the original Zod schema, and pass valid values to `executeHandler`. If it returns `null`, throw the original `InvalidToolArgumentsError`.

In `agent.ts`, pass:

```ts
experimental_repairToolCall: runtime?.repairToolCall,
```

Do not clone or edit `system`, `messages`, or `runtime.tools` while adding the property.

- [ ] **Step 5: Run the repair integration test and verify GREEN**

Run: `bun test tests/tool-runtime.test.ts -t "repairs an off-enum call"`

Expected: PASS; handler and `onFinish` both execute.

- [ ] **Step 6: Write and verify the failing local-null fallback test**

Add a test where `onInvalidArguments` observes the raw object, returns `null`, one repair result fixes it, and the normal handler receives the repaired value. Assert exactly one repair model call and outcome `repaired` (not `handled`).

Run: `bun test tests/tool-runtime.test.ts -t "repairs after the invalid-argument hook declines"`

Expected before any necessary adjustment: FAIL on the first missing branch behavior; after the minimal adjustment: PASS.

- [ ] **Step 7: Write the failing repair-failure/error-frame test**

Script the model repair to return the same off-enum value. Convert the real `streamText` result with:

```ts
result.toDataStreamResponse({ getErrorMessage: formatToolError })
```

Read the response body and assert it contains a literal frame beginning with:

```text
3:"InvalidToolArgumentsError:submitRatings:
```

Also assert the handler and `onFinish` do not run and the collector emits outcome `failed`.

Run: `bun test tests/tool-runtime.test.ts -t "enriches the fatal error frame"`

Expected: FAIL because terminal errors still use AI SDK's generic formatter.

- [ ] **Step 8: Implement tool-error unwrapping and wire the response**

Implement `formatToolError` with a cycle-safe cause walk. Recognize `InvalidToolArgumentsError`, `NoSuchToolError`, and `ToolExecutionError` via their static `isInstance` methods; also follow `ToolCallRepairError.originalError`. Strip only a leading `AI_` from names. Prefer the most specific nested invalid/no-such error over the outer execution wrapper.

For non-tool errors, return exactly `'An error occurred.'` to retain current disclosure behavior.

In `agent.ts`, change only the response conversion:

```ts
return result.toDataStreamResponse({ getErrorMessage: formatToolError });
```

- [ ] **Step 9: Run failure and no-such-tool tests**

Run: `bun test tests/tool-runtime.test.ts`

Expected: all runtime tests pass, including a direct repair-hook test proving `NoSuchToolError` makes zero `doGenerate` calls and returns `null`.

- [ ] **Step 10: Commit repair and error semantics**

```bash
git add src/tool-runtime.ts src/agent.ts tests/tool-runtime.test.ts
git commit -m "feat: repair invalid tool arguments once"
```

---

### Task 4: Lock down valid-call cache stability and publish 0.8.0 metadata

**Files:**
- Modify: `tests/tool-runtime.test.ts`
- Modify: `tests/cache.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `CHANGELOG.md`

**Interfaces:**
- Confirms the primary `streamText` call receives the same `system`, `messages`, and `tools` references created before generation.
- Releases the additive behavior as honidev `0.8.0`.

- [ ] **Step 1: Write a valid-call regression test**

Script a valid `submitRatings` tool call followed by final text. Capture literal `system`, `messages`, and `runtime.tools` references before calling `streamText`; assert the test model's first `doStream` call observes content derived from those same inputs without mutation, the handler receives the valid value, `onFinish` runs, `doGenerate` is never called, and no `tool.repair` event exists.

Because AI SDK converts prompts internally, test reference stability at honidev's stream-options boundary: factor a small `buildStreamOptions` helper from `agent.ts` only if needed, and assert its returned `system`, `messages`, and `tools` properties use `toBe` against the caller values. Do not assert AI SDK's private provider prompt retains application-level references.

- [ ] **Step 2: Run the valid-call/cache tests and verify RED where applicable**

Run: `bun test tests/tool-runtime.test.ts tests/cache.test.ts`

Expected: the new boundary assertion fails only if current wiring clones/rebuilds cache-relevant fields; otherwise document the immediate pass as a characterization and perform the mutation check by temporarily cloning one field, observing failure, then restoring it.

- [ ] **Step 3: Make the smallest cache-stability adjustment**

If the test exposed cloning, pass through the original references. If it already passed, make no production change. Keep `buildPrompt` behavior and its existing Anthropic cache-marker tests unchanged.

- [ ] **Step 4: Bump release metadata and write changelog**

Set `package.json` and the root `bun.lock` workspace version metadata to `0.8.0` as applicable. Create `CHANGELOG.md` with a `0.8.0 — 2026-08-12` section covering:

- one-shot default repair through AI SDK v4;
- optional `onInvalidArguments` corrective tool results;
- enriched tool-related SSE error frames;
- `tool.repair` observability events;
- no behavior change for valid calls.

- [ ] **Step 5: Run the complete verification suite**

Run each command fresh and inspect full output:

```bash
bun test
bun run typecheck
bun run build
git diff --check
```

Expected: all tests pass with zero failures; typecheck and build exit 0; diff check is empty.

- [ ] **Step 6: Inspect generated declarations and release diff**

Run:

```bash
rg -n "onInvalidArguments|tool.repair" dist
git diff --stat e98b790
git status --short
```

Expected: declarations expose the additive callback/event type; release diff contains only scoped source, tests, docs, build output if tracked, and version metadata. `.codebase-memory/` remains untracked and excluded from commits.

- [ ] **Step 7: Commit the release**

```bash
git add package.json bun.lock CHANGELOG.md tests/tool-runtime.test.ts tests/cache.test.ts dist
git commit -m "release: honidev 0.8.0"
```

If `dist` is ignored or intentionally not tracked, omit it rather than force-adding generated files.

---

## Final Requirement Audit

- [ ] Off-enum ordinary call repairs once, handler executes, stream completes, and `onFinish` fires.
- [ ] `onInvalidArguments` receives raw parsed arguments plus `ZodError`; non-null return is a tool result.
- [ ] Hook `null` uses default repair and never performs more than one repair generation.
- [ ] Repair failure preserves fatal behavior with `InvalidToolArgumentsError:<tool>:` in the `3:` frame.
- [ ] `NoSuchToolError` returns `null` without model repair.
- [ ] `tool.repair` records tool, attempt 1, and outcome.
- [ ] Valid calls have no repair behavior and preserve cache-relevant input references.
- [ ] Version and changelog report 0.8.0 with no breaking API change.
