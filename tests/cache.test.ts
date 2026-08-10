import { describe, expect, it } from 'bun:test';
import type { CoreMessage } from 'ai';
import { buildPrompt } from '../src/agent.js';

const SYSTEM = 'You are a helpful assistant with a long, stable system prompt.';

const HISTORY: CoreMessage[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: 'second answer' },
];

/** The marker the Anthropic provider looks for (`cacheControl` or `cache_control`). */
const MARK = { anthropic: { cacheControl: { type: 'ephemeral' } } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optionsOf = (m: CoreMessage): unknown => (m as any).providerOptions;

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
  it('moves the system prompt into messages and marks it', () => {
    // The whole point: a top-level `system` STRING cannot carry
    // providerOptions, so caching it is only possible as a message.
    const { messages, system } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: true,
    });
    expect(system).toBeUndefined();
    expect(messages[0]).toMatchObject({ role: 'system', content: SYSTEM });
    expect(optionsOf(messages[0])).toEqual(MARK);
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
    const { messages } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: true,
    });
    expect(messages.filter((m) => optionsOf(m) !== undefined)).toHaveLength(2);
  });

  it('places only the system breakpoint on the first turn of a thread', () => {
    const { messages } = buildPrompt({
      systemPrompt: SYSTEM,
      history: [],
      message: 'first question',
      cache: true,
    });
    expect(messages).toHaveLength(2);
    expect(optionsOf(messages[0])).toEqual(MARK);
    expect(optionsOf(messages[1])).toBeUndefined();
  });

  it('does not mutate the caller’s history array', () => {
    const history: CoreMessage[] = [{ role: 'user', content: 'only' }];
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
    const { messages } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: { history: false },
    });
    expect(messages.filter((m) => optionsOf(m) !== undefined)).toHaveLength(1);
    expect(messages[0].role).toBe('system');
  });

  it('an empty object enables both — a set `cache` opts in by default', () => {
    const { messages } = buildPrompt({
      systemPrompt: SYSTEM,
      history: HISTORY,
      message: 'third question',
      cache: {},
    });
    expect(messages.filter((m) => optionsOf(m) !== undefined)).toHaveLength(2);
  });
});
