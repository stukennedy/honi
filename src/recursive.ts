/**
 * RecursiveMemory — Recursive Language Model (RLM) tier for Honi.
 *
 * Implements the RLM pattern from Zhang, Kraska & Khattab (MIT CSAIL, 2025).
 * Instead of one-shot RAG retrieval, the model iteratively queries a document
 * store via a REPL loop — deciding what to read at each step based on what
 * it has already learned.
 *
 * Documents are chunked and stored in Durable Object storage alongside an
 * inverted keyword index. The REPL tools (search, read_chunks, get_index)
 * execute as DO storage reads — sub-millisecond, no network hop.
 */

import { generateText, tool } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { RecursiveConfig } from './types.js';

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

/** A single chunk of document text stored in DO. */
interface Chunk {
  id: number;
  docId: string;
  text: string;
  start: number;
  end: number;
}

/** Document metadata stored in DO. */
interface DocMeta {
  id: string;
  title?: string;
  chunkIds: number[];
  loadedAt: number;
}

/** Result returned from the REPL loop. */
export interface RlmResult {
  /** The model's final text answer. */
  answer: string;
  /** Number of REPL iterations performed. */
  iterations: number;
  /** Chunk IDs that were read during the loop. */
  chunksRead: number[];
}

const REPL_SYSTEM = `You are a reasoning agent with access to a document store. Use the available tools to read the documents and find the information you need to answer the user's question.

Strategy:
1. Start with search() to find relevant chunk IDs for key terms.
2. Use read_chunks() to fetch the actual content of promising chunks.
3. Use get_index() if you need to see all available documents.
4. Iterate — use what you've read to decide what to read next.
5. When you have enough to answer confidently, respond in plain text WITHOUT calling any tool.

Read only what you need. Targeted reads beat reading everything.`;

export class RecursiveMemory {
  private storage: DurableObjectStorage;
  private config: RecursiveConfig;
  private chunkSize: number;

  constructor(storage: DurableObjectStorage, config: RecursiveConfig) {
    this.storage = storage;
    this.config = config;
    this.chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  // ─── Document loading ────────────────────────────────────────────────────

  /**
   * Chunk a document and store it in DO storage alongside an inverted index.
   * Idempotent — reloading the same docId replaces the old chunks.
   */
  async loadDocument(id: string, content: string, title?: string): Promise<void> {
    // Remove old chunks for this doc if present
    await this.clearDocument(id);

    const chunks: Chunk[] = [];
    let pos = 0;
    let chunkId = await this._nextChunkId();

    while (pos < content.length) {
      const end = Math.min(pos + this.chunkSize, content.length);
      chunks.push({ id: chunkId, docId: id, text: content.slice(pos, end), start: pos, end });
      pos = end;
      chunkId++;
    }

    // Store each chunk
    const batch: Record<string, unknown> = {};
    for (const chunk of chunks) {
      batch[`rlm:chunk:${chunk.id}`] = chunk;
    }

    // Store doc metadata
    const meta: DocMeta = {
      id,
      title,
      chunkIds: chunks.map((c) => c.id),
      loadedAt: Date.now(),
    };
    batch[`rlm:doc:${id}`] = meta;

    // Update inverted keyword index
    const index = await this._loadIndex();
    for (const chunk of chunks) {
      const words = this._tokenise(chunk.text);
      for (const word of words) {
        if (!index[word]) index[word] = [];
        if (!index[word].includes(chunk.id)) index[word].push(chunk.id);
      }
    }
    batch['rlm:index'] = index;

    // Update doc list
    const docs = await this._loadDocList();
    if (!docs.includes(id)) docs.push(id);
    batch['rlm:docs'] = docs;

    await this.storage.put(batch);
  }

  /** Remove a document and its chunks from DO storage. */
  async clearDocument(id: string): Promise<void> {
    const meta = await this.storage.get<DocMeta>(`rlm:doc:${id}`);
    if (!meta) return;

    const toDelete = [`rlm:doc:${id}`, ...meta.chunkIds.map((cid) => `rlm:chunk:${cid}`)];
    await Promise.all(toDelete.map((k) => this.storage.delete(k)));

    // Rebuild index without these chunks (simple — prune entries)
    const index = await this._loadIndex();
    const removed = new Set(meta.chunkIds);
    for (const word of Object.keys(index)) {
      index[word] = index[word].filter((cid) => !removed.has(cid));
      if (index[word].length === 0) delete index[word];
    }
    await this.storage.put('rlm:index', index);

    const docs = (await this._loadDocList()).filter((d) => d !== id);
    await this.storage.put('rlm:docs', docs);
  }

  // ─── REPL tools ──────────────────────────────────────────────────────────

  /**
   * Search the inverted index for chunks matching a query.
   * Returns up to `limit` chunk IDs ranked by term overlap.
   */
  async search(query: string, limit = 10): Promise<{ chunkId: number; score: number; snippet: string }[]> {
    const index = await this._loadIndex();
    const words = this._tokenise(query);
    const scores: Record<number, number> = {};

    for (const word of words) {
      for (const cid of index[word] ?? []) {
        scores[cid] = (scores[cid] ?? 0) + 1;
      }
    }

    const sorted = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    const results: { chunkId: number; score: number; snippet: string }[] = [];
    for (const [cidStr, score] of sorted) {
      const cid = Number(cidStr);
      const chunk = await this.storage.get<Chunk>(`rlm:chunk:${cid}`);
      if (chunk) {
        results.push({ chunkId: cid, score, snippet: chunk.text.slice(0, 120) + '…' });
      }
    }
    return results;
  }

  /**
   * Fetch full text for specific chunk IDs.
   */
  async readChunks(ids: number[]): Promise<{ chunkId: number; docId: string; text: string }[]> {
    const results: { chunkId: number; docId: string; text: string }[] = [];
    for (const id of ids) {
      const chunk = await this.storage.get<Chunk>(`rlm:chunk:${id}`);
      if (chunk) results.push({ chunkId: chunk.id, docId: chunk.docId, text: chunk.text });
    }
    return results;
  }

  /**
   * Return a summary of all loaded documents (ids, titles, chunk counts).
   */
  async getIndex(): Promise<{ docId: string; title?: string; chunkCount: number; loadedAt: number }[]> {
    const docs = await this._loadDocList();
    const result = [];
    for (const id of docs) {
      const meta = await this.storage.get<DocMeta>(`rlm:doc:${id}`);
      if (meta) {
        result.push({ docId: meta.id, title: meta.title, chunkCount: meta.chunkIds.length, loadedAt: meta.loadedAt });
      }
    }
    return result;
  }

  // ─── REPL loop ───────────────────────────────────────────────────────────

  /**
   * Run the RLM loop: the model iteratively queries the document store via
   * REPL tools until it can answer the question in plain text.
   *
   * @param userMessage  The question to answer
   * @param model        Resolved LanguageModel (from Honi's resolveModel)
   * @param systemPrompt The agent's own system prompt (prepended to REPL instructions)
   * @returns            { answer, iterations, chunksRead }
   */
  async runLoop(
    userMessage: string,
    model: LanguageModel,
    systemPrompt: string,
    maxDepth?: number,
    timeoutMs?: number,
  ): Promise<RlmResult> {
    const depth = maxDepth ?? this.config.maxDepth ?? DEFAULT_MAX_DEPTH;
    const timeout = timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    const chunksRead: number[] = [];

    // Build tool set pointing at this RecursiveMemory instance
    const rlmTools = {
      search: tool({
        description: 'Search the document store for chunks matching a query. Returns chunk IDs and snippets.',
        parameters: z.object({
          query: z.string().describe('Search query — key terms or a phrase'),
          limit: z.number().optional().describe('Max results. Defaults to 10.'),
        }),
        execute: async ({ query, limit }) => {
          return this.search(query, limit);
        },
      }),
      read_chunks: tool({
        description: 'Fetch the full text of specific chunks by their IDs.',
        parameters: z.object({
          ids: z.array(z.number()).describe('Array of chunk IDs to retrieve'),
        }),
        execute: async ({ ids }) => {
          chunksRead.push(...ids);
          return this.readChunks(ids);
        },
      }),
      get_index: tool({
        description: 'List all loaded documents with their titles and chunk counts.',
        parameters: z.object({}),
        execute: async () => {
          return this.getIndex();
        },
      }),
    };

    const combinedSystem = [
      systemPrompt,
      REPL_SYSTEM,
    ].filter(Boolean).join('\n\n');

    const { text } = await generateText({
      model,
      system: combinedSystem,
      messages: [{ role: 'user', content: userMessage }],
      tools: rlmTools,
      maxSteps: depth,
      abortSignal: AbortSignal.timeout(deadline - Date.now()),
    });

    return {
      answer: text,
      iterations: chunksRead.length > 0 ? Math.ceil(chunksRead.length / 2) : 1,
      chunksRead: [...new Set(chunksRead)],
    };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async _nextChunkId(): Promise<number> {
    const current = (await this.storage.get<number>('rlm:next_chunk_id')) ?? 0;
    await this.storage.put('rlm:next_chunk_id', current + 1000); // pre-allocate
    return current;
  }

  private async _loadIndex(): Promise<Record<string, number[]>> {
    return (await this.storage.get<Record<string, number[]>>('rlm:index')) ?? {};
  }

  private async _loadDocList(): Promise<string[]> {
    return (await this.storage.get<string[]>('rlm:docs')) ?? [];
  }

  /** Simple tokeniser — lowercase alphanumeric words, 3+ chars. */
  private _tokenise(text: string): string[] {
    return [...new Set(
      text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [],
    )];
  }
}
