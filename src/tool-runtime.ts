import {
  InvalidToolArgumentsError,
  jsonSchema,
  tool as aiTool,
  type LanguageModel,
  type Tool,
  type ToolCallRepairFunction,
} from 'ai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ObservabilityCollector } from './observability.js';
import type { ToolContext, ToolDefinition } from './types.js';

const invalidArguments = Symbol('honi.invalidArguments');

interface InvalidArgumentsMarker {
  [invalidArguments]: true;
  rawArgs: unknown;
  error: import('zod').ZodError;
}

type RuntimeToolSet = Record<string, Tool<any, unknown>>;

export interface ToolRuntime {
  tools: RuntimeToolSet;
  repairToolCall: ToolCallRepairFunction<RuntimeToolSet>;
}

function isInvalidArgumentsMarker(value: unknown): value is InvalidArgumentsMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    invalidArguments in value &&
    (value as InvalidArgumentsMarker)[invalidArguments] === true
  );
}

async function executeHandler(
  definition: ToolDefinition,
  args: unknown,
  context: ToolContext,
  collector: ObservabilityCollector | undefined,
  agentName: string,
  threadId: string | undefined,
): Promise<unknown> {
  if (!collector) return definition.handler(args, context);

  const start = Date.now();
  collector.emit({
    type: 'tool.call',
    agentName,
    threadId,
    timestamp: start,
    metadata: { tool: definition.name, args },
  });
  try {
    const result = await definition.handler(args, context);
    collector.emit({
      type: 'tool.result',
      agentName,
      threadId,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      metadata: { tool: definition.name },
    });
    return result;
  } catch (error) {
    collector.emit({
      type: 'tool.result',
      agentName,
      threadId,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      metadata: { tool: definition.name },
      error: (error as Error).message,
    });
    throw error;
  }
}

export function buildToolRuntime(input: {
  definitions: ToolDefinition[];
  context: ToolContext;
  model: LanguageModel;
  collector?: ObservabilityCollector;
  agentName: string;
  threadId?: string;
}): ToolRuntime {
  const tools: RuntimeToolSet = {};

  for (const definition of input.definitions) {
    const parameters = definition.onInvalidArguments
      ? jsonSchema(zodToJsonSchema(definition.input), {
          validate: (value) => {
            const result = definition.input.safeParse(value);
            return result.success
              ? { success: true as const, value: result.data }
              : {
                  success: true as const,
                  value: {
                    [invalidArguments]: true as const,
                    rawArgs: value,
                    error: result.error,
                  },
                };
          },
        })
      : definition.input;

    tools[definition.name] = aiTool({
      description: definition.description,
      parameters,
      execute: async (args) => {
        if (isInvalidArgumentsMarker(args)) {
          const result = await definition.onInvalidArguments!(args.rawArgs, args.error);
          if (result !== null) {
            input.collector?.emit({
              type: 'tool.repair',
              agentName: input.agentName,
              threadId: input.threadId,
              timestamp: Date.now(),
              metadata: {
                tool: definition.name,
                attempt: 1,
                outcome: 'handled',
              },
            });
            return result;
          }
          throw new InvalidToolArgumentsError({
            toolName: definition.name,
            toolArgs: JSON.stringify(args.rawArgs),
            cause: args.error,
          });
        }
        return executeHandler(
          definition,
          args,
          input.context,
          input.collector,
          input.agentName,
          input.threadId,
        );
      },
    });
  }

  return {
    tools,
    repairToolCall: async () => null,
  };
}
