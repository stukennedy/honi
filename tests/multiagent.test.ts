import { describe, expect, it } from 'bun:test';
import { parseUiMessageStreamText, routeToAgent } from '../src/multiagent.js';

/**
 * `/chat` streams the AI SDK UI message stream (SSE) since 0.9.0.
 * routeToAgent parsed the v4 data protocol's `0:` frames before — against
 * the new format that reduced every routed response to an empty string.
 */

const sse = (chunks: Array<Record<string, unknown> | '[DONE]'>) =>
  chunks
    .map((chunk) => `data: ${chunk === '[DONE]' ? '[DONE]' : JSON.stringify(chunk)}\n`)
    .join('\n');

describe('parseUiMessageStreamText', () => {
  it('accumulates text-delta chunks and ignores bookkeeping frames', () => {
    const body = sse([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Hello ' },
      { type: 'text-delta', id: 't', delta: 'world' },
      { type: 'text-end', id: 't' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
      '[DONE]',
    ]);
    expect(parseUiMessageStreamText(body)).toBe('Hello world');
  });

  it('throws on an error frame instead of returning partial text as the answer', () => {
    const body = sse([
      { type: 'text-delta', id: 't', delta: 'partial' },
      { type: 'error', errorText: 'ToolExecutionError:boom: backend down' },
    ]);
    expect(() => parseUiMessageStreamText(body)).toThrow(
      'ToolExecutionError:boom: backend down',
    );
  });

  it('returns an empty string for a contentless stream', () => {
    expect(parseUiMessageStreamText(sse([{ type: 'start' }, '[DONE]']))).toBe('');
  });
});

describe('routeToAgent', () => {
  it('returns the routed agent’s text from the UI message stream', async () => {
    const body = sse([
      { type: 'start' },
      { type: 'text-delta', id: 't', delta: 'Routed answer' },
      { type: 'finish', finishReason: 'stop' },
      '[DONE]',
    ]);
    const env = {
      AGENT: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({
          fetch: async () =>
            new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        }),
      } as unknown as DurableObjectNamespace,
    };

    const result = await routeToAgent(env, { binding: 'AGENT' }, 'question');
    expect(result.response).toBe('Routed answer');
    expect(result.messages).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'Routed answer' },
    ]);
  });
});
