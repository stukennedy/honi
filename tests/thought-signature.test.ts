import { afterEach, describe, expect, it } from 'bun:test';
import { generateText, type ModelMessage } from 'ai';
import { resolveModel } from '../src/providers.js';

/**
 * Thought-signature handling for native gemini-* models.
 *
 * Gemini 3 rejects (400 INVALID_ARGUMENT) any history functionCall part
 * without a thoughtSignature. honidev < 0.9 papered over this with its own
 * fetch-level sentinel; on AI SDK v5+ the Google provider owns the whole
 * story — it replays `providerOptions.google.thoughtSignature` from stored
 * assistant messages and injects Google's documented
 * `skip_thought_signature_validator` sentinel for history that carries no
 * signature (threads saved by older honidev versions). These tests pin that
 * behaviour so a provider upgrade cannot silently drop it again.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(): { requests: Array<{ url: string; body: Record<string, unknown> }> } {
  const captured = { requests: [] as Array<{ url: string; body: Record<string, unknown> }> };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return Response.json({
      candidates: [
        {
          content: { parts: [{ text: 'ok' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
  }) as typeof fetch;
  return captured;
}

function functionCallParts(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const contents = body.contents as Array<{ parts?: Array<Record<string, unknown>> }>;
  return contents.flatMap((c) => (c.parts ?? []).filter((p) => p.functionCall));
}

const HISTORY_WITH_SIGNATURE: ModelMessage[] = [
  { role: 'user', content: 'look up 42' },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup',
        input: { q: '42' },
        providerOptions: { google: { thoughtSignature: 'sig-from-previous-turn' } },
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
        output: { type: 'json', value: { answer: 42 } },
      },
    ],
  },
  { role: 'user', content: 'and what does that mean?' },
];

describe('native gemini thought signatures', () => {
  it('replays a stored thoughtSignature on the history functionCall part', async () => {
    const captured = captureFetch();
    const model = await resolveModel('gemini-3.5-flash-lite', {
      env: { GOOGLE_AI_API_KEY: 'test-key' },
    });

    await generateText({ model, messages: HISTORY_WITH_SIGNATURE });

    expect(captured.requests).toHaveLength(1);
    const calls = functionCallParts(captured.requests[0].body);
    expect(calls).toHaveLength(1);
    expect(calls[0].thoughtSignature).toBe('sig-from-previous-turn');
  });

  it('falls back to the documented skip sentinel for signature-less history', async () => {
    // Threads persisted by honidev < 0.9 carry no signatures at all; the
    // provider has to keep those requests alive rather than 400 every
    // post-tool-call turn.
    const captured = captureFetch();
    const model = await resolveModel('gemini-3.5-flash-lite', {
      env: { GOOGLE_AI_API_KEY: 'test-key' },
    });

    const withoutSignature = structuredClone(HISTORY_WITH_SIGNATURE) as ModelMessage[];
    delete (withoutSignature[1] as { content: Array<{ providerOptions?: unknown }> }).content[0]
      .providerOptions;

    await generateText({ model, messages: withoutSignature });

    const calls = functionCallParts(captured.requests[0].body);
    expect(calls).toHaveLength(1);
    expect(calls[0].thoughtSignature).toBe('skip_thought_signature_validator');
  });

  it('surfaces a response thoughtSignature so the next turn can replay it', async () => {
    globalThis.fetch = (async () =>
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'lookup', args: { q: '42' } },
                  thoughtSignature: 'sig-from-this-turn',
                },
              ],
              role: 'model',
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      })) as typeof fetch;

    const model = await resolveModel('gemini-3.5-flash-lite', {
      env: { GOOGLE_AI_API_KEY: 'test-key' },
    });

    const result = await generateText({ model, messages: [{ role: 'user', content: 'look up 42' }] });
    const toolCall = result.content.find((part) => part.type === 'tool-call');
    expect(toolCall?.providerMetadata?.google?.thoughtSignature).toBe('sig-from-this-turn');

    // And the signature must survive into the messages an agent persists —
    // this is exactly what ThreadMemory stores and replays next turn.
    const persisted = JSON.parse(JSON.stringify(result.response.messages)) as Array<{
      content: Array<{ type: string; providerOptions?: { google?: { thoughtSignature?: string } } }>;
    }>;
    const persistedCall = persisted
      .flatMap((message) => message.content)
      .find((part) => part.type === 'tool-call');
    expect(persistedCall?.providerOptions?.google?.thoughtSignature).toBe('sig-from-this-turn');
  });
});
