import type { ModelMessage } from 'ai';

/**
 * Upgrade one message persisted by honidev < 0.9 (AI SDK 4 shapes) to the
 * AI SDK 5+ `ModelMessage` shape.
 *
 * AI SDK 7 VALIDATES `messages` against its zod schema before every call —
 * v4 never did — so a stored v4 shape is not merely suboptimal, it throws
 * `InvalidPromptError` on every subsequent turn of the thread:
 * - assistant tool-call parts renamed `args` → `input`
 * - tool-result parts moved `result`/`isError` under the required
 *   `output: { type, value }` envelope
 * - v4 `redacted-reasoning` parts have no v7 equivalent and are dropped
 * Already-v7 messages pass through untouched, so the walk is idempotent.
 */
export function upgradeLegacyMessage(message: ModelMessage): ModelMessage {
  const record = message as unknown as { role?: string; content?: unknown };
  if (!Array.isArray(record.content)) return message;

  const content = (record.content as Array<Record<string, unknown>>).flatMap((part) => {
    if (part === null || typeof part !== 'object') return [part];
    if (part.type === 'tool-call' && part.input === undefined && 'args' in part) {
      const { args, toolCallType: _toolCallType, ...rest } = part;
      return [{ ...rest, input: args }];
    }
    if (part.type === 'tool-result' && part.output === undefined && 'result' in part) {
      const { result, isError, experimental_content: _content, ...rest } = part;
      return [{ ...rest, output: { type: isError ? 'error-json' : 'json', value: result ?? null } }];
    }
    if (part.type === 'redacted-reasoning') return [];
    return [part];
  });

  return { ...message, content } as unknown as ModelMessage;
}

export class ThreadMemory {
  constructor(private storage: DurableObjectStorage) {}

  async load(): Promise<ModelMessage[]> {
    const messages = await this.storage.get<ModelMessage[]>('messages');
    // Upgrade on READ, not by rewriting storage: load is the one choke point
    // every stored thread passes through, and old shapes keep arriving from
    // threads that were last written by honidev < 0.9.
    return (messages ?? []).map(upgradeLegacyMessage);
  }

  async append(messages: ModelMessage[]): Promise<void> {
    const existing = await this.load();
    existing.push(...messages);
    // JSON round-trip before storage.put: DO storage uses the v8
    // structured-clone serializer, which THROWS on functions — observed live
    // as DataCloneError at phase working_memory.save when a ZodError (own
    // property closure `(sub) => { this.issues = [...] }`) rode an
    // invalid-tool-args marker into the assistant message's tool-call args.
    // Messages are provider-wire JSON semantically, so the round-trip is
    // lossless for real content and silently drops only unclonable decoration
    // instead of killing the turn.
    await this.storage.put('messages', JSON.parse(JSON.stringify(existing)) as ModelMessage[]);
  }

  async clear(): Promise<void> {
    await this.storage.delete('messages');
  }
}
