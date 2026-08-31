import { describe, expect, it } from 'bun:test';
import { ThreadMemory } from '../src/memory.js';
import { resolveModel } from '../src/providers.js';

/**
 * Coverage for the knobs and repairs that shipped as a downstream `dist/`
 * patch before landing here. They were unpinned upstream, so a release could
 * silently drop them — which is exactly what happened. These are the guard.
 */

function createMockStorage(): any {
  const store = new Map<string, any>();
  return {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key),
    put: async (key: string, value: any): Promise<void> => {
      // Mirror the DO storage contract: v8 structured-clone, which THROWS on
      // functions. A Map-backed fake that just keeps the reference would let
      // an unclonable message through and pass a test that production fails.
      structuredClone(value);
      store.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
  };
}

describe('ThreadMemory tolerates unclonable decoration on messages', () => {
  it('persists a message whose tool-call args carry a function-valued property', async () => {
    const memory = new ThreadMemory(createMockStorage());
    // The live shape: a ZodError riding an invalid-tool-args marker, carrying
    // its own issue-pusher closure as an own property.
    const poisoned: any = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'submitRatings',
          args: { addIssue: (sub: unknown) => sub, ratings: [{ skillName: 'AI literacy' }] },
        },
      ],
    };

    await memory.append([poisoned]);

    const loaded = (await memory.load()) as any[];
    expect(loaded).toHaveLength(1);
    // Real content survives; only the unclonable decoration is dropped. The
    // v4 `args` key is upgraded to the v5+ `input` shape on load.
    expect(loaded[0].content[0].input.ratings[0].skillName).toBe('AI literacy');
    expect(loaded[0].content[0].input.addIssue).toBeUndefined();
  });

  it('leaves ordinary messages byte-identical', async () => {
    const memory = new ThreadMemory(createMockStorage());
    const message: any = { role: 'user', content: 'Hello' };
    await memory.append([message]);
    expect(await memory.load()).toEqual([message]);
  });

  it('preserves binary file-part data through the clone-safety round-trip', async () => {
    // Plain JSON.stringify mangles a Uint8Array into a numeric-keyed object,
    // which the AI SDK then rejects as a malformed part on the next turn.
    const memory = new ThreadMemory(createMockStorage());
    const bytes = new Uint8Array([1, 2, 3, 250, 255]);
    await memory.append([
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image/png', data: bytes }],
      } as any,
    ]);

    const loaded = (await memory.load()) as any[];
    expect(loaded[0].content[0].data).toBeInstanceOf(Uint8Array);
    expect([...loaded[0].content[0].data]).toEqual([...bytes]);
  });
});

describe('direct-API providers fail loudly on a missing key', () => {
  it('gemini-* names the variable rather than 401ing per turn', async () => {
    await expect(resolveModel('gemini-3.5-flash-lite', { env: {} })).rejects.toThrow(
      /GOOGLE_AI_API_KEY/,
    );
  });

  it('openrouter/* names the variable rather than 401ing per turn', async () => {
    await expect(
      resolveModel('openrouter/google/gemini-3.5-flash-lite', { env: {} }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it('rejects malformed thinking config at resolve, not on the wire', async () => {
    await expect(
      resolveModel('gemini-3.5-flash-lite', {
        env: { GOOGLE_AI_API_KEY: 'k', GOOGLE_THINKING_CONFIG: 'not json' },
      }),
    ).rejects.toThrow(/GOOGLE_THINKING_CONFIG must be valid JSON/);
  });

  it('rejects malformed openrouter reasoning config at resolve', async () => {
    await expect(
      resolveModel('openrouter/x/y', {
        env: { OPENROUTER_API_KEY: 'k', OPENROUTER_REASONING: '{' },
      }),
    ).rejects.toThrow(/OPENROUTER_REASONING must be valid JSON/);
  });

  it('still resolves openrouter/* when the key is present', async () => {
    const model = await resolveModel('openrouter/anthropic/claude-haiku-4.5', {
      env: { OPENROUTER_API_KEY: 'k' },
    });
    expect(model).toBeDefined();
  });
});

describe('the unsupported-model message advertises openrouter', () => {
  it('lists the prefix so a typo is self-diagnosing', async () => {
    await expect(resolveModel('nonsense-model', { env: {} })).rejects.toThrow(/openrouter\/\*/);
  });
});
