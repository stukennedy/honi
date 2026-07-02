import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createWorkersAI } from 'workers-ai-provider';
import { createAiGateway } from 'ai-gateway-provider';
import type { LanguageModel } from 'ai';

/**
 * Cloudflare AI Gateway configuration.
 *
 * Routes LLM calls through your gateway for logging, caching, and rate limiting.
 * When the gateway holds provider credentials — via BYOK stored keys or Unified
 * Billing — no provider API keys are needed in the Worker at all.
 *
 * Authentication resolves in this order:
 * 1. AI binding (`[ai] binding = "AI"` in wrangler.toml) — keyless, same-account.
 * 2. `accountId` + gateway token from `tokenEnvVar` (sent as `cf-aig-authorization`).
 */
export interface AiGatewayConfig {
  /** Gateway ID (slug) from the Cloudflare dashboard. */
  gatewayId: string;
  /** Cloudflare account ID. Only needed when the AI binding is not available. */
  accountId?: string;
  /**
   * Env var holding an AI Gateway token (for authenticated gateways / stored keys).
   * Sent as `cf-aig-authorization: Bearer <token>`. Defaults to "CF_AIG_TOKEN".
   */
  tokenEnvVar?: string;
  /** Workers AI binding name (also used for keyless gateway auth). Defaults to "AI". */
  binding?: string;
}

export interface ProviderOptions {
  /** Worker env (for AI binding and API keys). Required for @cf/* models. */
  env?: Record<string, unknown>;
  /**
   * Route calls through Cloudflare AI Gateway. With BYOK keys stored in the
   * gateway (or Unified Billing), provider API keys can be omitted entirely.
   */
  gateway?: AiGatewayConfig;
  /**
   * @deprecated Use `gateway` instead. Raw baseURL override applied to
   * claude-*, gpt-*, and gemini-* models only.
   */
  gatewayUrl?: string;
}

// Minimal shape of the Workers AI binding's gateway accessor.
interface AiBindingWithGateway {
  gateway?: (id: string) => { run(data: unknown): Promise<Response> };
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

/**
 * Wrap a model so its calls go through Cloudflare AI Gateway.
 *
 * Prefers the keyless AI binding (`env.AI.gateway(id)`); falls back to the
 * REST endpoint with `accountId` + optional `cf-aig-authorization` token.
 */
function wrapWithGateway(
  model: LanguageModel,
  gateway: AiGatewayConfig,
  env: Record<string, unknown>,
): LanguageModel {
  const binding = env[gateway.binding ?? 'AI'] as AiBindingWithGateway | undefined;
  if (binding && typeof binding.gateway === 'function') {
    return createAiGateway({ binding: binding.gateway(gateway.gatewayId) })(model);
  }
  if (!gateway.accountId) {
    throw new Error(
      'AI Gateway requires either an AI binding ([ai] binding = "AI" in wrangler.toml) or gateway.accountId.',
    );
  }
  const token = env[gateway.tokenEnvVar ?? 'CF_AIG_TOKEN'] as string | undefined;
  return createAiGateway({
    accountId: gateway.accountId,
    gateway: gateway.gatewayId,
    ...(token ? { apiKey: token } : {}),
  })(model);
}

/**
 * Resolve a provider API key. When routing through AI Gateway, a placeholder
 * is substituted for missing keys: the gateway's stored keys (BYOK) or Unified
 * Billing credentials take precedence, so the placeholder is never used —
 * it only satisfies SDKs that refuse to send a request without a key.
 */
function resolveApiKey(
  env: Record<string, unknown>,
  envVar: string,
  gateway: AiGatewayConfig | undefined,
): string | undefined {
  const key = env[envVar] as string | undefined;
  if (key) return key;
  return gateway ? 'CF_AIG_STORED_KEY' : undefined;
}

export async function resolveModel(modelId: string, options?: ProviderOptions): Promise<LanguageModel> {
  const gatewayUrl = options?.gatewayUrl;
  const gateway = options?.gateway;
  const env = options?.env ?? {};
  const viaGateway = (model: LanguageModel): LanguageModel =>
    gateway ? wrapWithGateway(model, gateway, env) : model;

  // ── Anthropic ──────────────────────────────────────────────────────────────
  // Models: claude-opus-4-5, claude-sonnet-4-5, claude-haiku-3-5, etc.
  // Env:    ANTHROPIC_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('claude-')) {
    const opts: { baseURL?: string; apiKey?: string } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    const apiKey = resolveApiKey(env, 'ANTHROPIC_API_KEY', gateway);
    if (apiKey) opts.apiKey = apiKey;
    return viaGateway(createAnthropic(opts)(modelId));
  }

  // ── OpenAI ────────────────────────────────────────────────────────────────
  // Models: gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o3-mini, etc.
  // Env:    OPENAI_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
    const opts: { baseURL?: string; apiKey?: string } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    const apiKey = resolveApiKey(env, 'OPENAI_API_KEY', gateway);
    if (apiKey) opts.apiKey = apiKey;
    return viaGateway(createOpenAI(opts)(modelId));
  }

  // ── Google Gemini ─────────────────────────────────────────────────────────
  // Models: gemini-2.5-pro, gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash, etc.
  // Env:    GOOGLE_AI_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('gemini-')) {
    const opts: { baseURL?: string; apiKey?: string } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    const apiKey = resolveApiKey(env, 'GOOGLE_AI_API_KEY', gateway);
    if (apiKey) opts.apiKey = apiKey;
    return viaGateway(createGoogleGenerativeAI(opts)(modelId));
  }

  // ── Cloudflare Workers AI ─────────────────────────────────────────────────
  // Models: @cf/meta/llama-3.3-70b-instruct, @cf/mistral/mistral-7b-instruct, etc.
  // Env:    AI binding in wrangler.toml — no API key needed.
  if (modelId.startsWith('@cf/')) {
    const ai = env[gateway?.binding ?? 'AI'];
    if (!ai) throw new Error('Workers AI requires an AI binding. Add [ai] binding = "AI" to wrangler.toml');
    const workersai = createWorkersAI({
      binding: ai as Ai,
      ...(gateway ? { gateway: { id: gateway.gatewayId } } : {}),
    });
    return workersai(modelId as Parameters<typeof workersai>[0]);
  }

  // ── Groq ──────────────────────────────────────────────────────────────────
  // Models: groq/llama-3.3-70b-versatile, groq/mixtral-8x7b-32768, groq/gemma2-9b-it, etc.
  // Env:    GROQ_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('groq/')) {
    const mod = await dynamicImport<{ createGroq: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/groq',
      'Run: npm install @ai-sdk/groq',
    );
    const apiKey = resolveApiKey(env, 'GROQ_API_KEY', gateway);
    return viaGateway(mod.createGroq({ apiKey })(modelId.slice(5))); // strip "groq/" prefix
  }

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  // Models: deepseek-chat, deepseek-reasoner
  // Env:    DEEPSEEK_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('deepseek-')) {
    const mod = await dynamicImport<{ createDeepSeek: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/deepseek',
      'Run: npm install @ai-sdk/deepseek',
    );
    const apiKey = resolveApiKey(env, 'DEEPSEEK_API_KEY', gateway);
    return viaGateway(mod.createDeepSeek({ apiKey })(modelId));
  }

  // ── Mistral ───────────────────────────────────────────────────────────────
  // Models: mistral-large-latest, mistral-small-latest, codestral-latest, etc.
  // Env:    MISTRAL_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('mistral-') || modelId.startsWith('codestral-') || modelId.startsWith('pixtral-')) {
    const mod = await dynamicImport<{ createMistral: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/mistral',
      'Run: npm install @ai-sdk/mistral',
    );
    const apiKey = resolveApiKey(env, 'MISTRAL_API_KEY', gateway);
    return viaGateway(mod.createMistral({ apiKey })(modelId));
  }

  // ── xAI (Grok) ────────────────────────────────────────────────────────────
  // Models: grok-3, grok-3-mini, grok-2, grok-beta
  // Env:    XAI_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('grok-')) {
    const mod = await dynamicImport<{ createXai: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/xai',
      'Run: npm install @ai-sdk/xai',
    );
    const apiKey = resolveApiKey(env, 'XAI_API_KEY', gateway);
    return viaGateway(mod.createXai({ apiKey })(modelId));
  }

  // ── Perplexity ────────────────────────────────────────────────────────────
  // Models: sonar, sonar-pro, sonar-reasoning, sonar-reasoning-pro
  // Env:    PERPLEXITY_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('sonar') || modelId.startsWith('perplexity/')) {
    const mod = await dynamicImport<{ createPerplexity: (o: { apiKey?: string }) => (m: string) => LanguageModel }>(
      '@ai-sdk/perplexity',
      'Run: npm install @ai-sdk/perplexity',
    );
    const apiKey = resolveApiKey(env, 'PERPLEXITY_API_KEY', gateway);
    const id = modelId.startsWith('perplexity/') ? modelId.slice(11) : modelId;
    return viaGateway(mod.createPerplexity({ apiKey })(id));
  }

  // ── Together AI ───────────────────────────────────────────────────────────
  // Models: together/meta-llama/Llama-3.3-70B-Instruct-Turbo, together/mistralai/Mixtral-8x7B, etc.
  // Env:    TOGETHER_API_KEY (AI Gateway routing not supported — always direct)
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
  // Env:    COHERE_API_KEY (AI Gateway routing not supported — always direct)
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
    const apiKey = resolveApiKey(env, 'AZURE_OPENAI_API_KEY', gateway);
    const endpoint = env.AZURE_OPENAI_ENDPOINT as string | undefined;
    return viaGateway(mod.createAzure({ apiKey, baseURL: endpoint })(modelId.slice(6)));
  }

  throw new Error(
    `Unsupported model: "${modelId}". Supported prefixes: claude-*, gpt-*, gemini-*, @cf/*, groq/*, deepseek-*, mistral-*, grok-*, sonar*, together/*, command-*, azure/*`,
  );
}
