import { describe, expect, it } from 'bun:test';
import { ObservabilityCollector, measurePhase } from '../src/observability.js';

describe('measurePhase()', () => {
  it('emits a completed phase with duration without changing the result', async () => {
    const collector = new ObservabilityCollector();

    const result = await measurePhase(
      collector,
      {
        type: 'memory.load',
        agentName: 'scan-agent',
        threadId: 'scan_123:voice',
        metadata: { source: 'durable-object' },
      },
      async () => ['first', 'second'],
    );

    expect(result).toEqual(['first', 'second']);
    expect(collector.getEvents()).toEqual([
      {
        type: 'memory.load',
        agentName: 'scan-agent',
        threadId: 'scan_123:voice',
        timestamp: expect.any(Number),
        durationMs: expect.any(Number),
        metadata: {
          source: 'durable-object',
          outcome: 'completed',
        },
      },
    ]);
  });

  it('emits a failed phase using the error type without exposing its message', async () => {
    const collector = new ObservabilityCollector();

    await expect(
      measurePhase(
        collector,
        {
          type: 'memory.save',
          agentName: 'scan-agent',
          threadId: 'scan_123:voice',
        },
        async () => {
          throw new TypeError('learner content must not reach telemetry');
        },
      ),
    ).rejects.toThrow('learner content must not reach telemetry');

    expect(collector.getEvents()).toEqual([
      {
        type: 'memory.save',
        agentName: 'scan-agent',
        threadId: 'scan_123:voice',
        timestamp: expect.any(Number),
        durationMs: expect.any(Number),
        metadata: { outcome: 'failed', errorType: 'TypeError' },
      },
    ]);
  });

  it('returns a successful operation even when its observer throws', async () => {
    const collector = new ObservabilityCollector({
      onEvent: () => {
        throw new Error('telemetry only');
      },
    });

    await expect(
      measurePhase(
        collector,
        { type: 'agent.phase', agentName: 'scan-agent' },
        async () => 'learner-result',
      ),
    ).resolves.toBe('learner-result');
  });
});
