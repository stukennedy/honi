import { describe, expect, it, beforeEach } from 'bun:test';
import { ThreadMemory } from '../src/memory.js';

// Mock DurableObjectStorage with a simple in-memory Map
function createMockStorage(): any {
  const store = new Map<string, any>();
  return {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key),
    put: async (key: string, value: any): Promise<void> => { store.set(key, value); },
    delete: async (key: string): Promise<boolean> => store.delete(key),
  };
}

describe('ThreadMemory', () => {
  let memory: ThreadMemory;

  beforeEach(() => {
    memory = new ThreadMemory(createMockStorage());
  });

  it('returns empty array when no messages stored', async () => {
    const messages = await memory.load();
    expect(messages).toEqual([]);
  });

  it('appends and loads messages', async () => {
    await memory.append([{ role: 'user', content: 'hello' }]);
    const messages = await memory.load();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('appends multiple batches', async () => {
    await memory.append([{ role: 'user', content: 'first' }]);
    await memory.append([{ role: 'assistant', content: 'second' }]);
    const messages = await memory.load();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('first');
    expect(messages[1].content).toBe('second');
  });

  it('clears messages', async () => {
    await memory.append([{ role: 'user', content: 'hello' }]);
    await memory.clear();
    const messages = await memory.load();
    expect(messages).toEqual([]);
  });
});
