import { describe, expect, it, mock } from 'bun:test';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ObservabilityCollector } from '../src/observability.js';
import { buildToolRuntime } from '../src/tool-runtime.js';
import { tool } from '../src/tool.js';

const ratingsInput = z.object({
  seniorityBand: z.enum(['IC', 'Team Lead', 'Manager', 'Director+']),
});

const unusedModel = {} as LanguageModel;

function validationValue(parameters: unknown, value: unknown): unknown {
  const result = (parameters as {
    validate: (input: unknown) => { success: boolean; value?: unknown; error?: Error };
  }).validate(value);
  if (!result.success) throw result.error;
  return result.value;
}

describe('buildToolRuntime()', () => {
  it('keeps the original JSON Schema for locally handled tools', () => {
    const definition = tool({
      name: 'submitRatings',
      description: 'Submit final ratings',
      input: ratingsInput,
      handler: async () => 'submitted',
      onInvalidArguments: async () => ({ correction: 'Choose a listed band.' }),
    });
    const runtime = buildToolRuntime({
      definitions: [definition],
      context: {},
      model: unusedModel,
      agentName: 'ratings-agent',
    });

    expect((runtime.tools.submitRatings.parameters as { jsonSchema: unknown }).jsonSchema).toEqual(
      zodToJsonSchema(ratingsInput),
    );
  });

  it('executes valid calls through the original handler and events', async () => {
    const handler = mock(async ({ seniorityBand }: z.infer<typeof ratingsInput>) => ({
      submitted: seniorityBand,
    }));
    const collector = new ObservabilityCollector();
    const runtime = buildToolRuntime({
      definitions: [
        tool({
          name: 'submitRatings',
          description: 'Submit final ratings',
          input: ratingsInput,
          handler,
        }),
      ],
      context: {},
      model: unusedModel,
      collector,
      agentName: 'ratings-agent',
      threadId: 'thread-1',
    });

    const result = await runtime.tools.submitRatings.execute?.(
      { seniorityBand: 'Manager' },
      { toolCallId: 'call-1', messages: [] },
    );

    expect(result).toEqual({ submitted: 'Manager' });
    expect(handler).toHaveBeenCalledWith({ seniorityBand: 'Manager' }, {});
    expect(collector.getEvents().map((event) => event.type)).toEqual([
      'tool.call',
      'tool.result',
    ]);
  });

  it('turns a local invalid-argument response into the tool result', async () => {
    const rawArgs = { seniorityBand: 'Senior Manager' };
    const handler = mock(async () => 'should not run');
    const onInvalidArguments = mock(async (received: unknown, error: z.ZodError) => ({
      correction: 'Choose IC, Team Lead, Manager, or Director+.',
      received,
      issue: error.issues[0]?.code,
    }));
    const collector = new ObservabilityCollector();
    const runtime = buildToolRuntime({
      definitions: [
        tool({
          name: 'submitRatings',
          description: 'Submit final ratings',
          input: ratingsInput,
          handler,
          onInvalidArguments,
        }),
      ],
      context: {},
      model: unusedModel,
      collector,
      agentName: 'ratings-agent',
      threadId: 'thread-1',
    });
    const aiTool = runtime.tools.submitRatings;
    const markedArgs = validationValue(aiTool.parameters, rawArgs);

    const result = await aiTool.execute?.(markedArgs, {
      toolCallId: 'call-1',
      messages: [],
    });

    expect(result).toEqual({
      correction: 'Choose IC, Team Lead, Manager, or Director+.',
      received: rawArgs,
      issue: 'invalid_enum_value',
    });
    expect(onInvalidArguments).toHaveBeenCalledTimes(1);
    expect(onInvalidArguments.mock.calls[0]?.[0]).toBe(rawArgs);
    expect(onInvalidArguments.mock.calls[0]?.[1]).toBeInstanceOf(z.ZodError);
    expect(handler).not.toHaveBeenCalled();
    expect(collector.getEvents()).toEqual([
      {
        type: 'tool.repair',
        agentName: 'ratings-agent',
        threadId: 'thread-1',
        timestamp: expect.any(Number),
        metadata: {
          tool: 'submitRatings',
          attempt: 1,
          outcome: 'handled',
        },
      },
    ]);
  });
});
