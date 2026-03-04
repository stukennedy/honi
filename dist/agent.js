import { Hono } from 'hono';
import { streamText, tool as aiTool } from 'ai';
import { resolveModel } from './providers.js';
import { ThreadMemory } from './memory.js';
import { EpisodicMemory } from './episodic.js';
import { SemanticMemory } from './semantic.js';
function buildTools(tools) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = {};
    for (const t of tools) {
        result[t.name] = aiTool({
            description: t.description,
            parameters: t.input,
            execute: async (args) => t.handler(args),
        });
    }
    return result;
}
export function createAgent(config) {
    const binding = config.binding ?? 'AGENT';
    const maxSteps = config.maxSteps ?? 10;
    class AgentDO {
        /** @internal */ memory;
        /** @internal */ state;
        /** @internal */ episodic = null;
        /** @internal */ semantic = null;
        /** @internal */ env;
        constructor(ctx, env) {
            this.state = ctx;
            this.env = env;
            this.memory = new ThreadMemory(ctx.storage);
            // Initialize episodic memory if configured
            if (config.memory?.episodic?.enabled) {
                const dbBinding = config.memory.episodic.binding ?? 'DB';
                const db = this.env[dbBinding];
                if (db) {
                    this.episodic = new EpisodicMemory(db);
                }
                else {
                    console.warn(`[honi] Episodic memory enabled but D1 binding "${dbBinding}" not found. Falling back to DO-only memory.`);
                }
            }
            // Initialize semantic memory if configured
            if (config.memory?.semantic?.enabled) {
                const vecBinding = config.memory.semantic.binding ?? 'VECTORIZE';
                const aiBinding = config.memory.semantic.aiBinding ?? 'AI';
                const vec = this.env[vecBinding];
                const ai = this.env[aiBinding];
                if (vec && ai) {
                    this.semantic = new SemanticMemory(vec, ai);
                }
                else {
                    console.warn(`[honi] Semantic memory enabled but bindings "${vecBinding}" and/or "${aiBinding}" not found. Falling back to DO-only memory.`);
                }
            }
        }
        async fetch(request) {
            const threadId = request.headers.get('x-thread-id') ??
                new URL(request.url).searchParams.get('threadId') ??
                'default';
            if (request.method === 'GET') {
                const messages = await this.memory.load();
                return new Response(JSON.stringify({ messages }), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (request.method === 'DELETE') {
                await this.memory.clear();
                if (this.episodic) {
                    await this.episodic.clear(config.name, threadId);
                }
                return new Response(JSON.stringify({ ok: true }), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            // POST — chat
            const body = (await request.json());
            const model = resolveModel(config.model);
            const tools = config.tools?.length ? buildTools(config.tools) : undefined;
            // Load history: prefer episodic (D1) if available, else DO storage
            const episodicLimit = config.memory?.episodic?.limit ?? 50;
            let history = [];
            if (this.episodic) {
                history = await this.episodic.load(config.name, threadId, episodicLimit);
            }
            else if (config.memory?.enabled) {
                history = await this.memory.load();
            }
            // Semantic context: embed user message and search for relevant past context
            let systemPrompt = config.system ?? '';
            if (this.semantic) {
                const topK = config.memory?.semantic?.topK ?? 3;
                const results = await this.semantic.search(body.message, topK);
                if (results.length > 0) {
                    const contextLines = results.map((r) => `- ${r.text} (similarity: ${r.score.toFixed(2)})`);
                    const contextBlock = [
                        '[Relevant context from past conversations:]',
                        ...contextLines,
                        '[End of context]',
                        '',
                    ].join('\n');
                    systemPrompt = contextBlock + systemPrompt;
                }
            }
            const messages = [
                ...history,
                { role: 'user', content: body.message },
            ];
            const result = streamText({
                model,
                system: systemPrompt || undefined,
                messages,
                tools,
                maxSteps,
                onFinish: async ({ response }) => {
                    const newMessages = [
                        { role: 'user', content: body.message },
                        ...response.messages,
                    ];
                    // Save to DO working memory
                    if (config.memory?.enabled) {
                        await this.memory.append(newMessages);
                    }
                    // Save to D1 episodic memory
                    if (this.episodic) {
                        await this.episodic.append(config.name, threadId, newMessages);
                    }
                    // Upsert to Vectorize semantic memory
                    if (this.semantic) {
                        // Index the user message
                        await this.semantic.upsert(crypto.randomUUID(), body.message, { agent: config.name, thread: threadId, role: 'user' });
                        // Index assistant responses
                        for (const msg of response.messages) {
                            if (msg.role === 'assistant' && typeof msg.content === 'string') {
                                await this.semantic.upsert(crypto.randomUUID(), msg.content, { agent: config.name, thread: threadId, role: 'assistant' });
                            }
                        }
                    }
                },
            });
            return result.toDataStreamResponse();
        }
    }
    // Hono app for HTTP routing
    const app = new Hono();
    app.post('/chat', async (c) => {
        const env = c.env;
        const ns = env[binding];
        if (!ns) {
            return c.json({ error: `Missing Durable Object binding: "${binding}"` }, 500);
        }
        const threadId = c.req.header('x-thread-id') ?? 'default';
        const id = ns.idFromName(threadId);
        const stub = ns.get(id);
        return stub.fetch(c.req.raw);
    });
    app.get('/history', async (c) => {
        const env = c.env;
        const ns = env[binding];
        if (!ns) {
            return c.json({ error: `Missing Durable Object binding: "${binding}"` }, 500);
        }
        const threadId = c.req.query('threadId') ?? 'default';
        const id = ns.idFromName(threadId);
        const stub = ns.get(id);
        return stub.fetch(new Request('https://do/history'));
    });
    app.delete('/history', async (c) => {
        const env = c.env;
        const ns = env[binding];
        if (!ns) {
            return c.json({ error: `Missing Durable Object binding: "${binding}"` }, 500);
        }
        const threadId = c.req.query('threadId') ?? 'default';
        const id = ns.idFromName(threadId);
        const stub = ns.get(id);
        return stub.fetch(new Request('https://do/history', { method: 'DELETE' }));
    });
    const fetchHandler = (req, env, ctx) => app.fetch(req, env, ctx);
    return { fetch: fetchHandler, DurableObject: AgentDO };
}
//# sourceMappingURL=agent.js.map