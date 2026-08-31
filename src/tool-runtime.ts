import {
  generateText,
  InvalidToolInputError,
  jsonSchema,
  NoSuchToolError,
  ToolCallRepairError,
  tool as aiTool,
  type LanguageModel,
  type ToolCallRepairFunction,
  type Tool,
} from 'ai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ObservabilityCollector } from './observability.js';
import { normalizeModelSettings } from './types.js';
import type { ToolContext, ToolDefinition } from './types.js';
import type { ModelSettings } from './types.js';

const invalidArguments = Symbol('honi.invalidArguments');

interface InvalidArgumentsMarker {
  [invalidArguments]: true;
  rawArgs: unknown;
  error: import('zod').ZodError;
}

type RuntimeToolSet = Record<string, Tool<any, unknown>>;
type RepairToolCall = Parameters<ToolCallRepairFunction<RuntimeToolSet>>[0]['toolCall'];

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

function emitRepair(
  input: {
    collector?: ObservabilityCollector;
    agentName: string;
    threadId?: string;
  },
  tool: string,
  outcome: 'repaired' | 'handled' | 'failed' | 'no-such-tool',
): void {
  input.collector?.emit({
    type: 'tool.repair',
    agentName: input.agentName,
    threadId: input.threadId,
    timestamp: Date.now(),
    metadata: { tool, attempt: 1, outcome },
  });
}

function stripJsonFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function formatNamedToolError(error: Error & { toolName: string }): string {
  return `${error.name.replace(/^AI_/, '')}:${error.toolName}: ${error.message}`;
}

/**
 * A tool handler failure, annotated with WHICH tool failed.
 *
 * AI SDK 5+ removed its own ToolExecutionError: a handler throw becomes a
 * `tool-error` stream part carrying the raw error, and the UI-stream error
 * formatter receives only `part.error` — no tool name. Without this wrapper
 * every tool failure reaches the client as the anonymous fallback string.
 */
export class ToolExecutionError extends Error {
  readonly toolName: string;

  constructor(options: { toolName: string; cause: unknown }) {
    const reason =
      options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(reason, { cause: options.cause });
    this.name = 'ToolExecutionError';
    this.toolName = options.toolName;
  }

  static isInstance(error: unknown): error is ToolExecutionError {
    return (
      error instanceof Error &&
      error.name === 'ToolExecutionError' &&
      typeof (error as { toolName?: unknown }).toolName === 'string'
    );
  }
}

export function formatToolError(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  let executionError: (Error & { toolName: string }) | undefined;

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);

    if (InvalidToolInputError.isInstance(current) || NoSuchToolError.isInstance(current)) {
      return formatNamedToolError(current);
    }
    if (ToolExecutionError.isInstance(current)) executionError ??= current;
    if (ToolCallRepairError.isInstance(current)) pending.push(current.originalError);
    if (typeof current === 'object' && 'cause' in current) {
      pending.push((current as { cause?: unknown }).cause);
    }
  }

  return executionError ? formatNamedToolError(executionError) : 'An error occurred.';
}

async function executeHandler(
  definition: ToolDefinition,
  args: unknown,
  context: ToolContext,
  collector: ObservabilityCollector | undefined,
  agentName: string,
  threadId: string | undefined,
): Promise<unknown> {
  if (!collector) {
    try {
      return await definition.handler(args, context);
    } catch (error) {
      throw new ToolExecutionError({ toolName: definition.name, cause: error });
    }
  }

  const start = Date.now();
  collector.emit({
    type: 'tool.call',
    agentName,
    threadId,
    timestamp: start,
    metadata: {
      tool: definition.name,
      argumentCount:
        typeof args === 'object' && args !== null && !Array.isArray(args)
          ? Object.keys(args).length
          : 0,
    },
  });
  try {
    const result = await definition.handler(args, context);
    collector.emit({
      type: 'tool.result',
      agentName,
      threadId,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      metadata: { tool: definition.name, outcome: 'completed' },
    });
    return result;
  } catch (error) {
    collector.emit({
      type: 'tool.result',
      agentName,
      threadId,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      metadata: {
        tool: definition.name,
        // The ORIGINAL error's class — the wrapper below is transport, and
        // telemetry consumers group failures by what actually threw.
        outcome: 'failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });
    throw new ToolExecutionError({ toolName: definition.name, cause: error });
  }
}

export function buildToolRuntime(input: {
  definitions: ToolDefinition[];
  context: ToolContext;
  model: LanguageModel;
  modelSettings?: ModelSettings;
  collector?: ObservabilityCollector;
  agentName: string;
  threadId?: string;
}): ToolRuntime {
  const tools: RuntimeToolSet = {};
  const definitions = new Map(input.definitions.map((definition) => [definition.name, definition]));

  const repairToolCall: ToolCallRepairFunction<RuntimeToolSet> = async ({
    toolCall,
    error,
    messages,
    instructions,
    inputSchema,
  }) => {
    if (NoSuchToolError.isInstance(error)) {
      emitRepair(input, error.toolName, 'no-such-tool');
      return null;
    }

    const definition = definitions.get(error.toolName);
    if (!definition) {
      emitRepair(input, error.toolName, 'failed');
      return null;
    }

    try {
      let issues: unknown = [{ message: error.message }];
      try {
        const rawArgs = JSON.parse(error.toolInput);
        const validation = definition.input.safeParse(rawArgs);
        if (!validation.success) issues = validation.error.issues;
      } catch {
        // Malformed JSON has no parsed raw value; retain the SDK error message.
      }

      const instruction = [
        `Your arguments for ${error.toolName} failed validation: ${JSON.stringify(issues)}.`,
        'Return corrected arguments only.',
      ].join(' ');
      const repair = await generateText({
        ...normalizeModelSettings(input.modelSettings),
        model: input.model,
        ...(instructions === undefined ? {} : { instructions }),
        // Step messages can carry a persisted system row when the main call
        // allowed one; the repair call must not choke on the same history.
        allowSystemInMessages: true,
        messages: [
          ...messages,
          {
            role: 'user',
            content: [
              instruction,
              `Failing tool call: ${error.toolName}(${error.toolInput})`,
              `JSON Schema: ${JSON.stringify(await inputSchema({ toolName: error.toolName }))}`,
            ].join('\n'),
          },
        ],
      });
      const rawArgs = JSON.parse(stripJsonFence(repair.text));
      const parsed = definition.input.safeParse(rawArgs);
      if (!parsed.success) {
        emitRepair(input, error.toolName, 'failed');
        return null;
      }

      emitRepair(input, error.toolName, 'repaired');
      return { ...toolCall, input: JSON.stringify(parsed.data) };
    } catch {
      emitRepair(input, error.toolName, 'failed');
      return null;
    }
  };

  for (const definition of input.definitions) {
    const inputSchema = definition.onInvalidArguments
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
      inputSchema,
      execute: async (args: unknown, options) => {
        if (isInvalidArgumentsMarker(args)) {
          const result = await definition.onInvalidArguments!(args.rawArgs, args.error);
          if (result !== null) {
            emitRepair(input, definition.name, 'handled');
            return result;
          }
          const invalidError = new InvalidToolInputError({
            toolName: definition.name,
            toolInput: JSON.stringify(args.rawArgs),
            cause: args.error,
          });
          const repaired = await repairToolCall({
            toolCall: {
              type: 'tool-call',
              toolCallId: options.toolCallId,
              toolName: definition.name,
              input: invalidError.toolInput,
            } as RepairToolCall,
            tools,
            error: invalidError,
            messages: options.messages,
            instructions: undefined,
            system: undefined,
            inputSchema: async () => zodToJsonSchema(definition.input) as import('@ai-sdk/provider').JSONSchema7,
          });
          if (!repaired) throw invalidError;
          const parsed = definition.input.parse(JSON.parse(repaired.input));
          return executeHandler(
            definition,
            parsed,
            input.context,
            input.collector,
            input.agentName,
            input.threadId,
          );
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
    repairToolCall,
  };
}
