import type { CoreMessage } from 'ai';

export class ThreadMemory {
  constructor(private storage: DurableObjectStorage) {}

  async load(): Promise<CoreMessage[]> {
    const messages = await this.storage.get<CoreMessage[]>('messages');
    return messages ?? [];
  }

  async append(messages: CoreMessage[]): Promise<void> {
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
    await this.storage.put('messages', JSON.parse(JSON.stringify(existing)) as CoreMessage[]);
  }

  async clear(): Promise<void> {
    await this.storage.delete('messages');
  }
}
