import { describe, expect, it, mock } from 'bun:test';
import {
  createUIMessageStreamResponse,
  isStepCount,
  NoSuchToolError,
  streamText,
  toUIMessageStream,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ObservabilityCollector } from '../src/observability.js';
import { buildToolRuntime, formatToolError } from '../src/tool-runtime.js';
import { tool } from '../src/tool.js';

const ratingsInput = z.object({
  seniorityBand: z.enum(['IC', 'Team Lead', 'Manager', 'Director+']),
});

const unusedModel = {} as LanguageModel;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type ProviderStreamPart =
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: string;
    }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | {
      type: 'finish';
      finishReason: { unified: 'stop' | 'tool-calls'; raw: string };
      usage: typeof usage;
    };

function createScriptedModel(input: { streams: ProviderStreamPart[][]; repairs?: string[] }) {
  const streamCalls: unknown[] = [];
  const generateCalls: unknown[] = [];
  const streams = [...input.streams];
  const repairs = [...(input.repairs ?? [])];
  const model = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    doStream: mock(async (options: { prompt: unknown }) => {
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
      };
    }),
    doGenerate: mock(async (options: { prompt: unknown }) => {
      generateCalls.push(options);
      const text = repairs.shift();
      if (text === undefined) throw new Error('No scripted repair remains');
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage,
        warnings: [],
      };
    }),
  } as unknown as LanguageModel;
  return { model, streamCalls, generateCalls };
}

/** Text of a step: the start/delta/end triple the v4 spec requires. */
function textParts(text: string): ProviderStreamPart[] {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
  ];
}

async function uiStreamText(result: { stream: ReadableStream }, withErrors = false): Promise<string> {
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream as never,
      ...(withErrors ? { onError: formatToolError } : {}),
    }),
  }).text();
}

function validationValue(schema: unknown, value: unknown): unknown {
  const result = (
    schema as {
      validate: (input: unknown) => {
        success: boolean;
        value?: unknown;
        error?: Error;
      };
    }
  ).validate(value);
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

    expect((runtime.tools.submitRatings.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual(
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
      { toolCallId: 'call-1', messages: [], context: undefined },
    );

    expect(result).toEqual({ submitted: 'Manager' });
    expect(handler).toHaveBeenCalledWith({ seniorityBand: 'Manager' }, {});
    expect(collector.getEvents().map((event) => event.type)).toEqual(['tool.call', 'tool.result']);
    expect(collector.getEvents()[0]?.metadata).toEqual({
      tool: 'submitRatings',
      argumentCount: 1,
    });
  });

  it('records failed tools without exposing arguments or raw error messages', async () => {
    const collector = new ObservabilityCollector();
    const runtime = buildToolRuntime({
      definitions: [
        tool({
          name: 'submitRatings',
          description: 'Submit final ratings',
          input: ratingsInput,
          handler: async () => {
            throw new RangeError('private learner evidence');
          },
        }),
      ],
      context: {},
      model: unusedModel,
      collector,
      agentName: 'ratings-agent',
      threadId: 'thread-1',
    });

    await expect(
      runtime.tools.submitRatings.execute?.(
        { seniorityBand: 'Manager' },
        { toolCallId: 'call-1', messages: [], context: undefined },
      ),
    ).rejects.toThrow('private learner evidence');

    const events = collector.getEvents();
    expect(events[0]?.metadata).toEqual({
      tool: 'submitRatings',
      argumentCount: 1,
    });
    expect(events[1]).toMatchObject({
      type: 'tool.result',
      metadata: {
        tool: 'submitRatings',
        outcome: 'failed',
        errorType: 'RangeError',
      },
    });
    expect(events[1]?.error).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('private learner evidence');
    expect(JSON.stringify(events)).not.toContain('Manager');
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
    const markedArgs = validationValue(aiTool.inputSchema, rawArgs);

    const result = await aiTool.execute?.(markedArgs, {
      toolCallId: 'call-1',
      messages: [],
      context: undefined,
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
            toolCallId: 'call-1',
            toolName: 'submitRatings',
            input: JSON.stringify({ seniorityBand: 'Senior Manager' }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
          },
        ],
        [
          ...textParts('Your ratings were submitted. Goodbye!'),
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage,
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
      modelSettings: {
        maxOutputTokens: 128,
        providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
      },
      collector,
      agentName: 'ratings-agent',
      threadId: 'thread-1',
    });
    const onEnd = mock(async () => {});

    const result = streamText({
      model: scripted.model,
      instructions: 'You are a ratings agent.',
      messages: [{ role: 'user', content: 'Submit my ratings.' }],
      tools: runtime.tools,
      stopWhen: isStepCount(3),
      repairToolCall: runtime.repairToolCall,
      onEnd,
    });
    const responseBody = await uiStreamText(result);

    expect(responseBody).toContain('Your ratings were submitted. Goodbye!');
    expect(handled).toEqual([{ seniorityBand: 'Manager' }]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(scripted.generateCalls).toHaveLength(1);
    expect(scripted.generateCalls[0]).toMatchObject({
      maxOutputTokens: 128,
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
    });
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
    const markedArgs = validationValue(aiTool.inputSchema, rawArgs);

    const result = await aiTool.execute?.(markedArgs, {
      toolCallId: 'call-1',
      messages: [{ role: 'user', content: 'Submit my ratings.' }],
      context: undefined,
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
            toolCallId: 'call-1',
            toolName: 'submitRatings',
            input: JSON.stringify({ seniorityBand: 'Senior Manager' }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
          },
        ],
      ],
      repairs: [JSON.stringify({ seniorityBand: 'Senior Manager' })],
    });
    const handler = mock(async () => ({ submitted: true }));
    const onEnd = mock(async () => {});
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
      stopWhen: isStepCount(3),
      repairToolCall: runtime.repairToolCall,
      onEnd,
    });

    const responseBody = await uiStreamText(result, true);

    expect(responseBody).toContain('InvalidToolInputError:submitRatings:');
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
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'missingTool',
        input: '{}',
      },
      tools: runtime.tools,
      error: new NoSuchToolError({ toolName: 'missingTool' }),
      messages: [],
      instructions: undefined,
      system: undefined,
      inputSchema: async () => ({}),
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
            toolCallId: 'call-1',
            toolName: 'submitRatings',
            input: JSON.stringify({ seniorityBand: 'Director+' }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
          },
        ],
        [
          ...textParts('Submitted.'),
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage,
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
    const onEnd = mock(async () => {});
    const result = streamText({
      model: scripted.model,
      instructions: 'You are a ratings agent.',
      messages: [{ role: 'user', content: 'Submit my ratings.' }],
      tools: runtime.tools,
      stopWhen: isStepCount(3),
      repairToolCall: runtime.repairToolCall,
      onEnd,
    });

    const responseBody = await uiStreamText(result);

    expect(responseBody).toContain('Submitted.');
    expect(handled).toEqual([{ seniorityBand: 'Director+' }]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(scripted.generateCalls).toHaveLength(0);
    expect(collector.getEvents().some((event) => event.type === 'tool.repair')).toBe(false);
  });
});
