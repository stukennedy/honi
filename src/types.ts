import type { z } from 'zod';
import type { ObservabilityConfig } from './observability.js';

export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: T;
  handler: (input: z.infer<T>) => Promise<unknown>;
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

export interface MemoryConfig {
  /** Enable DO-based working memory. */
  enabled?: boolean;
  /** D1-backed episodic memory (durable conversation history). */
  episodic?: EpisodicConfig;
  /** Vectorize-backed semantic memory (similarity search). */
  semantic?: SemanticConfig;
}

export interface AgentConfig {
  name: string;
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
}
