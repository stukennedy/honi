import { describe, expect, it } from 'bun:test';
import { withEmptyStreamRetry } from '../src/providers.js';

type Part = Record<string, unknown>;

/**
 * A stream that emits `parts`, then either closes or errors.
 *
 * PULL-based deliberately: `controller.error()` discards anything still queued,
 * so an eager `start()` that enqueues then errors delivers NOTHING — which
 * silently turns the "emitted content, then died" case into "died immediately"
 * and lets the very regression under test slip through.
 */
function attempt(parts: Part[], failWith?: Error) {
  let i = 0;
  return {
    rawCall: {},
    stream: new ReadableStream({
      pull(controller) {
        if (i < parts.length) {
          controller.enqueue(parts[i++]);
          return;
        }
        if (failWith) controller.error(failWith);
        else controller.close();
      },
    }),
  };
}

/** A fake model that serves a scripted sequence of attempts. */
function fakeModel(attempts: Array<() => any>) {
  let i = 0;
  return {
    specificationVersion: 'v1',
    provider: 'test',
    modelId: 'test-model',
    doGenerate: async () => ({}),
    doStream: async () => {
      const next = attempts[Math.min(i, attempts.length - 1)];
      i++;
      return next();
    },
  } as any;
}

async function drain(stream: ReadableStream): Promise<{ parts: Part[]; error?: unknown }> {
  const reader = stream.getReader();
  const parts: Part[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as Part);
    }
  } catch (error) {
    return { parts, error };
  }
  return { parts };
}

const EMPTY = [{ type: 'finish', finishReason: 'unknown' }];
const TEXT = [{ type: 'text-delta', textDelta: 'hello' }, { type: 'finish', finishReason: 'stop' }];

describe('withEmptyStreamRetry', () => {
  it('re-issues a stream that closed cleanly with zero output', async () => {
    const model = fakeModel([() => attempt(EMPTY), () => attempt(TEXT)]);
    const wrapped = withEmptyStreamRetry(model, { label: 'test', escalated: false }) as any;
    const { parts, error } = await drain((await wrapped.doStream({})).stream);
    expect(error).toBeUndefined();
    expect(parts.some((p) => p.type === 'text-delta' && p.textDelta === 'hello')).toBe(true);
  });

  it('passes content straight through without retrying', async () => {
    let calls = 0;
    const model = fakeModel([
      () => {
        calls++;
        return attempt(TEXT);
      },
    ]);
    const wrapped = withEmptyStreamRetry(model, { label: 'test', escalated: false }) as any;
    await drain((await wrapped.doStream({})).stream);
    expect(calls).toBe(1);
  });

  it('propagates a retry that emits content and THEN fails, rather than closing cleanly', async () => {
    // The regression this guards: the partial content is already downstream,
    // so closing successfully hands the consumer a truncated turn labelled
    // done — and appending the first attempt's held parts corrupts it outright.
    const boom = new Error('upstream died mid-retry');
    const model = fakeModel([
      () => attempt(EMPTY),
      () => attempt([{ type: 'text-delta', textDelta: 'partial' }], boom),
    ]);
    const wrapped = withEmptyStreamRetry(model, { label: 'test', escalated: false }) as any;
    const { parts, error } = await drain((await wrapped.doStream({})).stream);
    expect(error).toBe(boom);
    expect(parts).toEqual([{ type: 'text-delta', textDelta: 'partial' }]);
    // The first attempt's held parts must NOT be appended on top.
    expect(parts.some((p) => p.type === 'finish')).toBe(false);
  });

  it('degrades to the empty result when a retry dies before emitting anything', async () => {
    const model = fakeModel([() => attempt(EMPTY), () => attempt([], new Error('nope'))]);
    const wrapped = withEmptyStreamRetry(model, { label: 'test', escalated: false }) as any;
    const { parts, error } = await drain((await wrapped.doStream({})).stream);
    // Nothing was forwarded, so the documented give-up path stands: the
    // original empty attempt's parts are released and the stream closes.
    expect(error).toBeUndefined();
    expect(parts).toEqual(EMPTY);
  });

  it('surfaces a first attempt that dies mid-stream instead of retrying it away', async () => {
    const boom = new Error('first attempt died');
    const model = fakeModel([() => attempt([{ type: 'text-delta', textDelta: 'x' }], boom)]);
    const wrapped = withEmptyStreamRetry(model, { label: 'test', escalated: false }) as any;
    const { error } = await drain((await wrapped.doStream({})).stream);
    expect(error).toBe(boom);
  });

  it('calls onRetry once per retry so a caller can escalate a provider knob', async () => {
    let escalations = 0;
    const model = fakeModel([() => attempt(EMPTY), () => attempt(EMPTY), () => attempt(TEXT)]);
    const wrapped = withEmptyStreamRetry(model, {
      label: 'test',
      escalated: true,
      onRetry: () => escalations++,
    }) as any;
    await drain((await wrapped.doStream({})).stream);
    expect(escalations).toBe(2);
  });
});
