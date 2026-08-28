import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createWorkersAI } from 'workers-ai-provider';
import { createAiGateway, type AiGatewayOptions } from 'ai-gateway-provider';
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
  /**
   * Per-request gateway options, passed straight through to the gateway
   * (`cf-aig-*` headers): caching, retries, timeouts, `metadata` for log
   * filtering, and `collectLog`.
   *
   * Privacy note: the gateway stores full request AND response bodies by
   * default (`collectLog` defaults to true server-side, and there is no
   * gateway-level setting to turn it off). If prompts carry user data, set
   * `collectLog: false` — token counts, model, cost and latency are still
   * logged; the payloads are not.
   */
  options?: AiGatewayOptions;
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
  /**
   * Extra headers sent on every request to the provider. Applied to the
   * claude-*, gpt-*, gemini-* and bedrock/* factories (the AI SDK providers
   * that accept a `headers` option). Useful for proxy auth or observability
   * headers on a direct (non-gateway) route.
   */
  headers?: Record<string, string>;
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
    return createAiGateway({
      binding: binding.gateway(gateway.gatewayId),
      ...(gateway.options ? { options: gateway.options } : {}),
    })(model);
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
    ...(gateway.options ? { options: gateway.options } : {}),
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
  return gateway ? 'CF_TEMP_TOKEN' : undefined;
}

/**
 * Wrap a model so a stream that closes CLEANLY with zero output is re-issued.
 *
 * Both the Google direct API and the OpenRouter bridge do this: no error is
 * thrown, the AI SDK synthesises finishReason 'unknown', the turn ends "done"
 * and the caller gets silence with a bare unanswered user turn in memory.
 * This is the only layer that can both detect the zero-output close and act
 * without buffering — parts are held only until the FIRST usable part, then
 * it is realtime pass-through.
 *
 * Content = output the turn can actually use: non-empty text, or a COMPLETE
 * tool call. A dangling `tool-call-delta` whose args never finish (the
 * observed live shape: the stream dies mid-call, finishReason 'unknown', zero
 * tokens billed) yields nothing upstream and must still trigger the retry.
 *
 * `onRetry` lets the caller escalate a provider knob for the rescue attempt
 * only — the fast path keeps its low-latency setting, and only a retry pays
 * for the more expensive one.
 */
export function withEmptyStreamRetry(
  model: LanguageModel,
  opts: { label: string; escalated: boolean; onRetry?: () => void },
): LanguageModel {
  type StreamPart = { type?: string; textDelta?: unknown; finishReason?: unknown; error?: unknown };
  const isContent = (part: StreamPart): boolean =>
    (part?.type === 'text-delta' && typeof part.textDelta === 'string' && part.textDelta.length > 0) ||
    part?.type === 'tool-call';
  const m = model as unknown as Record<string, any>;
  return {
    specificationVersion: m.specificationVersion,
    provider: m.provider,
    modelId: m.modelId,
    defaultObjectGenerationMode: m.defaultObjectGenerationMode,
    supportsImageUrls: m.supportsImageUrls,
    supportsStructuredOutputs: m.supportsStructuredOutputs,
    ...(m.supportsUrl ? { supportsUrl: m.supportsUrl.bind(m) } : {}),
    doGenerate: (options: unknown) => m.doGenerate(options),
    doStream: async (options: unknown) => {
      const first = await m.doStream(options);
      // Cancellation has to reach the PROVIDER. `start()` pumps eagerly, so a
      // consumer that cancels the wrapper (a client disconnecting mid-turn)
      // would otherwise leave the upstream fetch body locked and the model
      // generating — and billing — until it finished on its own. Consuming the
      // provider stream directly does not have this problem; wrapping it
      // introduces it, so the wrapper has to hand cancellation back.
      let activeReader: ReadableStreamDefaultReader<unknown> | undefined;
      let cancelled = false;
      const stream = new ReadableStream({
        async start(controller) {
          // Diagnostics per attempt: the upstream finishReason (the AI SDK
          // later synthesises 'unknown', so this is the only place the REAL
          // reason is visible) plus what part types the empty stream carried.
          const pump = async (attempt: { stream: ReadableStream }) => {
            const reader = attempt.stream.getReader();
            activeReader = reader;
            let sawContent = false;
            let finishReason: unknown = null;
            let providerError: string | null = null;
            const partTypes: Record<string, number> = {};
            const held: unknown[] = [];
            // Captured rather than thrown: the caller has to know whether THIS
            // attempt already forwarded parts downstream before it died, and a
            // throw loses that with the rest of the state.
            let failure: unknown;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const part = value as StreamPart;
                const t = part?.type ?? 'unknown';
                partTypes[t] = (partTypes[t] ?? 0) + 1;
                if (t === 'finish' && part.finishReason) finishReason = part.finishReason;
                if (t === 'error') providerError = String(part.error ?? 'unknown');
                if (!sawContent && isContent(part)) {
                  sawContent = true;
                  for (const h of held) controller.enqueue(h);
                  held.length = 0;
                }
                if (sawContent) controller.enqueue(value);
                else held.push(value);
              }
            } catch (err) {
              failure = err;
            } finally {
              activeReader = undefined;
            }
            return { sawContent, held, finishReason, providerError, partTypes, failure };
          };
          const emptyDiagnostics = (last: Awaited<ReturnType<typeof pump>>) => ({
            finishReason: last.finishReason,
            providerError: last.providerError,
            partTypes: last.partTypes,
          });
          const MAX_RETRIES = 2;
          let last = await pump(first);
          // A first attempt that dies mid-stream is a genuine failure, not the
          // clean zero-output close this wrapper exists to rescue — surface it
          // exactly as an unwrapped model would.
          if (last.failure) {
            controller.error(last.failure);
            return;
          }
          for (let attempt = 1; !last.sawContent && attempt <= MAX_RETRIES; attempt++) {
            // A cancelled stream reads as "no content"; retrying it would open
            // a fresh upstream request for a consumer that has already gone.
            if (cancelled) return;
            console.warn(`[honidev] ${opts.label} empty stream — retrying`, {
              modelId: m.modelId,
              attempt,
              maxRetries: MAX_RETRIES,
              escalated: opts.escalated,
              ...emptyDiagnostics(last),
            });
            let next: { stream: ReadableStream } | undefined;
            try {
              opts.onRetry?.();
              next = await m.doStream(options);
            } catch {
              // Could not even open a retry — degrade to giving up below,
              // which is the behaviour a caller had before this wrapper.
              break;
            }
            if (!next) break;
            const result = await pump(next);
            if (result.failure) {
              // Anything this attempt forwarded is ALREADY downstream. Closing
              // cleanly would hand the consumer a truncated turn labelled
              // success, and appending the first attempt's held parts on top of
              // it would corrupt the stream outright.
              if (result.sawContent) {
                controller.error(result.failure);
                return;
              }
              // Nothing was forwarded, so `last` is still the empty first
              // attempt and the give-up path below stays correct.
              break;
            }
            last = result;
          }
          if (cancelled) return;
          if (!last.sawContent) {
            console.warn(`[honidev] ${opts.label} empty stream — giving up`, {
              modelId: m.modelId,
              maxRetries: MAX_RETRIES,
              ...emptyDiagnostics(last),
            });
            for (const h of last.held) controller.enqueue(h);
          }
          controller.close();
        },
        async cancel(reason) {
          cancelled = true;
          await activeReader?.cancel(reason);
        },
      });
      return { ...first, stream };
    },
  } as unknown as LanguageModel;
}

/**
 * JSON-schema helpers for OPENROUTER_STRICT_TOOLS. Module scope (not exported
 * from index.ts, so not public API) purely so they are reachable from tests —
 * both are pure, and both encode rules that are easy to get subtly wrong.
 */
// Widen a schema to admit null. `type` alone is NOT enough: a value has to
// satisfy `type` AND `enum`/`const`, so `{type:['string','null'], enum:[…]}`
// still rejects null — and since strict mode also moves the key into
// `required`, both omission and null would be invalid and an OPTIONAL tool
// argument would have silently become mandatory.
export function nullable(schema: any): any {
  if (schema === null || typeof schema !== 'object') return schema;
  const widenType = (type: unknown): unknown => {
    if (typeof type === 'string') return [type, 'null'];
    if (Array.isArray(type)) return type.includes('null') ? type : [...type, 'null'];
    return type;
  };
  if (Array.isArray(schema.enum)) {
    return {
      ...schema,
      enum: schema.enum.includes(null) ? schema.enum : [...schema.enum, null],
      ...(schema.type === undefined ? {} : { type: widenType(schema.type) }),
    };
  }
  if (schema.const !== undefined) {
    // A const cannot be widened in place — the branch has to become a union.
    const { const: constValue, type, ...rest } = schema;
    return {
      ...rest,
      anyOf: [{ const: constValue, ...(type === undefined ? {} : { type }) }, { type: 'null' }],
    };
  }
  if (schema.type !== undefined) return { ...schema, type: widenType(schema.type) };
  if (Array.isArray(schema.anyOf)) return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  // $ref / oneOf / allOf cannot be widened in place either. Passing them
  // through unchanged would be the same trap as the enum case: strict mode
  // still moves the key into `required`, so the argument could be neither
  // omitted nor null and an optional one has quietly become mandatory.
  return { anyOf: [schema, { type: 'null' }] };
}
export function strictify(schema: any): any {
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(strictify);
  const out: Record<string, any> = { ...schema };
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const originallyRequired = new Set<string>(Array.isArray(out.required) ? out.required : []);
    const props: Record<string, any> = {};
    for (const [key, value] of Object.entries(out.properties)) {
      let next = strictify(value);
      if (!originallyRequired.has(key)) next = nullable(next);
      props[key] = next;
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictify(out.items);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(out[key])) out[key] = out[key].map(strictify);
  }
  // Reusable and recursive schemas live in $defs/definitions and are reached
  // only through $ref, so the property walk above never visits them. Left
  // alone they keep their missing `required` and additionalProperties, and a
  // function marked strict: true is rejected before generation.
  for (const key of ['$defs', 'definitions']) {
    const defs = out[key];
    if (defs && typeof defs === 'object' && !Array.isArray(defs)) {
      out[key] = Object.fromEntries(
        Object.entries(defs).map(([name, value]) => [name, strictify(value)]),
      );
    }
  }
  if (out.type === undefined && !out.$ref && !out.anyOf && !out.oneOf && !out.allOf) {
    if (Array.isArray(out.enum) && out.enum.length > 0) {
      const kinds = [...new Set(out.enum.map((v: unknown) => (v === null ? 'null' : typeof v)))];
      out.type = kinds.length === 1 ? kinds[0] : kinds;
    } else if (out.const !== undefined) {
      out.type = out.const === null ? 'null' : typeof out.const;
    } else {
      out.type = 'string';
    }
  }
  return out;
}

export async function resolveModel(modelId: string, options?: ProviderOptions): Promise<LanguageModel> {
  const gatewayUrl = options?.gatewayUrl;
  const gateway = options?.gateway;
  const headers = options?.headers;
  const env = options?.env ?? {};
  const viaGateway = (model: LanguageModel): LanguageModel =>
    gateway ? wrapWithGateway(model, gateway, env) : model;

  // ── Anthropic ──────────────────────────────────────────────────────────────
  // Models: claude-opus-4-5, claude-sonnet-4-5, claude-haiku-3-5, etc.
  // Env:    ANTHROPIC_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('claude-')) {
    const opts: { baseURL?: string; apiKey?: string; headers?: Record<string, string> } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    if (headers) opts.headers = headers;
    const apiKey = resolveApiKey(env, 'ANTHROPIC_API_KEY', gateway);
    if (apiKey) opts.apiKey = apiKey;
    return viaGateway(createAnthropic(opts)(modelId));
  }

  // ── AWS Bedrock (Anthropic models via the bedrock-mantle endpoint) ────────
  // Models: bedrock/anthropic.claude-haiku-4-5, bedrock/anthropic.claude-sonnet-4-5, etc.
  // Env:    AWS_BEARER_TOKEN_BEDROCK (a long-term Bedrock API key), AWS_BEDROCK_REGION
  //
  // The mantle endpoint speaks the Anthropic Messages API natively
  // (https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages) with plain
  // bearer-token auth — no SigV4, no AWS SDK. So this is the standard Anthropic
  // provider pointed at AWS-operated serving infrastructure: an independent
  // failure domain from api.anthropic.com running the same models.
  //
  // The model id after the prefix is passed to Bedrock verbatim and uses
  // Bedrock's naming (vendor-prefixed, e.g. `anthropic.claude-haiku-4-5`), not
  // Anthropic's. Region choice is a data-residency decision: a request only
  // stays in-region if the region (and any inference profile the account maps
  // it to) says so.
  if (modelId.startsWith('bedrock/')) {
    if (gateway) {
      throw new Error(
        'bedrock/* models cannot be routed through AI Gateway: the gateway\'s Bedrock support uses ' +
        'its own aws-bedrock endpoint scheme, not the mantle endpoint this provider targets. ' +
        'Use bedrock/* direct, or route a claude-* model through the gateway instead.',
      );
    }
    const region = env.AWS_BEDROCK_REGION as string | undefined;
    const token = env.AWS_BEARER_TOKEN_BEDROCK as string | undefined;
    if (!region) {
      throw new Error(
        'Bedrock models require AWS_BEDROCK_REGION in env (e.g. "eu-west-1"). ' +
        'Pick the region deliberately — it decides where prompts are processed.',
      );
    }
    if (!token) {
      throw new Error(
        'Bedrock models require AWS_BEARER_TOKEN_BEDROCK in env (a long-term Amazon Bedrock API key).',
      );
    }
    const id = modelId.slice('bedrock/'.length);
    return createAnthropic({
      // The /v1 suffix is load-bearing: the Anthropic provider treats baseURL as
      // already containing the version segment and appends only /messages.
      baseURL: `https://bedrock-mantle.${region}.api.aws/anthropic/v1`,
      // Bedrock authenticates with `Authorization: Bearer`. The SDK insists on
      // an apiKey (sent as x-api-key), so the token rides both headers — same
      // credential, same host.
      apiKey: token,
      headers: { Authorization: `Bearer ${token}`, ...headers },
    })(id);
  }

  // ── OpenAI ────────────────────────────────────────────────────────────────
  // Models: gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o3-mini, etc.
  // Env:    OPENAI_API_KEY (optional with AI Gateway stored keys)
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
    const opts: { baseURL?: string; apiKey?: string; headers?: Record<string, string> } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    if (headers) opts.headers = headers;
    const apiKey = resolveApiKey(env, 'OPENAI_API_KEY', gateway);
    if (apiKey) opts.apiKey = apiKey;
    return viaGateway(createOpenAI(opts)(modelId));
  }

  // ── Google Gemini ─────────────────────────────────────────────────────────
  // Models: gemini-2.5-pro, gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash, etc.
  // Env:    GOOGLE_AI_API_KEY (required without AI Gateway stored keys — requests
  //         go straight to generativelanguage.googleapis.com, so a missing key
  //         must fail loudly here rather than as a per-turn 401/403),
  //         GOOGLE_THINKING_CONFIG / GOOGLE_THINKING_CONFIG_RETRY /
  //         GOOGLE_RETRY_EMPTY (optional, see below).
  if (modelId.startsWith('gemini-')) {
    const opts: {
      baseURL?: string;
      apiKey?: string;
      headers?: Record<string, string>;
      fetch?: typeof fetch;
    } = {};
    if (gatewayUrl) opts.baseURL = gatewayUrl;
    if (headers) opts.headers = headers;
    const apiKey = resolveApiKey(env, 'GOOGLE_AI_API_KEY', gateway);
    // Loud only on the DIRECT route. With no key the request goes straight to
    // generativelanguage.googleapis.com and can only fail as a per-turn
    // 401/403, so the missing variable should be named here instead. But the
    // deprecated `gatewayUrl` override (with `headers` for proxy auth) is a
    // documented keyless path — a proxy or gateway holds the credential — and
    // throwing on it would break callers who never had a Google key at all.
    if (!apiKey && !gatewayUrl) {
      throw new Error(
        'gemini-* models require GOOGLE_AI_API_KEY in the Worker env (or an AI Gateway with stored keys, or a gatewayUrl proxy that supplies them).',
      );
    }
    if (apiKey) opts.apiKey = apiKey;

    // GOOGLE_THINKING_CONFIG (raw JSON, e.g. '{"thinkingLevel":"minimal"}' or
    // '{"thinkingBudget":0}') injects the Gemini API's
    // `generationConfig.thinkingConfig` into every request body — the knob
    // that sets thinking effort on models honouring it. It rides the fetch
    // wrapper below, NOT modelSettings.providerOptions: @ai-sdk/google's
    // provider-options zod schema admits only thinkingBudget/includeThoughts
    // and silently STRIPS unknown keys, so thinkingLevel (the 3.x control)
    // can only reach the wire here.
    //
    // GOOGLE_THINKING_CONFIG_RETRY is the config used on an EMPTY-STREAM
    // RETRY only: gemini-3.5-flash-lite at thinkingLevel "minimal"
    // intermittently returns MALFORMED_RESPONSE with zero output (live A/B
    // 2026-08-20: 2/3 empty at minimal, 0/3 at low on the same body) — the
    // fast path keeps minimal's TTFT, only the rescue pays for the higher
    // level.
    const parseThinking = (name: string): unknown => {
      const raw = env[name] as string | undefined;
      if (!raw) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`${name} must be valid JSON (e.g. {"thinkingLevel":"minimal"}).`);
      }
    };
    const thinkingConfig = parseThinking('GOOGLE_THINKING_CONFIG');
    const retryThinkingConfig = parseThinking('GOOGLE_THINKING_CONFIG_RETRY');

    // Pending escalations, consumed by the next outbound fetch. A counter
    // rather than per-request plumbing because the AI-SDK fetch hook has no
    // retry context; under concurrency a mis-attributed escalation only makes
    // an unrelated request think harder — safe by design.
    let thinkingEscalations = 0;

    // The wrapper is ALWAYS installed on this branch — independent of any
    // thinking config — because of the thought-signature repair: the Gemini
    // 3.x API REJECTS (400 INVALID_ARGUMENT) any history functionCall part
    // without a thoughtSignature, and @ai-sdk/google predates signatures
    // entirely (strips them from responses, never replays them), so every
    // post-tool-call turn dies without this. Google's documented escape hatch
    // for history not produced with signatures is the sentinel below
    // (ai.google.dev/gemini-api/docs/thought-signatures).
    opts.fetch = (async (url: string, init?: RequestInit) => {
      let nextInit = init;
      try {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
        if (Array.isArray(body.contents)) {
          for (const content of body.contents) {
            if (!Array.isArray(content?.parts)) continue;
            for (const part of content.parts) {
              if (part && typeof part === 'object' && part.functionCall && !part.thoughtSignature) {
                part.thoughtSignature = 'context_engineering_is_the_way_to_go';
              }
            }
          }
        }
        let effectiveThinking = thinkingConfig;
        if (thinkingEscalations > 0 && retryThinkingConfig) {
          thinkingEscalations--;
          effectiveThinking = retryThinkingConfig;
        }
        if (effectiveThinking) {
          body.generationConfig = { ...(body.generationConfig ?? {}), thinkingConfig: effectiveThinking };
        }
        nextInit = { ...init, body: JSON.stringify(body) };
      } catch {
        // Non-JSON body — pass through untouched.
      }
      const res = await fetch(url, nextInit);
      if (!res.ok) {
        // Google's error body names the offending field/position, never
        // conversation content — and without this a caller's content-free
        // logging reduces every 4xx to an anonymous AI_APICallError.
        let detail = '';
        try {
          detail = (await res.clone().text()).slice(0, 500);
        } catch {
          // Body unreadable — status alone still lands below.
        }
        console.warn('[honidev] google api error', { status: res.status, detail });
      }
      return res;
    }) as unknown as typeof fetch;

    const base = viaGateway(createGoogleGenerativeAI(opts)(modelId));
    if (env.GOOGLE_RETRY_EMPTY === '1') {
      if (!(globalThis as any).__honidevGoogleRetryLogged) {
        (globalThis as any).__honidevGoogleRetryLogged = true;
        console.warn('[honidev] google empty-stream retry ACTIVE');
      }
      return withEmptyStreamRetry(base, {
        label: 'google',
        escalated: !!retryThinkingConfig,
        onRetry: () => {
          if (retryThinkingConfig) thinkingEscalations++;
        },
      });
    }
    return base;
  }

  // ── Cloudflare Workers AI partner catalog ─────────────────────────────────
  // Models: google/gemini-3.5-flash-lite, anthropic/claude-haiku-4.5, etc. —
  // third-party models served through the AI binding on Cloudflare unified
  // billing: no provider API key (developers.cloudflare.com/ai/models/).
  //
  // Deliberately NOT workers-ai-provider: the partner endpoint passes each
  // provider's NATIVE schema through on both legs, and workers-ai-provider's
  // Workers-AI translation breaks them BOTH ways (tool payloads are rejected
  // with a 400 "User Input Error", and streamed chunks parse to a single
  // collapsed delta — measured live against google/gemini-3.5-flash-lite,
  // 2026-08-13). Instead: the provider family's own AI SDK package with a
  // fetch that hands the request to `binding.run()` — the binding does auth +
  // billing, the provider does the schema, and tool-call streaming (`b:`/`c:`
  // parts) works.
  const partnerFamily = modelId.startsWith('google/')
    ? 'openai' // Google's partner endpoint accepts OpenAI chat.completions.
    : modelId.startsWith('anthropic/')
      ? 'anthropic' // Anthropic passes the Messages API through natively.
      : null;
  if (partnerFamily) {
    const ai = env[gateway?.binding ?? 'AI'];
    if (!ai) throw new Error('Workers AI requires an AI binding. Add [ai] binding = "AI" to wrangler.toml');
    const binding = ai as Ai;
    const bindingFetch: typeof fetch = async (_url, init) => {
      const { model: _model, stream, ...payload } = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string;
        stream?: boolean;
        [key: string]: unknown;
      };
      const result = await binding.run(
        modelId as Parameters<Ai['run']>[0],
        { ...payload, ...(stream ? { stream: true } : {}) } as Parameters<Ai['run']>[1],
        ...(gateway ? [{ gateway: { id: gateway.gatewayId } }] : []),
      );
      if (stream) {
        return new Response(result as ReadableStream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return Response.json(result);
    };
    if (partnerFamily === 'anthropic') {
      return createAnthropic({ apiKey: 'workers-ai-binding', fetch: bindingFetch })(modelId);
    }
    const openai = createOpenAI({
      baseURL: 'https://workers-ai.binding.internal/v1',
      apiKey: 'workers-ai-binding',
      compatibility: 'compatible',
      fetch: bindingFetch,
    });
    return openai.chat(modelId);
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

  // ── OpenRouter ────────────────────────────────────────────────────────────
  // Models: openrouter/anthropic/claude-haiku-4.5, openrouter/google/gemini-3.5-flash-lite,
  // etc. — any OpenRouter catalogue id behind the `openrouter/` prefix, served
  // over OpenRouter's OpenAI-compatible /chat/completions endpoint.
  // Env:    OPENROUTER_API_KEY (required — no gateway placeholder: requests go
  //         straight to openrouter.ai, so a missing key must fail loudly here
  //         rather than as a per-turn 401), plus the optional
  //         OPENROUTER_REASONING / OPENROUTER_REASONING_RETRY /
  //         OPENROUTER_STRICT_TOOLS / OPENROUTER_RETRY_EMPTY knobs below.
  if (modelId.startsWith('openrouter/')) {
    const id = modelId.slice('openrouter/'.length);
    const apiKey = env.OPENROUTER_API_KEY as string | undefined;
    if (!apiKey) {
      throw new Error('openrouter/* models require OPENROUTER_API_KEY in the Worker env.');
    }

    // One fetch wrapper for three OpenRouter quirks.
    //
    // OPENROUTER_REASONING (raw JSON, e.g. '{"effort":"minimal"}' or
    // '{"enabled":false}') injects OpenRouter's `reasoning` body param — the
    // knob that disables thinking on models honouring it (gemini-3.6-flash
    // takes effort:minimal, qwen takes enabled:false).
    //
    // 429 responses (OpenRouter's new-account 10 req/min caps) are absorbed
    // with header-aware backoff instead of surfacing as mid-turn stream
    // deaths. The retry happens BEFORE any stream starts (a 429 arrives in
    // place of the stream), so it is safe for streaming calls; the turn gets
    // slower, never corrupted.
    let reasoningConfig: unknown;
    if (env.OPENROUTER_REASONING) {
      try {
        reasoningConfig = JSON.parse(env.OPENROUTER_REASONING as string);
      } catch {
        throw new Error(
          'OPENROUTER_REASONING must be valid JSON (e.g. {"effort":"minimal"} or {"enabled":false}).',
        );
      }
    }

    // OPENROUTER_REASONING_RETRY: the reasoning config to use on an
    // empty-stream RETRY only. gemini-3.5-flash-lite returns a deterministic
    // empty completion (finish_reason 'error', zero tokens) on a
    // request-correlated slice of requests at effort "minimal" — the same
    // body succeeds at "low" (2026-08-20 captured-body A/B: minimal 6/6
    // empty, low 0/6). Re-issuing at the same effort can never save those, so
    // the retry escalates: the fast path keeps "minimal" TTFT, only the
    // rescue pays for "low".
    let retryReasoningConfig: unknown;
    if (env.OPENROUTER_REASONING_RETRY) {
      try {
        retryReasoningConfig = JSON.parse(env.OPENROUTER_REASONING_RETRY as string);
      } catch {
        throw new Error('OPENROUTER_REASONING_RETRY must be valid JSON (e.g. {"effort":"low"}).');
      }
    }

    // Pending escalations, consumed by the next outbound fetch. A counter
    // rather than per-request plumbing because the AI-SDK fetch hook has no
    // retry context; under concurrency a mis-attributed escalation only makes
    // an unrelated request think harder — safe by design.
    let reasoningEscalations = 0;

    // OPENROUTER_STRICT_TOOLS=1 rewrites every tool's JSON schema into
    // OpenAI's strict shape (gpt-5-family models REJECT tools otherwise:
    // "'required' is required ... including every key in properties").
    // Standard strict recipe: every property listed in `required`,
    // previously-optional properties made nullable, additionalProperties
    // false, strict: true on the function. Typeless union branches (Zod
    // enum-or-passthrough) get a type inferred from enum/const members, else
    // "any" becomes string — the caller's server-side validation stays
    // canonical. Other providers don't need it: env-gated.
    const strictTools = env.OPENROUTER_STRICT_TOOLS === '1';

    const openrouterFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      let nextInit = init;
      if (reasoningConfig || retryReasoningConfig || strictTools) {
        try {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
          let effectiveReasoning = reasoningConfig;
          if (reasoningEscalations > 0 && retryReasoningConfig) {
            reasoningEscalations--;
            effectiveReasoning = retryReasoningConfig;
          }
          if (effectiveReasoning) body.reasoning = effectiveReasoning;
          if (strictTools && Array.isArray(body.tools)) {
            body.tools = body.tools.map((tool: any) =>
              tool?.function?.parameters
                ? {
                    ...tool,
                    function: {
                      ...tool.function,
                      strict: true,
                      parameters: strictify(tool.function.parameters),
                    },
                  }
                : tool,
            );
          }
          nextInit = { ...init, body: JSON.stringify(body) };
        } catch {
          // non-JSON body: forward untouched
        }
      }
      let response = await fetch(url, nextInit);
      for (let attempt = 0; response.status === 429 && attempt < 5; attempt++) {
        const resetAt = Number(response.headers.get('x-ratelimit-reset') ?? 0);
        const waitMs = resetAt > 0 ? Math.min(Math.max(resetAt - Date.now(), 1000), 20000) : 7000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        response = await fetch(url, nextInit);
      }
      return response;
    };

    const openrouter = createOpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey,
      compatibility: 'compatible',
      fetch: openrouterFetch as unknown as typeof fetch,
      ...(headers ? { headers } : {}),
    });

    // OPENROUTER_RETRY_EMPTY='1': the bridge occasionally closes the SSE
    // stream CLEANLY with zero output — no error thrown, the AI SDK
    // synthesises finishReason 'unknown', the turn ends "done" and the caller
    // gets silence with a bare unanswered user turn in memory.
    const base = viaGateway(openrouter.chat(id));
    if (env.OPENROUTER_RETRY_EMPTY === '1') {
      if (!(globalThis as any).__honidevOrRetryLogged) {
        (globalThis as any).__honidevOrRetryLogged = true;
        console.warn('[honidev] openrouter empty-stream retry ACTIVE');
      }
      return withEmptyStreamRetry(base, {
        label: 'openrouter',
        escalated: !!retryReasoningConfig,
        onRetry: () => {
          if (retryReasoningConfig) reasoningEscalations++;
        },
      });
    }
    return base;
  }

  throw new Error(
    `Unsupported model: "${modelId}". Supported prefixes: claude-*, bedrock/*, gpt-*, gemini-*, @cf/*, google/*, anthropic/* (Workers AI partner catalog), openrouter/*, groq/*, deepseek-*, mistral-*, grok-*, sonar*, together/*, command-*, azure/*`,
  );
}
