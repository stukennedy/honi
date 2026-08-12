import type { z } from 'zod';
import type { ObservabilityConfig } from './observability.js';
import type { AiGatewayConfig } from './providers.js';
import type { GraphMemory } from './graph.js';
import type { RecursiveMemory } from './recursive.js';

/** Context passed as second argument to tool handlers. */
export interface ToolContext {
  /** Graph memory instance — use to read/write entities from within a tool. */
  graph?: GraphMemory;
  /** Recursive (RLM) memory instance — load documents and run the REPL loop. */
  recursive?: RecursiveMemory;
  /** Raw Worker env — use sparingly; prefer typed bindings. */
  env?: Record<string, unknown>;
}

export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: T;
  /** Handler receives parsed input and optional context (graph, env). */
  handler: (input: z.infer<T>, ctx?: ToolContext) => Promise<unknown>;
  /** Convert invalid model arguments into a tool result, or return null to use default repair. */
  onInvalidArguments?: (
    rawArgs: unknown,
    zodError: z.ZodError,
  ) => unknown | Promise<unknown>;
}

export interface EpisodicConfig {
  enabled: boolean;
  /** D1Database binding name in wrangler.toml. Defaults to "DB". */
  binding?: string;
  /** Number of messages to load from D1. Defaults to 50. */
  limit?: number;
}

export interface SemanticConfig {
  enabled: boolean;
  /** VectorizeIndex binding name in wrangler.toml. Defaults to "VECTORIZE". */
  binding?: string;
  /** AI binding name in wrangler.toml. Defaults to "AI". */
  aiBinding?: string;
  /** Number of semantic results to inject. Defaults to 3. */
  topK?: number;
}

export interface GraphConfig {
  enabled: boolean;
  /**
   * Graph identifier — maps to one edgraph DO instance.
   * Use a stable, descriptive name e.g. "support-knowledge-base".
   */
  graphId: string;
  /**
   * CF service binding name for zero-latency DO-to-DO calls.
   * Requires a [[services]] entry in wrangler.jsonc pointing at your edgraph worker.
   * Preferred over url when both agents are in the same CF account.
   */
  binding?: string;
  /**
   * Environment variable name whose value is the edgraph worker URL.
   * Used when edgraph is in a different account or deployed externally.
   */
  urlEnvVar?: string;
  /**
   * Environment variable name whose value is the edgraph API key.
   * Required for write operations (upsertNode, upsertEdge, deleteNode, deleteEdge).
   */
  apiKeyEnvVar?: string;
  /**
   * Depth for graph context expansion during retrieval.
   * Higher = more context, more tokens. Defaults to 1.
   */
  contextDepth?: number;
  /**
   * Max entity IDs to expand during context generation.
   * Guards against very large context blocks. Defaults to 5.
   */
  maxContextEntities?: number;
}

export interface RecursiveConfig {
  enabled: boolean;
  /**
   * Max REPL iterations (tool-call rounds) before the loop terminates.
   * Each iteration is one LLM call. Defaults to 10.
   * Use 5 for voice (latency-sensitive), 10-15 for email/batch.
   */
  maxDepth?: number;
  /**
   * Timeout in milliseconds for the full REPL loop.
   * Defaults to 30000 (30s) — suitable for email.
   * Use 5000 for voice agents.
   */
  timeoutMs?: number;
  /**
   * Character size of each document chunk stored in DO.
   * Smaller = more granular search, more chunks.
   * Defaults to 800.
   */
  chunkSize?: number;
}

export interface MemoryConfig {
  /** Enable DO-based working memory. */
  enabled?: boolean;
  /** D1-backed episodic memory (durable conversation history). */
  episodic?: EpisodicConfig;
  /** Vectorize-backed semantic memory (similarity search). */
  semantic?: SemanticConfig;
  /**
   * edgraph-backed graph memory (entity/relationship knowledge base).
   * Enables structural recall: who knows who, what relates to what.
   * Graph context is automatically injected alongside semantic results.
   */
  graph?: GraphConfig;
  /**
   * Recursive memory — RLM (Recursive Language Model) tier.
   * Documents are chunked and stored in DO storage. The model iteratively
   * queries them via a REPL loop (search → read_chunks → reason → repeat)
   * rather than one-shot RAG retrieval. Dramatically better at cross-references,
   * structured data, and multi-hop reasoning.
   *
   * Load documents via `ctx.recursive.loadDocument(id, content)` from a tool,
   * or call `agent.recursive.loadDocument()` from your Worker on startup.
   */
  recursive?: RecursiveConfig;
}

export interface McpConfig {
  /**
   * Environment variable name containing the Bearer secret for remote MCP connections.
   * Clients must send `Authorization: Bearer <secret>` on every request.
   * If not set, /mcp is unauthenticated — fine for local Claude Desktop (stdio),
   * but don't expose it publicly without this.
   */
  secretEnvVar?: string;
}

export interface AgentConfig {
  name: string;
  /**
   * Model ID. Supports claude-*, gpt-*, gemini-*, @cf/* (Workers AI), and more.
   * Workers AI models run on the AI binding in wrangler.toml — no API key needed.
   */
  model: string;
  /**
   * AI SDK generation controls passed to every model step. `providerOptions`
   * is the provider-owned escape hatch for capabilities such as Anthropic
   * thinking, Gemini thinking budgets, and OpenAI reasoning effort.
   */
  modelSettings?: ModelSettings;
  system?: string;
  memory?: MemoryConfig;
  tools?: ToolDefinition[];
  /** Durable Object binding name in wrangler.toml. Defaults to "AGENT". */
  binding?: string;
  /** Max tool-call loop iterations. Defaults to 10. */
  maxSteps?: number;
  /**
   * Route all LLM calls through Cloudflare AI Gateway.
   * With BYOK keys stored in the gateway (or Unified Billing), no provider
   * API keys are needed in the Worker. Authenticates via the AI binding when
   * available, else via a `cf-aig-authorization` token.
   */
  aiGateway?: AiGatewayConfig;
  /**
   * Extra headers sent on every LLM request, for providers that accept them
   * (claude-*, bedrock/*, gpt-*, gemini-*). For AI Gateway options (caching,
   * `collectLog`, metadata) use `aiGateway.options` instead — those work on
   * the binding path too, where there is no URL to attach headers to.
   */
  providerHeaders?: Record<string, string>;
  /** Observability configuration (event collection, AI Gateway). */
  observability?: ObservabilityConfig;
  /** MCP server configuration. */
  mcp?: McpConfig;
  /**
   * Anthropic prompt caching. A large system prompt re-prefilled on every turn
   * is usually the dominant term in an agent's time-to-first-token; caching it
   * turns that into a cache read.
   *
   * Opt-in, because enabling it changes how the prompt is assembled: the
   * Anthropic provider reads cache control off a MESSAGE, and a top-level
   * `system` string carries no `providerOptions`, so the system prompt has to
   * move into `messages` to be markable at all. With `cache` unset the prompt
   * is assembled exactly as before.
   *
   * `true` enables both breakpoints. Anthropic ignores cache control below a
   * minimum cacheable prefix (1024 tokens for Opus/Sonnet, 2048 for Haiku) —
   * silently, with no error — so a small-prompt agent will see no effect.
   */
  cache?: boolean | CacheConfig;
}

export type ModelSettingJson =
  | null
  | string
  | number
  | boolean
  | ModelSettingJson[]
  | { [key: string]: ModelSettingJson };

export interface ModelSettings {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  maxRetries?: number;
  /** Provider namespace → options, passed through without interpretation. */
  providerOptions?: Record<string, Record<string, ModelSettingJson>>;
}

export interface CacheConfig {
  /**
   * Cache the system prompt. Anthropic serialises `tools` BEFORE `system`, so
   * this one breakpoint covers the tool schemas too — and both are byte-stable
   * across every turn of every thread, which is what makes it the big win.
   * Defaults to true when `cache` is set.
   */
  system?: boolean;
  /**
   * Also cache the conversation prefix, re-anchored every turn: a turn reads
   * the cache the previous turn wrote and writes one covering itself, so a
   * growing thread stays roughly O(1) to prefill instead of O(n).
   * Defaults to true when `cache` is set.
   */
  history?: boolean;
}
