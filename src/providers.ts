import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';

export interface ProviderOptions {
  /** Worker env (for AI binding and API keys). Required for @cf/* models. */
  env?: Record<string, unknown>;
  /** AI Gateway base URL override for routing LLM calls through CF AI Gateway. */
  gatewayUrl?: string;
}

// Helper: dynamic import with clear error message
async function dynamicImport<T>(pkg: string, hint: string): Promise<T> {
  try {
    return await import(/* @vite-ignore */ pkg) as T;
  } catch {
    throw new Error(
      `Provider package "${pkg}" is not installed. ${hint}`,
    );
  }
}

export async function resolveModel(modelId: string, options?: ProviderOptions): Promise<LanguageModel> {
  const gatewayUrl = options?.gatewayUrl;
  const env = options?.env ?? {};

  // ── Anthropic ──────────────────────────────────────────────────────────────
  // Models: claude-opus-4-5, claude-sonnet-4-5, claude-haiku-3-5, etc.
  // Env:    ANTHROPIC_API_KEY
  if (modelId.startsWith('claude-')) {
    const opts: { baseURL?: string; apiKey?: string } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    const apiKey = env.ANTHROPIC_API_KEY as string | undefined;
    if (apiKey) opts.apiKey = apiKey;
    return createAnthropic(opts)(modelId);
  }

  // ── OpenAI ────────────────────────────────────────────────────────────────
  // Models: gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o3-mini, etc.
  // Env:    OPENAI_API_KEY
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
    const opts: { baseURL?: string; apiKey?: string } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    const apiKey = env.OPENAI_API_KEY as string | undefined;
    if (apiKey) opts.apiKey = apiKey;
    return createOpenAI(opts)(modelId);
  }

  // ── Google Gemini ─────────────────────────────────────────────────────────
  // Models: gemini-2.5-pro, gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash, etc.
  // Env:    GOOGLE_AI_API_KEY
  if (modelId.startsWith('gemini-')) {
    const opts: { baseURL?: string; apiKey?: string } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    const apiKey = env.GOOGLE_AI_API_KEY as string | undefined;
    if (apiKey) opts.apiKey = apiKey;
    return createGoogleGenerativeAI(opts)(modelId);
  }

  // ── Cloudflare Workers AI ─────────────────────────────────────────────────
  // Models: @cf/meta/llama-3.1-8b-instruct, @cf/mistral/mistral-7b-instruct, etc.
  // Env:    AI binding in wrangler.toml
  if (modelId.startsWith('@cf/')) {
    const ai = env.AI;
    if (!ai) throw new Error('Workers AI requires an AI binding. Add [ai] binding = "AI" to wrangler.toml');
    const mod = await dynamicImport<{ createWorkersAI: (o: { binding: unknown }) => (m: string) => LanguageModel }>(
      '@ai-sdk/cloudflare',
      'Run: npm install @ai-sdk/cloudflare',
    );
    return mod.createWorkersAI({ binding: ai })(modelId);
  }

  // ── Groq ──────────────────────────────────────────────────────────────────
  // Models: groq/llama-3.3-70b-versatile, groq/mixtral-8x7b-32768, groq/gemma2-9b-it, etc.
  // Env:    GROQ_API_KEY
  if (modelId.startsWith('groq/')) {
    const mod = await dynamicImport<{ createGroq: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/groq',
      'Run: npm install @ai-sdk/groq',
    );
    const apiKey = env.GROQ_API_KEY as string | undefined;
    return mod.createGroq({ apiKey })(modelId.slice(5)); // strip "groq/" prefix
  }

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  // Models: deepseek-chat, deepseek-reasoner
  // Env:    DEEPSEEK_API_KEY
  if (modelId.startsWith('deepseek-')) {
    const mod = await dynamicImport<{ createDeepSeek: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/deepseek',
      'Run: npm install @ai-sdk/deepseek',
    );
    const apiKey = env.DEEPSEEK_API_KEY as string | undefined;
    return mod.createDeepSeek({ apiKey })(modelId);
  }

  // ── Mistral ───────────────────────────────────────────────────────────────
  // Models: mistral-large-latest, mistral-small-latest, codestral-latest, etc.
  // Env:    MISTRAL_API_KEY
  if (modelId.startsWith('mistral-') || modelId.startsWith('codestral-') || modelId.startsWith('pixtral-')) {
    const mod = await dynamicImport<{ createMistral: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/mistral',
      'Run: npm install @ai-sdk/mistral',
    );
    const apiKey = env.MISTRAL_API_KEY as string | undefined;
    return mod.createMistral({ apiKey })(modelId);
  }

  // ── xAI (Grok) ────────────────────────────────────────────────────────────
  // Models: grok-3, grok-3-mini, grok-2, grok-beta
  // Env:    XAI_API_KEY
  if (modelId.startsWith('grok-')) {
    const mod = await dynamicImport<{ createXai: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/xai',
      'Run: npm install @ai-sdk/xai',
    );
    const apiKey = env.XAI_API_KEY as string | undefined;
    return mod.createXai({ apiKey })(modelId);
  }

  // ── Perplexity ────────────────────────────────────────────────────────────
  // Models: sonar, sonar-pro, sonar-reasoning, sonar-reasoning-pro
  // Env:    PERPLEXITY_API_KEY
  if (modelId.startsWith('sonar') || modelId.startsWith('perplexity/')) {
    const mod = await dynamicImport<{ createPerplexity: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/perplexity',
      'Run: npm install @ai-sdk/perplexity',
    );
    const apiKey = env.PERPLEXITY_API_KEY as string | undefined;
    const id = modelId.startsWith('perplexity/') ? modelId.slice(11) : modelId;
    return mod.createPerplexity({ apiKey })(id);
  }

  // ── Together AI ───────────────────────────────────────────────────────────
  // Models: together/meta-llama/Llama-3.3-70B-Instruct-Turbo, together/mistralai/Mixtral-8x7B, etc.
  // Env:    TOGETHER_API_KEY
  if (modelId.startsWith('together/')) {
    const mod = await dynamicImport<{ createTogetherAI: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/togetherai',
      'Run: npm install @ai-sdk/togetherai',
    );
    const apiKey = env.TOGETHER_API_KEY as string | undefined;
    return mod.createTogetherAI({ apiKey })(modelId.slice(9)); // strip "together/"
  }

  // ── Cohere ────────────────────────────────────────────────────────────────
  // Models: command-r-plus, command-r, command-a-03-2025, etc.
  // Env:    COHERE_API_KEY
  if (modelId.startsWith('command-')) {
    const mod = await dynamicImport<{ createCohere: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/cohere',
      'Run: npm install @ai-sdk/cohere',
    );
    const apiKey = env.COHERE_API_KEY as string | undefined;
    return mod.createCohere({ apiKey })(modelId);
  }

  // ── Azure OpenAI ──────────────────────────────────────────────────────────
  // Models: azure/gpt-4o, azure/gpt-4-turbo, etc.
  // Env:    AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT
  if (modelId.startsWith('azure/')) {
    const mod = await dynamicImport<{ createAzure: (o: { apiKey?: string; baseURL?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/azure',
      'Run: npm install @ai-sdk/azure',
    );
    const apiKey = env.AZURE_OPENAI_API_KEY as string | undefined;
    const endpoint = env.AZURE_OPENAI_ENDPOINT as string | undefined;
    return mod.createAzure({ apiKey, baseURL: endpoint })(modelId.slice(6));
  }

  throw new Error(
    `Unsupported model: "${modelId}". Supported prefixes: claude-*, gpt-*, gemini-*, @cf/*, groq/*, deepseek-*, mistral-*, grok-*, sonar*, together/*, command-*, azure/*`,
  );
}
