import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createAgent } from '../src/agent.js';
import type { HoniEvent } from '../src/observability.js';
import { tool } from '../src/tool.js';

/**
 * Turn-failure semantics on AI SDK 7, exercised end-to-end through the
 * Workers AI partner-catalog route (OpenAI chat SSE via the binding bridge).
 *
 * v7 turns a tool handler throw into a `tool-error` part and keeps going:
 * without honidev's guards the model call loop continues, the turn persists
 * as a success, telemetry stays green, and the client renders a completed
 * message. These tests pin the restored 0.8.x contract.
 */

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

function sse(lines: string[]): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      controller.close();
    },
  });
}

const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'google/gemini-3.5-flash-lite',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

const TOOL_CALL_TURN = [
  chunk(
    {
      role: 'assistant',
      tool_calls: [
        { index: 0, id: 'call-1', type: 'function', function: { name: 'boom', arguments: '{}' } },
      ],
    },
    null,
  ),
  chunk({}, 'tool_calls'),
  '[DONE]',
];

const TEXT_TURN = [
  chunk({ role: 'assistant', content: 'Hello' }, null),
  chunk({}, 'stop'),
  '[DONE]',
];

/** Partner-catalog binding that serves scripted SSE turns and records inputs. */
function partnerBinding(turns: string[][]) {
  const runInputs: Array<Record<string, unknown>> = [];
  const remaining = [...turns];
  return {
    runInputs,
    binding: {
      run: async (_model: string, inputs: Record<string, unknown>) => {
        runInputs.push(inputs);
        const turn = remaining.shift();
        if (!turn) throw new Error('no scripted turn remains');
        return sse(turn);
      },
    } as unknown as Ai,
  };
}

async function collectBody(response: Response): Promise<{ text: string; error?: unknown }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text };
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
}

function chat(instance: { fetch: (r: Request) => Promise<Response> }, message: string) {
  return instance.fetch(
    new Request('https://agent/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    }),
  );
}

function boomAgent(events: HoniEvent[], handler: () => Promise<unknown>) {
  return createAgent({
    name: 'failure-agent',
    model: 'google/gemini-3.5-flash-lite',
    memory: { enabled: true },
    tools: [
      tool({
        name: 'boom',
        description: 'Always relevant',
        input: z.object({}),
        handler,
      }),
    ],
    observability: { captureEvents: false, onEvent: (event) => events.push(event) },
  });
}

describe('tool execution failure fails the turn (0.8.x parity)', () => {
  it('stops the loop, skips persistence, errors the body with the named tool', async () => {
    const events: HoniEvent[] = [];
    const { binding, runInputs } = partnerBinding([TOOL_CALL_TURN, TEXT_TURN]);
    const agent = boomAgent(events, async () => {
      throw new RangeError('tool backend down');
    });
    const state = { storage: fakeStorage(), waitUntil: () => {} } as unknown as DurableObjectState;
    const instance = new agent.DurableObject(state, { AI: binding });

    const response = await chat(instance, 'Hello');
    const { text, error } = await collectBody(response);

    // The client sees the failure as a formatted error frame naming the tool…
    expect(text).toContain('"type":"error"');
    expect(text).toContain('ToolExecutionError:boom: tool backend down');
    // …and never a finish frame that would finalize the turn as a success.
    expect(text).not.toContain('"type":"finish"');
    // The body itself rejects, for consumers that await the whole response.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('tool backend down');

    // The loop stopped after the failed step: no recovery model call.
    expect(runInputs).toHaveLength(1);

    // Nothing was persisted — replaying a broken turn every subsequent turn
    // would teach the model the failure is normal.
    expect(await instance.memory.load()).toEqual([]);

    // Turn-level telemetry reports the failure.
    expect(events.at(-1)).toMatchObject({
      type: 'agent.turn.complete',
      metadata: { outcome: 'failed', errorType: 'ToolExecutionError' },
    });
  });

  it('strips stream_options before the payload reaches the binding', async () => {
    // @ai-sdk/openai v4 unconditionally adds stream_options to streaming
    // bodies; the partner endpoint 400s on unexpected keys.
    const events: HoniEvent[] = [];
    const { binding, runInputs } = partnerBinding([TEXT_TURN]);
    const agent = boomAgent(events, async () => 'unused');
    const state = { storage: fakeStorage(), waitUntil: () => {} } as unknown as DurableObjectState;
    const instance = new agent.DurableObject(state, { AI: binding });

    await collectBody(await chat(instance, 'Hello'));

    expect(runInputs).toHaveLength(1);
    expect('stream_options' in runInputs[0]).toBe(false);
    expect('model' in runInputs[0]).toBe(false);
    expect(runInputs[0].stream).toBe(true);
  });
});

describe('persistence failure is observed by the client, not just telemetry', () => {
  it('withholds the finish frame and sends an error frame instead', async () => {
    const events: HoniEvent[] = [];
    const { binding } = partnerBinding([TEXT_TURN]);
    const agent = boomAgent(events, async () => 'unused');
    const state = {
      storage: fakeStorage({ failPut: true }),
      waitUntil: () => {},
    } as unknown as DurableObjectState;
    const instance = new agent.DurableObject(state, { AI: binding });

    const { text, error } = await collectBody(await chat(instance, 'Hello'));

    // The turn's text streamed before persistence ran…
    expect(text).toContain('Hello');
    // …but the turn is never finalized as a success: no finish frame, an
    // error frame in its place, and a rejected body.
    expect(text).not.toContain('"type":"finish"');
    expect(text).toContain('"type":"error"');
    expect(error).toBeInstanceOf(TypeError);

    expect(events.at(-1)).toMatchObject({
      type: 'agent.turn.complete',
      metadata: { outcome: 'failed', errorType: 'TypeError' },
    });
  });
});

describe('successful turns keep their wire contract', () => {
  it('sends the finish frame with per-turn usage metadata', async () => {
    const events: HoniEvent[] = [];
    const { binding } = partnerBinding([TEXT_TURN]);
    const agent = boomAgent(events, async () => 'unused');
    const state = { storage: fakeStorage(), waitUntil: () => {} } as unknown as DurableObjectState;
    const instance = new agent.DurableObject(state, { AI: binding });

    const { text, error } = await collectBody(await chat(instance, 'Hello'));

    expect(error).toBeUndefined();
    expect(text).toContain('"type":"finish"');
    // v4's data protocol carried token usage in its finish frame; the UI
    // message stream only sends what messageMetadata supplies — so usage must
    // be present for clients that account spend off the stream.
    expect(text).toContain('"messageMetadata"');
    expect(text).toContain('"usage"');
    expect(events.at(-1)).toMatchObject({
      type: 'agent.turn.complete',
      metadata: { outcome: 'completed' },
    });
  });
});
