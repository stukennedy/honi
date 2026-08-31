import type { ModelMessage } from 'ai';
import { upgradeLegacyMessage } from './memory.js';

/**
 * Recover structured message content from the TEXT column. `append` persists
 * parts arrays as JSON — assistant messages ALWAYS carry parts arrays on
 * AI SDK 5+ — so returning the raw column as plain text would hand the model
 * its own previous answer as literal `[{"type":"text",...}]`, and tool calls
 * (with their Gemini thought signatures) would never replay as parts.
 *
 * Only a JSON array whose every element is a `{ type: string }` object is
 * treated as parts; anything else (including user text that merely starts
 * with `[`) stays the plain string it always was.
 */
function parseStructuredContent(raw: string): string | Array<Record<string, unknown>> {
  if (!raw.startsWith('[')) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          typeof (part as { type?: unknown }).type === 'string',
      )
    ) {
      return parsed as Array<Record<string, unknown>>;
    }
  } catch {
    // Plain text that happens to start with '[' — keep it as text.
  }
  return raw;
}

function toMessage(r: { role: string; content: string }): ModelMessage {
  switch (r.role) {
    case 'user':
      return upgradeLegacyMessage({
        role: 'user',
        content: parseStructuredContent(r.content),
      } as ModelMessage);
    case 'assistant':
      return upgradeLegacyMessage({
        role: 'assistant',
        content: parseStructuredContent(r.content),
      } as ModelMessage);
    case 'tool': {
      const content = parseStructuredContent(r.content);
      // A tool message REQUIRES parts on AI SDK 5+; an unparseable tool row
      // keeps the pre-0.9 fallback (user text) rather than failing prompt
      // validation for the whole thread.
      if (typeof content === 'string') return { role: 'user', content };
      return upgradeLegacyMessage({ role: 'tool', content } as ModelMessage);
    }
    case 'system':
      return { role: 'system', content: r.content };
    default:
      return { role: 'user', content: r.content };
  }
}

export class EpisodicMemory {
  constructor(private db: D1Database) {}

  async init(): Promise<void> {
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

  async append(
    agentName: string,
    threadId: string,
    messages: ModelMessage[],
  ): Promise<void> {
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO honi_messages (id, agent_name, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const batch = messages.map((m, i) =>
      stmt.bind(
        crypto.randomUUID(),
        agentName,
        threadId,
        m.role,
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        now + i,
      ),
    );
    await this.db.batch(batch);
  }

  async load(
    agentName: string,
    threadId: string,
    limit = 50,
  ): Promise<ModelMessage[]> {
    const { results } = await this.db
      .prepare(
        'SELECT role, content FROM honi_messages WHERE agent_name = ? AND thread_id = ? ORDER BY created_at ASC LIMIT ?',
      )
      .bind(agentName, threadId, limit)
      .all<{ role: string; content: string }>();
    return results.map((r) => toMessage(r));
  }

  async clear(agentName: string, threadId: string): Promise<void> {
    await this.db
      .prepare(
        'DELETE FROM honi_messages WHERE agent_name = ? AND thread_id = ?',
      )
      .bind(agentName, threadId)
      .run();
  }

  async search(
    agentName: string,
    query: string,
    limit = 10,
  ): Promise<ModelMessage[]> {
    const { results } = await this.db
      .prepare(
        'SELECT role, content FROM honi_messages WHERE agent_name = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?',
      )
      .bind(agentName, `%${query}%`, limit)
      .all<{ role: string; content: string }>();
    return results.map((r) => toMessage(r));
  }
}
