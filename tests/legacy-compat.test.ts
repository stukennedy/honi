import { describe, expect, it } from 'bun:test';
import { modelMessageSchema, type ModelMessage } from 'ai';
import { z } from 'zod';
import { buildAgentStreamOptions, assistantMessageText, stopOnToolError } from '../src/agent.js';
import { ThreadMemory, upgradeLegacyMessage } from '../src/memory.js';
import { formatToolError, ToolExecutionError } from '../src/tool-runtime.js';
import { normalizeModelSettings } from '../src/types.js';

/**
 * Compatibility surface for consumers upgrading from honidev 0.8.x (AI SDK 4).
 * AI SDK 7 VALIDATES message shapes and renamed several settings, so without
 * these seams an existing deployment bricks its stored threads and silently
 * loses its output caps on upgrade.
 */

function mockStorage(initial?: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      structuredClone(value);
      store.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
  } as unknown as DurableObjectStorage;
}

/** A thread exactly as honidev 0.8.x (AI SDK 4) persisted it. */
const V4_THREAD = [
  { role: 'user', content: 'look up 42' },
  {
    role: 'assistant',
    content: [
      { type: 'redacted-reasoning', data: 'opaque-blob' },
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'call-1',
        toolName: 'lookup',
        args: { q: '42' },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'lookup',
        result: { answer: 42 },
      },
      {
        type: 'tool-result',
        toolCallId: 'call-2',
        toolName: 'lookup',
        result: 'D1 exploded',
        isError: true,
      },
    ],
  },
  { role: 'assistant', content: 'It means everything.' },
] as unknown as ModelMessage[];

describe('upgradeLegacyMessage — 0.8.x stored threads', () => {
  it('produces messages that pass AI SDK 7 validation', () => {
    // The actual failure mode: streamText validates messages against
    // modelMessageSchema and throws InvalidPromptError on v4 shapes, bricking
    // the thread on every subsequent turn.
    for (const message of V4_THREAD.map(upgradeLegacyMessage)) {
      const parsed = modelMessageSchema.safeParse(message);
      expect(parsed.success).toBe(true);
    }
  });

  it('renames tool-call args to input', () => {
    const upgraded = upgradeLegacyMessage(V4_THREAD[1]) as { content: Array<Record<string, unknown>> };
    const call = upgraded.content.find((part) => part.type === 'tool-call')!;
    expect(call.input).toEqual({ q: '42' });
    expect('args' in call).toBe(false);
    expect('toolCallType' in call).toBe(false);
  });

  it('wraps tool results in the output envelope, honouring isError', () => {
    const upgraded = upgradeLegacyMessage(V4_THREAD[2]) as { content: Array<Record<string, unknown>> };
    expect(upgraded.content[0].output).toEqual({ type: 'json', value: { answer: 42 } });
    expect(upgraded.content[1].output).toEqual({ type: 'error-json', value: 'D1 exploded' });
  });

  it('drops redacted-reasoning parts, which have no v7 equivalent', () => {
    const upgraded = upgradeLegacyMessage(V4_THREAD[1]) as { content: Array<Record<string, unknown>> };
    expect(upgraded.content.some((part) => part.type === 'redacted-reasoning')).toBe(false);
  });

  it('passes already-v7 messages through untouched (idempotent)', () => {
    const v7: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: { q: 'x' } },
      ],
    };
    expect(upgradeLegacyMessage(v7)).toEqual(v7);
    expect(upgradeLegacyMessage(upgradeLegacyMessage(V4_THREAD[2]))).toEqual(
      upgradeLegacyMessage(V4_THREAD[2]),
    );
  });

  it('is applied by ThreadMemory.load', async () => {
    const memory = new ThreadMemory(mockStorage({ messages: V4_THREAD }));
    const loaded = await memory.load();
    for (const message of loaded) {
      expect(modelMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

describe('normalizeModelSettings — pre-0.9 setting names', () => {
  it('maps legacy maxTokens onto maxOutputTokens', () => {
    expect(normalizeModelSettings({ maxTokens: 512 })).toEqual({ maxOutputTokens: 512 });
  });

  it('lets an explicit maxOutputTokens win over legacy maxTokens', () => {
    expect(normalizeModelSettings({ maxTokens: 512, maxOutputTokens: 256 })).toEqual({
      maxOutputTokens: 256,
    });
  });

  it('strips the removed toolCallStreaming flag', () => {
    expect(normalizeModelSettings({ toolCallStreaming: true, temperature: 0 })).toEqual({
      temperature: 0,
    });
  });

  it('passes undefined through', () => {
    expect(normalizeModelSettings(undefined)).toBeUndefined();
  });
});

describe('formatToolError — tool execution failures stay named', () => {
  it('names the failing tool and preserves the original message', () => {
    const wrapped = new ToolExecutionError({
      toolName: 'submitRatings',
      cause: new Error('D1_ERROR: no such table: ratings'),
    });
    expect(formatToolError(wrapped)).toBe(
      'ToolExecutionError:submitRatings: D1_ERROR: no such table: ratings',
    );
  });

  it('finds a wrapped execution error through a cause chain', () => {
    const wrapped = new ToolExecutionError({ toolName: 'lookup', cause: 'raw string reason' });
    const outer = new Error('outer', { cause: wrapped });
    expect(formatToolError(outer)).toBe('ToolExecutionError:lookup: raw string reason');
  });

  it('still falls back to the anonymous message for unknown errors', () => {
    expect(formatToolError(new Error('anything'))).toBe('An error occurred.');
  });
});

describe('buildAgentStreamOptions — persisted-history hardening', () => {
  const base = {
    model: {} as never,
    system: undefined,
    messages: [] as ModelMessage[],
    tools: undefined,
    repairToolCall: undefined,
    maxSteps: 3,
  };

  it('allows system messages in persisted history', () => {
    // One system row seeded through EpisodicMemory.append must not brick the
    // thread — v7 rejects system messages inside `messages` by default.
    expect(buildAgentStreamOptions(base).allowSystemInMessages).toBe(true);
  });

  it('stops the tool loop after a failed tool step', () => {
    const stopWhen = buildAgentStreamOptions(base).stopWhen;
    expect(Array.isArray(stopWhen)).toBe(true);
    expect(stopWhen).toContain(stopOnToolError);
  });

  it('maps legacy maxTokens from modelSettings', () => {
    const options = buildAgentStreamOptions({ ...base, modelSettings: { maxTokens: 128 } });
    expect((options as { maxOutputTokens?: number }).maxOutputTokens).toBe(128);
    expect('maxTokens' in options).toBe(false);
  });
});

describe('stopOnToolError', () => {
  it('stops when the last step contains a tool-error part', () => {
    expect(
      stopOnToolError({ steps: [{ content: [{ type: 'tool-call' }, { type: 'tool-error' }] }] }),
    ).toBe(true);
  });

  it('keeps going otherwise', () => {
    expect(stopOnToolError({ steps: [{ content: [{ type: 'tool-result' }] }] })).toBe(false);
    expect(stopOnToolError({ steps: [] })).toBe(false);
  });
});

describe('assistantMessageText', () => {
  it('joins the text parts of a v7 assistant message', () => {
    expect(
      assistantMessageText({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} },
          { type: 'text', text: 'world' },
        ],
      }),
    ).toBe('Hello world');
  });

  it('passes string content through and ignores non-assistant roles', () => {
    expect(assistantMessageText({ role: 'assistant', content: 'plain' })).toBe('plain');
    expect(assistantMessageText({ role: 'user', content: 'nope' })).toBe('');
  });
});

// Type-level guard: ToolDefinition input schemas still infer through zod.
const _schema: z.ZodType = z.object({});
void _schema;
