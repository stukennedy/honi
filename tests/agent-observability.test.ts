import { describe, expect, it } from 'bun:test';
import { createAgent } from '../src/agent.js';
import type { HoniEvent } from '../src/observability.js';

function fakeStorage(options: { failPut?: boolean } = {}): DurableObjectStorage {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      if (options.failPut) throw new TypeError('private persistence detail');
      values.set(key, value);
    },
    delete: async (key: string) => values.delete(key),
  } as unknown as DurableObjectStorage;
}

function fakeAiBinding(): Ai {
  return {
    run: async () => {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"response":"Hello"}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
    },
  } as unknown as Ai;
}

function failingAiBinding(): Ai {
  return {
    run: async () =>
      new ReadableStream({
        start(controller) {
          controller.error(new RangeError('private provider detail'));
        },
      }),
  } as unknown as Ai;
}

describe('agent phase observability', () => {
  it('exposes the pre-model, first-output, step, and persistence boundaries', async () => {
    const events: HoniEvent[] = [];
    const agent = createAgent({
      name: 'scan-agent',
      model: '@cf/meta/llama-3.1-8b-instruct',
      system: 'Reply briefly.',
      memory: { enabled: true },
      observability: {
        captureEvents: false,
        onEvent: (event) => events.push(event),
      },
    });
    const state = { storage: fakeStorage() } as unknown as DurableObjectState;
    const instance = new agent.DurableObject(state, { AI: fakeAiBinding() });

    const response = await instance.fetch(
      new Request('https://agent/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-thread-id': 'scan_123:voice',
        },
        body: JSON.stringify({ message: 'Hello' }),
      }),
    );
    await response.text();

    expect(
      events.map((event) => ({
        type: event.type,
        phase: event.metadata?.phase,
        outcome: event.metadata?.outcome,
      })),
    ).toEqual([
      { type: 'agent.request', phase: undefined, outcome: undefined },
      { type: 'agent.phase', phase: 'model.resolve', outcome: 'completed' },
      { type: 'memory.load', phase: 'history.load', outcome: 'completed' },
      { type: 'agent.phase', phase: 'prompt.build', outcome: 'completed' },
      {
        type: 'agent.phase',
        phase: 'provider.stream.create',
        outcome: 'completed',
      },
      {
        type: 'agent.stream.first_chunk',
        phase: undefined,
        outcome: 'first_output',
      },
      { type: 'agent.step', phase: undefined, outcome: 'completed' },
      { type: 'agent.response', phase: undefined, outcome: undefined },
      {
        type: 'memory.save',
        phase: 'working_memory.save',
        outcome: 'completed',
      },
      { type: 'agent.turn.complete', phase: undefined, outcome: 'completed' },
    ]);

    for (const event of events.slice(1)) {
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(event)).not.toContain('Hello');
    }
  });

  it('emits a content-free failed terminal event when persistence fails', async () => {
    const events: HoniEvent[] = [];
    const agent = createAgent({
      name: 'scan-agent',
      model: '@cf/meta/llama-3.1-8b-instruct',
      memory: { enabled: true },
      observability: { captureEvents: false, onEvent: (event) => events.push(event) },
    });
    const state = {
      storage: fakeStorage({ failPut: true }),
      waitUntil: () => {},
    } as unknown as DurableObjectState;
    const instance = new agent.DurableObject(state, { AI: fakeAiBinding() });

    const response = await instance.fetch(
      new Request('https://agent/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-thread-id': 'scan_123:voice' },
        body: JSON.stringify({ message: 'Hello' }),
      }),
    );
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);

    expect(events.at(-1)).toMatchObject({
      type: 'agent.turn.complete',
      metadata: { outcome: 'failed', errorType: 'TypeError' },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('private persistence detail');
  });

  it('emits a content-free failed terminal event when the provider stream fails', async () => {
    const events: HoniEvent[] = [];
    const agent = createAgent({
      name: 'scan-agent',
      model: '@cf/meta/llama-3.1-8b-instruct',
      observability: { captureEvents: false, onEvent: (event) => events.push(event) },
    });
    const state = { storage: fakeStorage(), waitUntil: () => {} } as unknown as DurableObjectState;
    const instance = new agent.DurableObject(state, { AI: failingAiBinding() });

    const response = await instance.fetch(
      new Request('https://agent/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-thread-id': 'scan_123:voice' },
        body: JSON.stringify({ message: 'Hello' }),
      }),
    );
    await expect(response.text()).rejects.toBeInstanceOf(RangeError);

    expect(events.at(-1)).toMatchObject({
      type: 'agent.turn.complete',
      metadata: { outcome: 'failed', errorType: 'RangeError' },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('private provider detail');
  });

  it('emits a failed terminal event when history loading fails before stream creation', async () => {
    const events: HoniEvent[] = [];
    const storage = fakeStorage();
    storage.get = async () => {
      throw new SyntaxError('private storage detail');
    };
    const agent = createAgent({
      name: 'scan-agent',
      model: '@cf/meta/llama-3.1-8b-instruct',
      memory: { enabled: true },
      observability: { captureEvents: false, onEvent: (event) => events.push(event) },
    });
    const state = { storage, waitUntil: () => {} } as unknown as DurableObjectState;
    const instance = new agent.DurableObject(state, { AI: fakeAiBinding() });

    await expect(
      instance.fetch(
        new Request('https://agent/', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-thread-id': 'scan_123:voice' },
          body: JSON.stringify({ message: 'Hello' }),
        }),
      ),
    ).rejects.toBeInstanceOf(SyntaxError);

    expect(events.at(-1)).toMatchObject({
      type: 'agent.turn.complete',
      metadata: { outcome: 'failed', errorType: 'SyntaxError' },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('private storage detail');
  });
});
