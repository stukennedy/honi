import type { z } from 'zod';

export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: T;
  handler: (input: z.infer<T>) => Promise<unknown>;
}

export interface MemoryConfig {
  enabled: boolean;
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
}
