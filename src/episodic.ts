import type { ModelMessage } from 'ai';
import { upgradeLegacyMessage } from './memory.js';

/**
 * Content encoding for the TEXT column.
 *
 * `append` persists parts arrays as JSON — assistant messages ALWAYS carry
 * parts arrays on AI SDK 5+ — so returning the raw column as plain text would
 * hand the model its own previous answer as literal `[{"type":"text",...}]`,
 * and tool calls (with their Gemini thought signatures) would never replay
 * as parts.
 *
 * Structured rows are prefixed with an explicit marker so decoding never has
 * to GUESS whether a string is quoted JSON or parts: a user can legitimately
 * send the literal text `[{"type":"text","text":"hi"}]`, and inferring from
 * shape alone would silently turn that quoted text into message content — or
 * worse, turn `[{"type":"book",...}]` into invalid parts that fail prompt
 * validation on every subsequent turn of the thread. Plain strings that
 * start with a marker (or that the LEGACY fallback below would misread) are
 * escaped behind the text marker, so the encoding is collision-free for
 * everything written from here on.
 */
const PARTS_MARKER = 'honi::parts::';
const TEXT_MARKER = 'honi::text::';

/** Part types honidev has ever persisted (v4 and v5+ vocabularies). */
const KNOWN_PART_TYPES = new Set([
  'text',
  'image',
  'file',
  'reasoning',
  'redacted-reasoning',
  'tool-call',
  'tool-result',
  'tool-approval-request',
  'tool-approval-response',
]);

/**
 * The pre-marker heuristic, kept ONLY for rows written before the marker
 * existed (honidev <= 0.9.0 stored bare JSON): a JSON array whose every
 * element is an object with a KNOWN part type. Unknown types stay text —
 * `[{"type":"book",...}]` is user data, not message parts.
 */
function parseLegacyParts(raw: string): Array<Record<string, unknown>> | undefined {
  if (!raw.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          typeof (part as { type?: unknown }).type === 'string' &&
          KNOWN_PART_TYPES.has((part as { type: string }).type),
      )
    ) {
      return parsed as Array<Record<string, unknown>>;
    }
  } catch {
    // Plain text that happens to start with '[' — keep it as text.
  }
  return undefined;
}

function encodeContent(content: ModelMessage['content']): string {
  if (typeof content !== 'string') return PARTS_MARKER + JSON.stringify(content);
  // Escape any string the decoder could misread: marker prefixes, and text
  // the legacy fallback would parse as parts.
  if (
    content.startsWith(PARTS_MARKER) ||
    content.startsWith(TEXT_MARKER) ||
    parseLegacyParts(content) !== undefined
  ) {
    return TEXT_MARKER + content;
  }
  return content;
}

function parseStructuredContent(raw: string): string | Array<Record<string, unknown>> {
  if (raw.startsWith(PARTS_MARKER)) {
    try {
      return JSON.parse(raw.slice(PARTS_MARKER.length)) as Array<Record<string, unknown>>;
    } catch {
      return raw;
    }
  }
  if (raw.startsWith(TEXT_MARKER)) return raw.slice(TEXT_MARKER.length);
  return parseLegacyParts(raw) ?? raw;
}

/**
 * Decode a column that must stay STRING-valued (system rows, and the
 * unknown-role fallback). `encodeContent` escapes marker-looking strings for
 * every role, so string-only rows still need the text-marker unescape — but
 * never the parts decoding.
 */
function decodeTextContent(raw: string): string {
  return raw.startsWith(TEXT_MARKER) ? raw.slice(TEXT_MARKER.length) : raw;
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
      return { role: 'system', content: decodeTextContent(r.content) };
    default:
      return { role: 'user', content: decodeTextContent(r.content) };
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
        encodeContent(m.content),
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
