import { describe, expect, it } from 'bun:test';
import { step, workflow } from '../src/workflow.js';

describe('step()', () => {
  it('creates a WorkflowStepDef with config and handler', () => {
    const s = step(
      { name: 'parse-input' },
      async (input: string) => input.toUpperCase(),
    );

    expect(s.config.name).toBe('parse-input');
    expect(typeof s.handler).toBe('function');
  });

  it('supports retry config', () => {
    const s = step(
      { name: 'retry-step', retries: { limit: 3, backoff: 'exponential' }, timeout: '30s' },
      async (input: any) => input,
    );

    expect(s.config.retries?.limit).toBe(3);
    expect(s.config.retries?.backoff).toBe('exponential');
    expect(s.config.timeout).toBe('30s');
  });
});

describe('workflow()', () => {
  it('returns a class with run method', () => {
    const MyWorkflow = workflow({
      steps: [
        step({ name: 'step1' }, async (input: any) => input),
      ],
    });

    const instance = new MyWorkflow({}, {});
    expect(typeof instance.run).toBe('function');
  });

  it('executes steps sequentially passing results through', async () => {
    const results: string[] = [];

    const MyWorkflow = workflow({
      steps: [
        step({ name: 'step1' }, async (input: { value: number }) => {
          results.push('step1');
          return { value: input.value * 2 };
        }),
        step({ name: 'step2' }, async (input: { value: number }) => {
          results.push('step2');
          return { value: input.value + 1 };
        }),
      ],
    });

    const instance = new MyWorkflow({}, {});
    // Mock WorkflowEvent and WorkflowStep
    const mockEvent = { payload: { value: 5 }, timestamp: new Date() };
    const mockStep = {} as any;

    await instance.run(mockEvent, mockStep);
    expect(results).toEqual(['step1', 'step2']);
  });

  it('calls onComplete with final result', async () => {
    let completedWith: any = null;

    const MyWorkflow = workflow({
      steps: [
        step({ name: 'double' }, async (input: { n: number }) => ({ n: input.n * 2 })),
      ],
      onComplete: async (result) => {
        completedWith = result;
      },
    });

    const instance = new MyWorkflow({}, {});
    await instance.run({ payload: { n: 10 }, timestamp: new Date() } as any, {} as any);
    expect(completedWith).toEqual({ n: 20 });
  });

  it('calls onError when a step throws', async () => {
    let caughtError: Error | null = null;

    const MyWorkflow = workflow({
      steps: [
        step({ name: 'fail' }, async () => {
          throw new Error('step failed');
        }),
      ],
      onError: async (err) => {
        caughtError = err;
      },
    });

    const instance = new MyWorkflow({}, {});
    await instance.run({ payload: {}, timestamp: new Date() } as any, {} as any);
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe('step failed');
  });

  it('rethrows error if no onError handler', async () => {
    const MyWorkflow = workflow({
      steps: [
        step({ name: 'fail' }, async () => {
          throw new Error('unhandled');
        }),
      ],
    });

    const instance = new MyWorkflow({}, {});
    await expect(
      instance.run({ payload: {}, timestamp: new Date() } as any, {} as any),
    ).rejects.toThrow('unhandled');
  });
});
