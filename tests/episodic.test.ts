import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { modelMessageSchema, type ModelMessage } from 'ai';
import { EpisodicMemory } from '../src/episodic.js';

/**
 * Episodic (D1) history must round-trip STRUCTURED content. `append` persists
 * parts arrays as JSON in the TEXT column; returning that JSON as plain
 * assistant text hands the model its own previous answer as literal
 * `[{"type":"text",...}]` and never replays tool calls — or the Gemini
 * thought signatures riding them — as parts.
 */

interface Row {
  role: string;
  content: string;
}

function fakeD1(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const statement = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      sql,
      args,
      all: async <T>() => ({ results: rows as unknown as T[] }),
      run: async () => ({}),
    }),
    run: async () => ({}),
  });
  const db = {
    prepare: statement,
    exec: async () => ({}),
    batch: async (statements: Array<{ args: unknown[] }>) => {
      for (const s of statements) {
        rows.push({ role: String(s.args[3]), content: String(s.args[4]) });
      }
      return [];
    },
  } as unknown as D1Database;
  return { db, rows };
}

/**
 * A real-SQL D1 stand-in over bun:sqlite — the ordering and lazy-schema
 * behaviour under test IS the SQL, which a canned fake cannot exercise.
 */
function sqliteD1(): D1Database {
  const db = new Database(':memory:');
  const runnable = (sql: string, args: unknown[]) => ({
    all: async <T>() => ({ results: db.query(sql).all(...(args as never[])) as T[] }),
    run: async () => {
      db.query(sql).run(...(args as never[]));
      return {};
    },
  });
  return {
    prepare: (sql: string) => ({
      ...runnable(sql, []),
      bind: (...args: unknown[]) => runnable(sql, args),
    }),
    exec: async (sql: string) => db.exec(sql),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of statements) await s.run();
      return [];
    },
  } as unknown as D1Database;
}

const STRUCTURED_TURN: ModelMessage[] = [
  { role: 'user', content: 'look up 42' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look that up.' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup',
        input: { q: '42' },
        providerOptions: { google: { thoughtSignature: 'sig-abc' } },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'lookup',
        output: { type: 'json', value: { answer: 42 } },
      },
    ],
  },
];

describe('EpisodicMemory round-trips structured content', () => {
  it('replays assistant parts, tool messages, and thought signatures intact', async () => {
    const { db } = fakeD1();
    const memory = new EpisodicMemory(db);

    await memory.append('agent', 'thread', STRUCTURED_TURN);
    const loaded = await memory.load('agent', 'thread');

    expect(loaded).toEqual(STRUCTURED_TURN);
    for (const message of loaded) {
      expect(modelMessageSchema.safeParse(message).success).toBe(true);
    }
    const call = (loaded[1].content as Array<Record<string, unknown>>)[1] as {
      providerOptions?: { google?: { thoughtSignature?: string } };
    };
    expect(call.providerOptions?.google?.thoughtSignature).toBe('sig-abc');
  });

  it('upgrades 0.8.x rows stored with v4 part shapes', async () => {
    const { db } = fakeD1([
      {
        role: 'assistant',
        content: JSON.stringify([
          { type: 'tool-call', toolCallType: 'function', toolCallId: 'c1', toolName: 'lookup', args: { q: 'x' } },
        ]),
      },
      {
        role: 'tool',
        content: JSON.stringify([
          { type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', result: { hit: true } },
        ]),
      },
    ]);
    const loaded = await new EpisodicMemory(db).load('agent', 'thread');

    for (const message of loaded) {
      expect(modelMessageSchema.safeParse(message).success).toBe(true);
    }
    expect((loaded[0].content as Array<Record<string, unknown>>)[0].input).toEqual({ q: 'x' });
    expect((loaded[1].content as Array<Record<string, unknown>>)[0].output).toEqual({
      type: 'json',
      value: { hit: true },
    });
  });

  it('keeps plain text plain — even text that starts with a bracket', async () => {
    const { db } = fakeD1([
      { role: 'user', content: '[citation needed] is overused' },
      { role: 'assistant', content: 'Plain old answer' },
      { role: 'user', content: '[1,2,3]' },
    ]);
    const loaded = await new EpisodicMemory(db).load('agent', 'thread');

    expect(loaded[0]).toEqual({ role: 'user', content: '[citation needed] is overused' });
    expect(loaded[1]).toEqual({ role: 'assistant', content: 'Plain old answer' });
    // A bare JSON array of non-part values is NOT structured content.
    expect(loaded[2]).toEqual({ role: 'user', content: '[1,2,3]' });
  });

  it('falls back to the pre-0.9 user-text shape for an unparseable tool row', async () => {
    const { db } = fakeD1([{ role: 'tool', content: 'corrupt garbage' }]);
    const loaded = await new EpisodicMemory(db).load('agent', 'thread');
    expect(loaded[0]).toEqual({ role: 'user', content: 'corrupt garbage' });
    expect(modelMessageSchema.safeParse(loaded[0]).success).toBe(true);
  });

  it('never mistakes user JSON for message parts (marker-encoded rows)', async () => {
    // The trap: shape inference alone would turn quoted JSON into content —
    // invalid parts for unknown types, silent unquoting for valid ones.
    const quotedJson = [
      '[{"type":"book","title":"Dune"}]',
      '[{"type":"text","text":"hi"}]',
      'honi::parts::[{"type":"text","text":"spoof"}]',
    ];
    const { db } = fakeD1();
    const memory = new EpisodicMemory(db);
    await memory.append(
      'agent',
      'thread',
      quotedJson.map((content) => ({ role: 'user' as const, content })),
    );

    const loaded = await memory.load('agent', 'thread');
    expect(loaded).toEqual(quotedJson.map((content) => ({ role: 'user', content })));
    for (const message of loaded) {
      expect(modelMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('round-trips system messages whose text needs marker escaping', async () => {
    const awkward = [
      'honi::text::not actually escaped',
      'honi::parts::[]',
      '[{"type":"text","text":"quoted"}]',
    ];
    const { db } = fakeD1();
    const memory = new EpisodicMemory(db);
    await memory.append(
      'agent',
      'thread',
      awkward.map((content) => ({ role: 'system' as const, content })),
    );

    const loaded = await memory.load('agent', 'thread');
    expect(loaded).toEqual(awkward.map((content) => ({ role: 'system', content })));
  });

  it('round-trips binary file-part data losslessly', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const withFile: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'file', mediaType: 'image/png', data: bytes },
        ],
      },
    ];
    const { db } = fakeD1();
    const memory = new EpisodicMemory(db);
    await memory.append('agent', 'thread', withFile);

    const loaded = await memory.load('agent', 'thread');
    const filePart = (loaded[0].content as Array<Record<string, unknown>>)[1] as {
      data: Uint8Array;
    };
    expect(filePart.data).toBeInstanceOf(Uint8Array);
    expect([...filePart.data]).toEqual([...bytes]);
    expect(modelMessageSchema.safeParse(loaded[0]).success).toBe(true);
  });

  it('round-trips application data shaped like the binary envelope', async () => {
    // Tool outputs are arbitrary JSON — a payload that happens to carry
    // __honi_binary__/b64 keys must come back as the same OBJECT, not get
    // revived into a Uint8Array (or crash atob).
    const collision: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'export',
            output: {
              type: 'json',
              value: {
                __honi_binary__: 'u8',
                b64: 'definitely *not* base64!!',
                nested: { __honi_binary__: 'ab', b64: 'AQID' },
              },
            },
          },
        ],
      },
    ];
    const { db } = fakeD1();
    const memory = new EpisodicMemory(db);
    await memory.append('agent', 'thread', collision);

    const loaded = await memory.load('agent', 'thread');
    expect(loaded).toEqual(collision);
    expect(modelMessageSchema.safeParse(loaded[0]).success).toBe(true);
  });

  it('never applies legacy parts inference to user rows', async () => {
    // Pre-marker user rows written through the agent were always plain
    // strings — a user row that LOOKS like parts is a person who typed JSON.
    const quoted = '[{"type":"text","text":"hi"}]';
    const { db } = fakeD1([
      { role: 'user', content: quoted },
      { role: 'user', content: '[{"type":"book","title":"Dune"}]' },
    ]);
    const loaded = await new EpisodicMemory(db).load('agent', 'thread');
    expect(loaded[0]).toEqual({ role: 'user', content: quoted });
    expect(loaded[1]).toEqual({ role: 'user', content: '[{"type":"book","title":"Dune"}]' });
  });
});

describe('EpisodicMemory against real SQL (bun:sqlite)', () => {
  it('creates its schema lazily — no explicit init() required', async () => {
    const memory = new EpisodicMemory(sqliteD1());
    // First contact with a fresh D1 binding must not throw "no such table".
    expect(await memory.load('agent', 'thread')).toEqual([]);
    await memory.append('agent', 'thread', [{ role: 'user', content: 'hello' }]);
    expect(await memory.load('agent', 'thread')).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('load returns the NEWEST limit messages, in chronological order', async () => {
    // A plain ASC LIMIT returns the OLDEST rows: once a thread outgrows the
    // limit, recent turns never enter the context and the window freezes on
    // the first N rows forever.
    const memory = new EpisodicMemory(sqliteD1());
    const messages: ModelMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i + 1}`,
    }));
    await memory.append('agent', 'thread', messages);

    const loaded = await memory.load('agent', 'thread', 50);
    expect(loaded).toHaveLength(50);
    expect(loaded[0]).toEqual({ role: 'user', content: 'm11' });
    expect(loaded[49]).toEqual({ role: 'user', content: 'm60' });
  });

  it('scopes load to the requested agent and thread', async () => {
    const memory = new EpisodicMemory(sqliteD1());
    await memory.append('agent', 'thread-a', [{ role: 'user', content: 'a' }]);
    await memory.append('agent', 'thread-b', [{ role: 'user', content: 'b' }]);
    expect(await memory.load('agent', 'thread-a')).toEqual([{ role: 'user', content: 'a' }]);
  });
});

describe('marker-prefixed rows that are not ours', () => {
  it('preserves unparseable marker-prefixed text byte-for-byte', async () => {
    // A parts row this encoding wrote always parses; one that doesn't is
    // pre-marker text or corruption. Content that cannot be positively
    // identified as ours must never be altered — integrity over hiding the
    // scheme's name from the model.
    const { db } = fakeD1([
      { role: 'assistant', content: 'honi::parts::{not json' },
      { role: 'user', content: 'honi::parts::hello from a legacy row' },
    ]);
    const loaded = await new EpisodicMemory(db).load('agent', 'thread');
    expect(loaded[0]).toEqual({ role: 'assistant', content: 'honi::parts::{not json' });
    expect(loaded[1]).toEqual({ role: 'user', content: 'honi::parts::hello from a legacy row' });
  });

  it('preserves marker rows whose JSON is not a parts array', async () => {
    // Valid JSON of the wrong shape is just as much "not ours" as garbage:
    // decoding `"hello"` would silently unquote it, and `null` would become
    // invalid message content that fails prompt validation on every turn.
    const rows = [
      'honi::parts::"hello"',
      'honi::parts::null',
      'honi::parts::[{"noType":true}]',
      'honi::parts::42',
    ];
    const { db } = fakeD1(rows.map((content) => ({ role: 'user', content })));
    const loaded = await new EpisodicMemory(db).load('agent', 'thread');
    expect(loaded).toEqual(rows.map((content) => ({ role: 'user', content })));
  });
});
