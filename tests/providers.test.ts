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
