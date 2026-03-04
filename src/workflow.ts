import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

export interface StepConfig {
  name: string;
  retries?: { limit?: number; delay?: string; backoff?: 'constant' | 'linear' | 'exponential' };
  timeout?: string;
}

export interface WorkflowStepDef<TInput = any, TOutput = any> {
  config: StepConfig;
  handler: (input: TInput, workflowStep: WorkflowStep) => Promise<TOutput>;
}

export interface HoniWorkflowConfig<TEnv = any, TParams = any> {
  steps: WorkflowStepDef[];
  onComplete?: (result: any, env: TEnv) => Promise<void>;
  onError?: (error: Error, env: TEnv) => Promise<void>;
}

export function step<TInput, TOutput>(
  config: StepConfig,
  handler: (input: TInput, step: WorkflowStep) => Promise<TOutput>
): WorkflowStepDef<TInput, TOutput> {
  return { config, handler };
}

export function workflow<TEnv = any, TParams extends Record<string, unknown> = Record<string, unknown>>(
  config: HoniWorkflowConfig<TEnv, TParams>
) {
  // Return a class that can be used as a Cloudflare Workflow entrypoint
  // Use abstract class pattern to avoid needing WorkflowEntrypoint at runtime
  class HoniWorkflow {
    constructor(public ctx: any, public env: TEnv) {}

    async run(event: WorkflowEvent<TParams>, step: WorkflowStep): Promise<void> {
      let lastResult: any = event.payload;
      try {
        for (const stepDef of config.steps) {
          lastResult = await stepDef.handler(lastResult, step);
        }
        if (config.onComplete) {
          await config.onComplete(lastResult, this.env);
        }
      } catch (err) {
        if (config.onError) {
          await config.onError(err as Error, this.env);
        } else {
          throw err;
        }
      }
    }
  }
  return HoniWorkflow as any;
}
