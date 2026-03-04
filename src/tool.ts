import type { z } from 'zod';
import type { ToolDefinition } from './types.js';

export function tool<T extends z.ZodType>(config: {
  name: string;
  description: string;
  input: T;
  handler: (input: z.infer<T>) => Promise<unknown>;
}): ToolDefinition<T> {
  return config;
}
