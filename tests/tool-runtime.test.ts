import { describe, expect, it, mock } from 'bun:test';
import { NoSuchToolError, streamText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ObservabilityCollector } from '../src/observability.js';
import { buildToolRuntime, formatToolError } from '../src/tool-runtime.js';
import { tool } from '../src/tool.js';

const ratingsInput = z.object({
  seniorityBand: z.enum(['IC', 'Team Lead', 'Manager', 'Director+']),
});

const unusedModel = {} as LanguageModel;

type ProviderStreamPart =
  | { type: 'tool-call'; toolCallType: 'function'; toolCallId: string; toolName: string; args: string }
  | { type: 'text-delta'; textDelta: string }
  | {
      type: 'finish';
      finishReason: 'stop' | 'tool-calls';
      usage: { promptTokens: number; completionTokens: number };
    };

function createScriptedModel(input: {
  streams: ProviderStreamPart[][];
  repairs?: string[];
}) {
  const streamCalls: unknown[] = [];
  const generateCalls: unknown[] = [];
  const streams = [...input.streams];
  const repairs = [...(input.repairs ?? [])];
  const model: LanguageModel = {
    specificationVersion: 'v1',
    provider: 'test',
    modelId: 'test-model',
    defaultObjectGenerationMode: undefined,
    doStream: mock(async (options) => {
      streamCalls.push(options);
      const parts = streams.shift();
      if (!parts) throw new Error('No scripted stream remains');
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
        warnings: [],
      };
    }),
    doGenerate: mock(async (options) => {
      generateCalls.push(options);
      const text = repairs.shift();
      if (text === undefined) throw new Error('No scripted repair remains');
      return {
        text,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
        response: { id: 'repair-1', timestamp: new Date(0), modelId: 'test-model' },
        warnings: [],
        providerMetadata: undefined,
      };
    }),
  };
  return { model, streamCalls, generateCalls };
}

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

  it('repairs an off-enum call and completes the tool loop', async () => {
    const scripted = createScriptedModel({
      streams: [
        [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call-1',
            toolName: 'submitRatings',
            args: JSON.stringify({ seniorityBand: 'Senior Manager' }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 1, completionTokens: 1 },
          },
        ],
        [
          { type: 'text-delta', textDelta: 'Your ratings were submitted. Goodbye!' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
          },
        ],
      ],
      repairs: [JSON.stringify({ seniorityBand: 'Manager' })],
    });
    const handled: Array<z.infer<typeof ratingsInput>> = [];
    const collector = new ObservabilityCollector();
    const runtime = buildToolRuntime({
      definitions: [
        tool({
          name: 'submitRatings',
          description: 'Submit final ratings',
          input: ratingsInput,
          handler: async (args) => {
            handled.push(args);
            return { submitted: true };
          },
        }),
      ],
      context: {},
      model: scripted.model,
      collector,
      agentName: 'ratings-agent',
      threadId: 'thread-1',
    });
    const onFinish = mock(async () => {});

    const result = streamText({
      model: scripted.model,
      system: 'You are a ratings agent.',
      messages: [{ role: 'user', content: 'Submit my ratings.' }],
      tools: runtime.tools,
      maxSteps: 3,
      experimental_repairToolCall: runtime.repairToolCall,
      onFinish,
    });
    const responseBody = await result.toDataStreamResponse().text();

    expect(responseBody).toContain('Your ratings were submitted. Goodbye!');
    expect(handled).toEqual([{ seniorityBand: 'Manager' }]);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(scripted.generateCalls).toHaveLength(1);
    expect(JSON.stringify(scripted.generateCalls[0])).toContain('submitRatings');
    expect(JSON.stringify(scripted.generateCalls[0])).toContain('Senior Manager');
    expect(JSON.stringify(scripted.generateCalls[0])).toContain('invalid_enum_value');
    expect(JSON.stringify(scripted.generateCalls[0])).toContain('Return corrected arguments only');
    expect(collector.getEvents().filter((event) => event.type === 'tool.repair')).toEqual([
      {
        type: 'tool.repair',
        agentName: 'ratings-agent',
        threadId: 'thread-1',
        timestamp: expect.any(Number),
        metadata: {
          tool: 'submitRatings',
          attempt: 1,
          outcome: 'repaired',
        },
      },
    ]);
  });

  it('repairs after the invalid-argument hook declines', async () => {
    const scripted = createScriptedModel({
      streams: [],
      repairs: [JSON.stringify({ seniorityBand: 'Team Lead' })],
    });
    const rawArgs = { seniorityBand: 'Senior Manager' };
    const observed: unknown[] = [];
    const handled: unknown[] = [];
    const collector = new ObservabilityCollector();
    const runtime = buildToolRuntime({
      definitions: [
        tool({
          name: 'submitRatings',
          description: 'Submit final ratings',
          input: ratingsInput,
          handler: async (args) => {
            handled.push(args);
            return { submitted: true };
          },
          onInvalidArguments: async (received, error) => {
            observed.push(received, error);
            return null;
          },
        }),
      ],
      context: {},
      model: scripted.model,
      collector,
      agentName: 'ratings-agent',
      threadId: 'thread-1',
    });
    const aiTool = runtime.tools.submitRatings;
    const markedArgs = validationValue(aiTool.parameters, rawArgs);

    const result = await aiTool.execute?.(markedArgs, {
      toolCallId: 'call-1',
      messages: [{ role: 'user', content: 'Submit my ratings.' }],
    });

    expect(result).toEqual({ submitted: true });
    expect(observed[0]).toBe(rawArgs);
    expect(observed[1]).toBeInstanceOf(z.ZodError);
    expect(handled).toEqual([{ seniorityBand: 'Team Lead' }]);
    expect(scripted.generateCalls).toHaveLength(1);
    expect(
      collector.getEvents().filter((event) => event.type === 'tool.repair')[0]?.metadata,
    ).toEqual({ tool: 'submitRatings', attempt: 1, outcome: 'repaired' });
  });

  it('enriches the fatal error frame when repair still fails validation', async () => {
    const scripted = createScriptedModel({
      streams: [
        [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call-1',
            toolName: 'submitRatings',
            args: JSON.stringify({ seniorityBand: 'Senior Manager' }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 1, completionTokens: 1 },
          },
        ],
      ],
      repairs: [JSON.stringify({ seniorityBand: 'Senior Manager' })],
    });
    const handler = mock(async () => ({ submitted: true }));
    const onFinish = mock(async () => {});
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
      model: scripted.model,
      collector,
      agentName: 'ratings-agent',
      threadId: 'thread-1',
    });
    const result = streamText({
      model: scripted.model,
      messages: [{ role: 'user', content: 'Submit my ratings.' }],
      tools: runtime.tools,
      maxSteps: 3,
      experimental_repairToolCall: runtime.repairToolCall,
      onFinish,
    });

    const responseBody = await result
      .toDataStreamResponse({ getErrorMessage: formatToolError })
      .text();

    expect(responseBody).toContain('3:"InvalidToolArgumentsError:submitRatings:');
    expect(handler).not.toHaveBeenCalled();
    expect(
      collector.getEvents().filter((event) => event.type === 'tool.repair')[0]?.metadata,
    ).toEqual({ tool: 'submitRatings', attempt: 1, outcome: 'failed' });
  });

  it('does not ask the model to repair an unavailable tool', async () => {
    const scripted = createScriptedModel({ streams: [], repairs: ['unused'] });
    const collector = new ObservabilityCollector();
    const runtime = buildToolRuntime({
      definitions: [],
      context: {},
      model: scripted.model,
      collector,
      agentName: 'ratings-agent',
    });

    const result = await runtime.repairToolCall({
      toolCall: {
        toolCallType: 'function',
        toolCallId: 'call-1',
        toolName: 'missingTool',
        args: '{}',
      },
      tools: runtime.tools,
      error: new NoSuchToolError({ toolName: 'missingTool' }),
      messages: [],
      system: undefined,
      parameterSchema: () => ({}),
    });

    expect(result).toBeNull();
    expect(scripted.generateCalls).toHaveLength(0);
    expect(collector.getEvents()[0]?.metadata).toEqual({
      tool: 'missingTool',
      attempt: 1,
      outcome: 'no-such-tool',
    });
  });

  it('leaves valid stream calls unchanged', async () => {
    const scripted = createScriptedModel({
      streams: [
        [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call-1',
            toolName: 'submitRatings',
            args: JSON.stringify({ seniorityBand: 'Director+' }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { promptTokens: 1, completionTokens: 1 },
          },
        ],
        [
          { type: 'text-delta', textDelta: 'Submitted.' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
          },
        ],
      ],
    });
    const handled: unknown[] = [];
    const collector = new ObservabilityCollector();
    const runtime = buildToolRuntime({
      definitions: [
        tool({
          name: 'submitRatings',
          description: 'Submit final ratings',
          input: ratingsInput,
          handler: async (args) => {
            handled.push(args);
            return { submitted: true };
          },
        }),
      ],
      context: {},
      model: scripted.model,
      collector,
      agentName: 'ratings-agent',
    });
    const onFinish = mock(async () => {});
    const result = streamText({
      model: scripted.model,
      system: 'You are a ratings agent.',
      messages: [{ role: 'user', content: 'Submit my ratings.' }],
      tools: runtime.tools,
      maxSteps: 3,
      experimental_repairToolCall: runtime.repairToolCall,
      onFinish,
    });

    const responseBody = await result.toDataStreamResponse().text();

    expect(responseBody).toContain('Submitted.');
    expect(handled).toEqual([{ seniorityBand: 'Director+' }]);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(scripted.generateCalls).toHaveLength(0);
    expect(collector.getEvents().some((event) => event.type === 'tool.repair')).toBe(false);
  });
});
