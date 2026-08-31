import { describe, expect, it } from 'bun:test';
import type { LanguageModel, ModelMessage, ToolCallRepairFunction, ToolSet } from 'ai';
import { buildAgentStreamOptions, buildPrompt } from '../src/agent.js';

const SYSTEM = 'You are a helpful assistant with a long, stable system prompt.';

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: 'second answer' },
];

/** The marker the Anthropic provider looks for (`cacheControl` or `cache_control`). */
const MARK = { anthropic: { cacheControl: { type: 'ephemeral' } } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optionsOf = (m: unknown): unknown => (m as any)?.providerOptions;

describe('buildPrompt — caching off (default)', () => {
  it('keeps the system prompt on the top-level param, exactly as before', () => {
    const { messages, system } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: undefined,
    });
    expect(system).toBe(SYSTEM);
    expect(messages).toHaveLength(HISTORY.length + 1);
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('marks nothing', () => {
    const { messages } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: false,
    });
    expect(messages.every((m) => optionsOf(m) === undefined)).toBe(true);
  });

  it('omits system entirely when there is no system prompt', () => {
    const { system } = buildPrompt({
      systemPrompt: '',
      history: [],
      message: 'hello',
      cache: undefined,
    });
    expect(system).toBeUndefined();
  });
});

describe('buildPrompt — cache: true', () => {
  it('upgrades the system prompt to a system message carrying the cache mark', () => {
    // The whole point: a bare `system` STRING cannot carry providerOptions, so
    // caching it requires the full SystemModelMessage shape (which feeds the
    // model call's `instructions` option — the AI SDK rejects system messages
    // inside `messages` by default).
    const { messages, system } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: true,
    });
    expect(system).toMatchObject({ role: 'system', content: SYSTEM });
    expect(optionsOf(system)).toEqual(MARK);
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
    expect(messages).toHaveLength(HISTORY.length + 1);
  });

  it('marks the END of history, not the new user message', () => {
    // Marking the new message would write a cache entry nothing ever reads.
    // Marking the end of history makes each turn read what the last one wrote.
    const { messages } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: true,
    });
    const last = messages[messages.length - 1];
    const prefixEnd = messages[messages.length - 2];

    expect(last).toMatchObject({ role: 'user', content: 'third question' });
    expect(optionsOf(last)).toBeUndefined();
    expect(prefixEnd).toMatchObject({ role: 'assistant', content: 'second answer' });
    expect(optionsOf(prefixEnd)).toEqual(MARK);
  });

  it('uses exactly two breakpoints, leaving room under Anthropic’s limit of 4', () => {
    const { messages, system } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: true,
    });
    expect(messages.filter((m) => optionsOf(m) !== undefined)).toHaveLength(1);
    expect(optionsOf(system)).toEqual(MARK);
  });

  it('places only the system breakpoint on the first turn of a thread', () => {
    const { messages, system } = buildPrompt({
      systemPrompt: SYSTEM,
      history: [],
      message: 'first question',
      cache: true,
    });
    expect(messages).toHaveLength(1);
    expect(optionsOf(system)).toEqual(MARK);
    expect(optionsOf(messages[0])).toBeUndefined();
  });

  it('does not mutate the caller’s history array', () => {
    const history: ModelMessage[] = [{ role: 'user', content: 'only' }];
    buildPrompt({ systemPrompt: SYSTEM, history, message: 'next', cache: true });
    expect(optionsOf(history[0])).toBeUndefined();
  });
});

describe('buildPrompt — per-breakpoint opt-out', () => {
  it('cache.system false keeps the top-level system param', () => {
    const { messages, system } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: { system: false },
    });
    expect(system).toBe(SYSTEM);
    // history caching still defaults on
    expect(optionsOf(messages[messages.length - 2])).toEqual(MARK);
  });

  it('cache.history false marks the system prompt only', () => {
    const { messages, system } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: { history: false },
    });
    expect(messages.filter((m) => optionsOf(m) !== undefined)).toHaveLength(0);
    expect(optionsOf(system)).toEqual(MARK);
  });

  it('an empty object enables both — a set `cache` opts in by default', () => {
    const { messages, system } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: {},
    });
    expect(messages.filter((m) => optionsOf(m) !== undefined)).toHaveLength(1);
    expect(optionsOf(system)).toEqual(MARK);
  });
});

describe('buildAgentStreamOptions — cache-stable references', () => {
  it('passes system, messages, and tools through without rebuilding them', () => {
    const system = SYSTEM;
    const messages: ModelMessage[] = [{ role: 'user', content: 'submit ratings' }];
    const tools: ToolSet = {};
    const repairToolCall = (async () => null) as ToolCallRepairFunction<ToolSet>;
    const model = {} as LanguageModel;

    const options = buildAgentStreamOptions({
      model,
      system,
      messages,
      tools,
      repairToolCall,
      maxSteps: 3,
    });

    expect(options.instructions).toBe(system);
    expect(options.messages).toBe(messages);
    expect(options.tools).toBe(tools);
    expect(options.repairToolCall).toBe(repairToolCall);
  });

  it('passes common and provider-specific AI SDK model settings through unchanged', () => {
    const providerOptions = {
      anthropic: { thinking: { type: 'disabled' as const } },
      google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
      openai: { reasoningEffort: 'low' },
    };
    const modelSettings = {
      maxOutputTokens: 512,
      temperature: 0,
      topP: 0.9,
      topK: 20,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stopSequences: ['<END>'],
      seed: 42,
      maxRetries: 1,
      providerOptions,
    };

    const options = buildAgentStreamOptions({
      model: {} as never,
      system: undefined,
      messages: [],
      tools: undefined,
      repairToolCall: undefined,
      maxSteps: 3,
      modelSettings,
    });

    expect(options).toMatchObject(modelSettings);
    expect(options.providerOptions).toBe(providerOptions);
  });
});
