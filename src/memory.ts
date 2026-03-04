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
    await this.storage.put('messages', existing);
  }

  async clear(): Promise<void> {
    await this.storage.delete('messages');
  }
}
