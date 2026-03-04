function toMessage(r) {
    const content = r.content;
    switch (r.role) {
        case 'user': return { role: 'user', content };
        case 'assistant': return { role: 'assistant', content };
        case 'system': return { role: 'system', content };
        default: return { role: 'user', content };
    }
}
export class EpisodicMemory {
    db;
    constructor(db) {
        this.db = db;
    }
    async init() {
        await this.db.exec(`
      CREATE TABLE IF NOT EXISTS honi_messages (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_honi_messages_thread
        ON honi_messages(agent_name, thread_id, created_at);
    `);
    }
    async append(agentName, threadId, messages) {
        const now = Date.now();
        const stmt = this.db.prepare('INSERT INTO honi_messages (id, agent_name, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        const batch = messages.map((m, i) => stmt.bind(crypto.randomUUID(), agentName, threadId, m.role, typeof m.content === 'string' ? m.content : JSON.stringify(m.content), now + i));
        await this.db.batch(batch);
    }
    async load(agentName, threadId, limit = 50) {
        const { results } = await this.db
            .prepare('SELECT role, content FROM honi_messages WHERE agent_name = ? AND thread_id = ? ORDER BY created_at ASC LIMIT ?')
            .bind(agentName, threadId, limit)
            .all();
        return results.map((r) => toMessage(r));
    }
    async clear(agentName, threadId) {
        await this.db
            .prepare('DELETE FROM honi_messages WHERE agent_name = ? AND thread_id = ?')
            .bind(agentName, threadId)
            .run();
    }
    async search(agentName, query, limit = 10) {
        const { results } = await this.db
            .prepare('SELECT role, content FROM honi_messages WHERE agent_name = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?')
            .bind(agentName, `%${query}%`, limit)
            .all();
        return results.map((r) => toMessage(r));
    }
}
//# sourceMappingURL=episodic.js.map