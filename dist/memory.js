export class ThreadMemory {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    async load() {
        const messages = await this.storage.get('messages');
        return messages ?? [];
    }
    async append(messages) {
        const existing = await this.load();
        existing.push(...messages);
        await this.storage.put('messages', existing);
    }
    async clear() {
        await this.storage.delete('messages');
    }
}
//# sourceMappingURL=memory.js.map