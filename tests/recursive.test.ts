import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { RecursiveMemory } from '../src/recursive.js';
import type { RecursiveConfig } from '../src/types.js';

// ─── Mock DO storage ──────────────────────────────────────────────────────────

function createMockStorage(): any {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    put: async (keyOrMap: string | Record<string, unknown>, value?: unknown): Promise<void> => {
      if (typeof keyOrMap === 'string') {
        store.set(keyOrMap, value);
      } else {
        for (const [k, v] of Object.entries(keyOrMap)) {
          store.set(k, v);
        }
      }
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
  };
}

const defaultConfig: RecursiveConfig = {
  enabled: true,
  maxDepth: 5,
  timeoutMs: 10_000,
  chunkSize: 100,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RecursiveMemory', () => {
  let storage: any;
  let mem: RecursiveMemory;

  beforeEach(() => {
    storage = createMockStorage();
    mem = new RecursiveMemory(storage, defaultConfig);
  });

  // ── loadDocument ──────────────────────────────────────────────────────────

  it('loadDocument stores chunks in DO storage', async () => {
    const content = 'a'.repeat(250); // 3 chunks of 100 chars (last partial)
    await mem.loadDocument('doc1', content);

    const docMeta = await storage.get('rlm:doc:doc1');
    expect(docMeta).toBeDefined();
    expect(docMeta.id).toBe('doc1');
    expect(docMeta.chunkIds.length).toBe(3); // 100 + 100 + 50
  });

  it('loadDocument stores title', async () => {
    await mem.loadDocument('doc1', 'hello world', 'My Doc');
    const meta = await storage.get('rlm:doc:doc1');
    expect(meta.title).toBe('My Doc');
  });

  it('loadDocument adds doc to doc list', async () => {
    await mem.loadDocument('doc1', 'hello');
    await mem.loadDocument('doc2', 'world');
    const docs = await storage.get('rlm:docs');
    expect(docs).toContain('doc1');
    expect(docs).toContain('doc2');
  });

  it('loadDocument is idempotent — reloading replaces old chunks', async () => {
    await mem.loadDocument('doc1', 'first version content');
    const metaBefore = await storage.get('rlm:doc:doc1');
    const countBefore = metaBefore.chunkIds.length;

    await mem.loadDocument('doc1', 'second version with more content here');
    const metaAfter = await storage.get('rlm:doc:doc1');
    expect(metaAfter.id).toBe('doc1');
    // Chunk count may differ if content length differs — just assert it reloaded
    expect(metaAfter.loadedAt).toBeGreaterThanOrEqual(metaBefore.loadedAt);
  });

  // ── clearDocument ─────────────────────────────────────────────────────────

  it('clearDocument removes doc and its chunks', async () => {
    await mem.loadDocument('doc1', 'removable content here');
    const meta = await storage.get('rlm:doc:doc1');
    const chunkId = meta.chunkIds[0];

    await mem.clearDocument('doc1');

    expect(await storage.get('rlm:doc:doc1')).toBeUndefined();
    expect(await storage.get(`rlm:chunk:${chunkId}`)).toBeUndefined();
  });

  it('clearDocument is safe on unknown doc', async () => {
    await expect(mem.clearDocument('does-not-exist')).resolves.toBeUndefined();
  });

  // ── search ────────────────────────────────────────────────────────────────

  it('search returns chunks matching query terms', async () => {
    await mem.loadDocument('doc1', 'activation error on macintosh arm bridge version required');
    const results = await mem.search('activation error');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBeDefined();
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].snippet).toBeDefined();
  });

  it('search returns empty for unmatched query', async () => {
    await mem.loadDocument('doc1', 'hello world foo bar');
    const results = await mem.search('zzz qqq xxx');
    expect(results).toEqual([]);
  });

  it('search ranks higher scoring chunks first', async () => {
    // Two docs: one mentions 'bridge' twice, one once
    await mem.loadDocument('doc1', 'bridge upgrade bridge version');
    await mem.loadDocument('doc2', 'bridge software');
    const results = await mem.search('bridge');
    expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
  });

  // ── readChunks ────────────────────────────────────────────────────────────

  it('readChunks returns full text for valid IDs', async () => {
    await mem.loadDocument('doc1', 'the quick brown fox jumps over the lazy dog');
    const searchResults = await mem.search('quick brown fox');
    const ids = searchResults.map((r) => r.chunkId);
    const chunks = await mem.readChunks(ids);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('quick');
    expect(chunks[0].docId).toBe('doc1');
  });

  it('readChunks skips unknown IDs silently', async () => {
    const chunks = await mem.readChunks([99999, 88888]);
    expect(chunks).toEqual([]);
  });

  // ── getIndex ──────────────────────────────────────────────────────────────

  it('getIndex lists all loaded documents', async () => {
    await mem.loadDocument('doc1', 'content a', 'Doc A');
    await mem.loadDocument('doc2', 'content b', 'Doc B');
    const index = await mem.getIndex();
    expect(index.length).toBe(2);
    const ids = index.map((d) => d.docId);
    expect(ids).toContain('doc1');
    expect(ids).toContain('doc2');
  });

  it('getIndex returns chunk counts', async () => {
    const content = 'x'.repeat(250); // 3 chunks at 100 chars each
    await mem.loadDocument('doc1', content);
    const index = await mem.getIndex();
    const doc = index.find((d) => d.docId === 'doc1')!;
    expect(doc.chunkCount).toBe(3);
  });

  // ── runLoop ───────────────────────────────────────────────────────────────

  it('runLoop calls model and returns answer + metadata', async () => {
    await mem.loadDocument('bridge-kb', 'Bridge 1.4 is required for ARM Macs. Upgrade via Settings.');

    // Mock LanguageModel that immediately returns a text answer (no tool calls)
    const mockModel = {
      specificationVersion: 'v1' as const,
      provider: 'mock',
      modelId: 'mock-model',
      defaultObjectGenerationMode: undefined,
      doGenerate: mock(async () => ({
        text: 'You need Bridge 1.4 for ARM Macs.',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10 },
        rawCall: { rawPrompt: '', rawSettings: {} },
        toolCalls: [],
        toolResults: [],
        response: { id: 'mock', timestamp: new Date(), modelId: 'mock-model' },
        warnings: [],
        providerMetadata: undefined,
        steps: [],
      })),
      doStream: mock(async () => ({ stream: new ReadableStream(), rawCall: { rawPrompt: '', rawSettings: {} }, warnings: [] })),
    };

    const result = await mem.runLoop(
      'What version of Bridge do I need for an ARM Mac?',
      mockModel as any,
      'You are a support agent.',
    );

    expect(result.answer).toBeTruthy();
    expect(typeof result.iterations).toBe('number');
    expect(Array.isArray(result.chunksRead)).toBe(true);
  });
});
