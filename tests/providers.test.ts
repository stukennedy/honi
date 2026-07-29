import { describe, expect, it } from 'bun:test';
import { AiGatewayChatLanguageModel } from 'ai-gateway-provider';
import { resolveModel } from '../src/providers.js';
import type { AiGatewayConfig } from '../src/providers.js';

// Minimal stand-in for the Workers AI binding (env.AI)
function mockAiBinding(gatewayCalls?: string[]) {
  return {
    run: async () => ({}),
    gateway: (id: string) => {
      gatewayCalls?.push(id);
      return { run: async () => new Response() };
    },
  };
}

const gatewayConfig: AiGatewayConfig = {
  accountId: 'acc123',
  gatewayId: 'gw456',
};

describe('resolveModel — Workers AI (@cf/*)', () => {
  it('resolves a @cf model from the AI binding without any API key', async () => {
    const model = await resolveModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      env: { AI: mockAiBinding() },
    });
    expect(model.modelId).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('throws a helpful error when the AI binding is missing', async () => {
    await expect(resolveModel('@cf/meta/llama-3.1-8b-instruct', { env: {} })).rejects.toThrow(
      /AI binding/,
    );
  });
});

describe('resolveModel — AI Gateway', () => {
  it('wraps hosted models in the gateway when configured', async () => {
    const model = await resolveModel('claude-sonnet-4-5', {
      env: { CF_AIG_TOKEN: 'secret' },
      gateway: gatewayConfig,
    });
    expect(model).toBeInstanceOf(AiGatewayChatLanguageModel);
    expect(model.modelId).toBe('claude-sonnet-4-5');
  });

  it('resolves without a provider API key when the gateway is configured (no BYOK)', async () => {
    const model = await resolveModel('gpt-4o', { env: {}, gateway: gatewayConfig });
    expect(model).toBeInstanceOf(AiGatewayChatLanguageModel);
    expect(model.modelId).toBe('gpt-4o');
  });

  it('prefers keyless AI binding auth when env.AI.gateway is available', async () => {
    const gatewayCalls: string[] = [];
    const model = await resolveModel('gemini-2.0-flash', {
      env: { AI: mockAiBinding(gatewayCalls) },
      gateway: { gatewayId: 'gw456' }, // no accountId, no token
    });
    expect(model).toBeInstanceOf(AiGatewayChatLanguageModel);
    expect(gatewayCalls).toEqual(['gw456']);
  });

  it('throws when neither an AI binding nor accountId is available', async () => {
    await expect(
      resolveModel('claude-sonnet-4-5', { env: {}, gateway: { gatewayId: 'gw456' } }),
    ).rejects.toThrow(/accountId/);
  });

  it('does not wrap models when no gateway is configured', async () => {
    const model = await resolveModel('claude-sonnet-4-5', {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
    });
    expect(model).not.toBeInstanceOf(AiGatewayChatLanguageModel);
    expect(model.modelId).toBe('claude-sonnet-4-5');
  });

  it('routes @cf models through the gateway id without wrapping', async () => {
    const model = await resolveModel('@cf/meta/llama-3.1-8b-instruct', {
      env: { AI: mockAiBinding() },
      gateway: { gatewayId: 'gw456' },
    });
    // Workers AI handles the gateway natively via binding options
    expect(model).not.toBeInstanceOf(AiGatewayChatLanguageModel);
    expect(model.modelId).toBe('@cf/meta/llama-3.1-8b-instruct');
  });
});

describe('resolveModel — errors', () => {
  it('throws on unsupported model ids', async () => {
    await expect(resolveModel('not-a-model', {})).rejects.toThrow(/Unsupported model/);
  });
});

// ---------------------------------------------------------------------------
// Wire-level helpers: stub fetch and capture what the provider actually sends.
// Asserting the request URL (not the config we passed in) is deliberate — the
// AI SDK treats baseURL as already containing the version segment, and a URL
// assembled one path segment wrong 404s in production while every config-level
// assertion stays green.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Minimal valid Anthropic Messages API response. */
function anthropicResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'test',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

async function captureWireRequest(
  model: Awaited<ReturnType<typeof resolveModel>>,
): Promise<CapturedRequest> {
  const captured: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (v, k) => {
        headers[k] = v;
      },
    );
    captured.push({ url, headers });
    return anthropicResponse();
  }) as typeof fetch;
  try {
    await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  if (captured.length !== 1) throw new Error(`expected 1 request, saw ${captured.length}`);
  return captured[0];
}

describe('resolveModel — AWS Bedrock (bedrock/*)', () => {
  const bedrockEnv = {
    AWS_BEDROCK_REGION: 'eu-west-1',
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-123',
  };

  it('sends the request to the mantle Messages endpoint, /v1 included', async () => {
    const model = await resolveModel('bedrock/anthropic.claude-haiku-4-5', { env: bedrockEnv });
    const req = await captureWireRequest(model);
    // The full wire URL — a baseURL missing /v1 yields .../anthropic/messages,
    // which passes config-level assertions and 404s live.
    expect(req.url).toBe('https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages');
  });

  it('authenticates with an Authorization bearer header', async () => {
    const model = await resolveModel('bedrock/anthropic.claude-haiku-4-5', { env: bedrockEnv });
    const req = await captureWireRequest(model);
    expect(req.headers['authorization']).toBe('Bearer bedrock-key-123');
  });

  it("passes Bedrock's vendor-prefixed model id through verbatim", async () => {
    const model = await resolveModel('bedrock/anthropic.claude-haiku-4-5', { env: bedrockEnv });
    expect(model.modelId).toBe('anthropic.claude-haiku-4-5');
  });

  it('merges caller headers on top of the auth header', async () => {
    const model = await resolveModel('bedrock/anthropic.claude-haiku-4-5', {
      env: bedrockEnv,
      headers: { 'x-trace-id': 'trace-1' },
    });
    const req = await captureWireRequest(model);
    expect(req.headers['x-trace-id']).toBe('trace-1');
    expect(req.headers['authorization']).toBe('Bearer bedrock-key-123');
  });

  it('fails loudly without a region — region choice is a residency decision', async () => {
    await expect(
      resolveModel('bedrock/anthropic.claude-haiku-4-5', {
        env: { AWS_BEARER_TOKEN_BEDROCK: 'k' },
      }),
    ).rejects.toThrow(/AWS_BEDROCK_REGION/);
  });

  it('fails loudly without a bearer token', async () => {
    await expect(
      resolveModel('bedrock/anthropic.claude-haiku-4-5', {
        env: { AWS_BEDROCK_REGION: 'eu-west-1' },
      }),
    ).rejects.toThrow(/AWS_BEARER_TOKEN_BEDROCK/);
  });

  it('refuses AI Gateway routing rather than silently going direct', async () => {
    await expect(
      resolveModel('bedrock/anthropic.claude-haiku-4-5', {
        env: bedrockEnv,
        gateway: gatewayConfig,
      }),
    ).rejects.toThrow(/cannot be routed through AI Gateway/);
  });
});

describe('resolveModel — provider headers (direct route)', () => {
  it('sends caller headers on a direct claude-* request', async () => {
    const model = await resolveModel('claude-sonnet-4-5', {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      headers: { 'x-custom': 'yes' },
    });
    const req = await captureWireRequest(model);
    expect(req.headers['x-custom']).toBe('yes');
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('resolveModel — AI Gateway request options', () => {
  it('passes options (collectLog, metadata) through to the gateway wrapper', async () => {
    const model = (await resolveModel('claude-sonnet-4-5', {
      env: { CF_AIG_TOKEN: 'secret' },
      gateway: {
        ...gatewayConfig,
        options: { collectLog: false, metadata: { app: 'test' } },
      },
    })) as AiGatewayChatLanguageModel;
    expect(model).toBeInstanceOf(AiGatewayChatLanguageModel);
    expect(model.config.options?.collectLog).toBe(false);
    expect(model.config.options?.metadata).toEqual({ app: 'test' });
  });

  it('passes options on the keyless binding path too', async () => {
    const model = (await resolveModel('claude-sonnet-4-5', {
      env: { AI: mockAiBinding() },
      gateway: { gatewayId: 'gw456', options: { collectLog: false } },
    })) as AiGatewayChatLanguageModel;
    expect(model.config.options?.collectLog).toBe(false);
  });
});
