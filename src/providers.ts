import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export interface ProviderOptions {
  /** Worker env (for AI binding). Required for @cf/* models. */
  env?: Record<string, unknown>;
  /** AI Gateway base URL override for routing LLM calls through CF AI Gateway. */
  gatewayUrl?: string;
}

export async function resolveModel(modelId: string, options?: ProviderOptions): Promise<LanguageModel> {
  const gatewayUrl = options?.gatewayUrl;

  if (modelId.startsWith('claude-')) {
    const providerOptions: { baseURL?: string; apiKey?: string } = {};
    if (gatewayUrl) providerOptions.baseURL = gatewayUrl;
    // In CF Workers, secrets live in env — process.env is not populated
    const apiKey = options?.env?.ANTHROPIC_API_KEY as string | undefined;
    if (apiKey) providerOptions.apiKey = apiKey;
    const provider = createAnthropic(providerOptions);
    return provider(modelId);
  }

  if (modelId.startsWith('gpt-')) {
    const providerOptions: { baseURL?: string; apiKey?: string } = {};
    if (gatewayUrl) providerOptions.baseURL = gatewayUrl;
    const apiKey = options?.env?.OPENAI_API_KEY as string | undefined;
    if (apiKey) providerOptions.apiKey = apiKey;
    const provider = createOpenAI(providerOptions);
    return provider(modelId);
  }

  if (modelId.startsWith('@cf/')) {
    const ai = options?.env?.AI;
    if (!ai) {
      throw new Error(
        'Workers AI requires an AI binding in your Worker env. Add [ai] binding = "AI" to wrangler.toml',
      );
    }
    try {
      // Dynamic import — @ai-sdk/cloudflare is an optional peer dependency
      const pkg = '@ai-sdk/cloudflare';
      const mod = await import(/* @vite-ignore */ pkg) as { createWorkersAI: (opts: { binding: unknown }) => (model: string) => LanguageModel };
      const workersai = mod.createWorkersAI({ binding: ai });
      return workersai(modelId);
    } catch {
      throw new Error(
        'Workers AI support requires @ai-sdk/cloudflare: npm install @ai-sdk/cloudflare',
      );
    }
  }

  throw new Error(
    `Unsupported model: "${modelId}". Use a claude-*, gpt-*, or @cf/* model ID.`,
  );
}
