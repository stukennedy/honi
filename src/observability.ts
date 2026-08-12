import type { AiGatewayConfig } from './providers.js';

export interface ObservabilityConfig {
  /** @deprecated Set `aiGateway` at the top level of `createAgent()` config instead. */
  aiGateway?: AiGatewayConfig & { accountId: string };
  logLevel?: 'none' | 'error' | 'warn' | 'info' | 'debug';
  onEvent?: (event: HoniEvent) => void;
}

export type HoniEventType =
  | 'agent.request'
  | 'agent.response'
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

export class ObservabilityCollector {
  private events: HoniEvent[] = [];

  constructor(private config: ObservabilityConfig = {}) {}

  emit(event: HoniEvent): void {
    this.events.push(event);
    if (this.config.onEvent) this.config.onEvent(event);
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

export function createObservability(config: ObservabilityConfig = {}): ObservabilityCollector {
  return new ObservabilityCollector(config);
}
