export interface ObservabilityConfig {
  aiGateway?: {
    accountId: string;
    gatewayId: string;
  };
  logLevel?: 'none' | 'error' | 'warn' | 'info' | 'debug';
  onEvent?: (event: HoniEvent) => void;
}

export type HoniEventType =
  | 'agent.request'
  | 'agent.response'
  | 'tool.call'
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

  // Get AI Gateway base URL for routing LLM calls through CF AI Gateway
  getAiGatewayUrl(provider: 'anthropic' | 'openai'): string | undefined {
    if (!this.config.aiGateway) return undefined;
    const { accountId, gatewayId } = this.config.aiGateway;
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}`;
  }
}

export function createObservability(config: ObservabilityConfig = {}): ObservabilityCollector {
  return new ObservabilityCollector(config);
}
