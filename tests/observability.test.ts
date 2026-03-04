import { describe, expect, it, beforeEach } from 'bun:test';
import { ObservabilityCollector, createObservability } from '../src/observability.js';
import type { HoniEvent } from '../src/observability.js';

describe('ObservabilityCollector', () => {
  let collector: ObservabilityCollector;

  beforeEach(() => {
    collector = new ObservabilityCollector();
  });

  it('starts with no events', () => {
    expect(collector.getEvents()).toEqual([]);
  });

  it('emits and collects events', () => {
    const event: HoniEvent = {
      type: 'agent.request',
      agentName: 'test-agent',
      timestamp: Date.now(),
    };

    collector.emit(event);
    const events = collector.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent.request');
    expect(events[0].agentName).toBe('test-agent');
  });

  it('returns a copy of events (immutable)', () => {
    collector.emit({
      type: 'tool.call',
      agentName: 'test',
      timestamp: Date.now(),
    });

    const events1 = collector.getEvents();
    const events2 = collector.getEvents();
    expect(events1).toEqual(events2);
    expect(events1).not.toBe(events2); // different array references
  });

  it('clears events', () => {
    collector.emit({
      type: 'agent.request',
      agentName: 'test',
      timestamp: Date.now(),
    });
    collector.clear();
    expect(collector.getEvents()).toEqual([]);
  });

  it('calls onEvent callback when emitting', () => {
    const received: HoniEvent[] = [];
    const collector = new ObservabilityCollector({
      onEvent: (event) => received.push(event),
    });

    collector.emit({
      type: 'workflow.start',
      agentName: 'wf-agent',
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('workflow.start');
  });

  it('logs in debug mode', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));

    const collector = new ObservabilityCollector({ logLevel: 'debug' });
    collector.emit({
      type: 'memory.save',
      agentName: 'test',
      timestamp: 123,
    });

    console.log = originalLog;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain('[honi:memory.save]');
  });
});

describe('getAiGatewayUrl()', () => {
  it('returns undefined without aiGateway config', () => {
    const collector = new ObservabilityCollector();
    expect(collector.getAiGatewayUrl('anthropic')).toBeUndefined();
  });

  it('returns correct URL for anthropic', () => {
    const collector = new ObservabilityCollector({
      aiGateway: { accountId: 'acc123', gatewayId: 'gw456' },
    });
    expect(collector.getAiGatewayUrl('anthropic')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc123/gw456/anthropic',
    );
  });

  it('returns correct URL for openai', () => {
    const collector = new ObservabilityCollector({
      aiGateway: { accountId: 'acc123', gatewayId: 'gw456' },
    });
    expect(collector.getAiGatewayUrl('openai')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc123/gw456/openai',
    );
  });
});

describe('createObservability()', () => {
  it('returns an ObservabilityCollector instance', () => {
    const collector = createObservability();
    expect(collector).toBeInstanceOf(ObservabilityCollector);
  });

  it('accepts config', () => {
    const collector = createObservability({ logLevel: 'error' });
    expect(collector).toBeInstanceOf(ObservabilityCollector);
  });
});
