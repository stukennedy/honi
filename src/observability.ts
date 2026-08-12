import type { AiGatewayConfig } from './providers.js';

export interface ObservabilityConfig {
  /** @deprecated Set `aiGateway` at the top level of `createAgent()` config instead. */
  aiGateway?: AiGatewayConfig & { accountId: string };
  logLevel?: 'none' | 'error' | 'warn' | 'info' | 'debug';
  /**
   * Retain emitted events for `getEvents()`. Disable this for long-lived agent
   * isolates that export every event through `onEvent`, avoiding an unbounded
   * in-memory history. Defaults to true for backwards compatibility.
   */
  captureEvents?: boolean;
  onEvent?: (event: HoniEvent) => void | Promise<void>;
}

export type HoniEventType =
  | 'agent.request'
  | 'agent.response'
  | 'agent.phase'
  | 'agent.stream.first_chunk'
  | 'agent.step'
  | 'agent.turn.complete'
  | 'tool.call'
  | 'tool.repair'
  | 'tool.result'
  | 'memory.load'
  | 'memory.save'
  | 'workflow.start'
  | 'workflow.step'
  | 'workflow.complete'
  | 'workflow.error';

export interface HoniEvent {
  type: HoniEventType;
  agentName: string;
  threadId?: string;
  timestamp: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

type PhaseEvent = Omit<HoniEvent, 'timestamp' | 'durationMs' | 'error'>;

export class ObservabilityCollector {
  private events: HoniEvent[] = [];

  constructor(
    private config: ObservabilityConfig = {},
    private waitUntil?: (task: Promise<unknown>) => void,
  ) {}

  emit(event: HoniEvent): void {
    if (this.config.captureEvents !== false) this.events.push(event);
    try {
      const task = this.config.onEvent?.(event);
      if (task && typeof task.then === 'function') {
        const safeTask = Promise.resolve(task).catch(() => undefined);
        if (this.waitUntil) this.waitUntil(safeTask);
        else void safeTask;
      }
    } catch {
      // Observability is best-effort and must never alter an agent turn.
    }
    if (this.config.logLevel === 'debug') {
      console.log(`[honi:${event.type}]`, JSON.stringify(event));
    }
  }

  getEvents(): HoniEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }

  /**
   * @deprecated Gateway routing now happens in resolveModel() via the `gateway` option.
   *
   * Note the trailing `/v1`: this URL's one historical use was as an AI SDK
   * `baseURL`, and both the Anthropic and OpenAI providers treat baseURL as
   * already containing the version segment (they append only `/messages` /
   * `/chat/completions`). Without it, every request 404s at the gateway.
   */
  getAiGatewayUrl(provider: 'anthropic' | 'openai'): string | undefined {
    if (!this.config.aiGateway) return undefined;
    const { accountId, gatewayId } = this.config.aiGateway;
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}/v1`;
  }
}

/**
 * Time one agent phase and emit its terminal outcome without recording the
 * operation's inputs, outputs, or error message. Agent consumers frequently
 * handle learner content, so phase telemetry is deliberately metadata-only.
 */
export async function measurePhase<T>(
  collector: ObservabilityCollector | undefined,
  event: PhaseEvent,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    collector?.emit({
      ...event,
      timestamp: startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      metadata: { ...event.metadata, outcome: 'completed' },
    });
    return result;
  } catch (error) {
    collector?.emit({
      ...event,
      timestamp: startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      metadata: {
        ...event.metadata,
        outcome: 'failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });
    throw error;
  }
}

export function createObservability(config: ObservabilityConfig = {}): ObservabilityCollector {
  return new ObservabilityCollector(config);
}
