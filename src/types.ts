import type { z } from 'zod';
import type { ObservabilityConfig } from './observability.js';
import type { GraphMemory } from './graph.js';

/** Context passed as second argument to tool handlers. */
export interface ToolContext {
  /** Graph memory instance — use to read/write entities from within a tool. */
  graph?: GraphMemory;
  /** Raw Worker env — use sparingly; prefer typed bindings. */
  env?: Record<string, unknown>;
}

export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: T;
  /** Handler receives parsed input and optional context (graph, env). */
  handler: (input: z.infer<T>, ctx?: ToolContext) => Promise<unknown>;
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
  /** Model ID. Supports claude-*, gpt-*, and @cf/* (Workers AI). Workers AI models require an AI binding in wrangler.toml. */
  model: string;
  system?: string;
  memory?: MemoryConfig;
  tools?: ToolDefinition[];
  /** Durable Object binding name in wrangler.toml. Defaults to "AGENT". */
  binding?: string;
  /** Max tool-call loop iterations. Defaults to 10. */
  maxSteps?: number;
  /** Observability configuration (event collection, AI Gateway). */
  observability?: ObservabilityConfig;
  /** MCP server configuration. */
  mcp?: McpConfig;
}
