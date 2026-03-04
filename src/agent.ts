import { Hono } from 'hono';
import { streamText, tool as aiTool, type CoreMessage } from 'ai';
import { resolveModel } from './providers.js';
import { ThreadMemory } from './memory.js';
import type { AgentConfig, ToolDefinition } from './types.js';

function buildTools(tools: ToolDefinition[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: Record<string, any> = {};
  for (const t of tools) {
    result[t.name] = aiTool({
      description: t.description,
      parameters: t.input,
      execute: async (args) => t.handler(args),
    });
  }
  return result;
}

export function createAgent(config: AgentConfig) {
  const binding = config.binding ?? 'AGENT';
  const maxSteps = config.maxSteps ?? 10;

  class AgentDO implements DurableObject {
    /** @internal */ memory: ThreadMemory;
    /** @internal */ state: DurableObjectState;

    constructor(ctx: DurableObjectState, _env: unknown) {
      this.state = ctx;
      this.memory = new ThreadMemory(ctx.storage);
    }

    async fetch(request: Request): Promise<Response> {
      if (request.method === 'GET') {
        const messages = await this.memory.load();
        return new Response(JSON.stringify({ messages }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      if (request.method === 'DELETE') {
        await this.memory.clear();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      // POST — chat
      const body = (await request.json()) as { message: string };
      const model = resolveModel(config.model);
      const tools = config.tools?.length ? buildTools(config.tools) : undefined;
      const history = config.memory?.enabled ? await this.memory.load() : [];

      const messages: CoreMessage[] = [
        ...history,
        { role: 'user' as const, content: body.message },
      ];

      const result = streamText({
        model,
        system: config.system,
        messages,
        tools,
        maxSteps,
        onFinish: async ({ response }) => {
          if (config.memory?.enabled) {
            await this.memory.append([
              { role: 'user' as const, content: body.message },
              ...(response.messages as CoreMessage[]),
            ]);
          }
        },
      });

      return result.toDataStreamResponse();
    }
  }

  // Hono app for HTTP routing
  const app = new Hono();

  app.post('/chat', async (c) => {
    const env = c.env as Record<string, DurableObjectNamespace>;
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
    const env = c.env as Record<string, DurableObjectNamespace>;
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
    const env = c.env as Record<string, DurableObjectNamespace>;
    const ns = env[binding];
    if (!ns) {
      return c.json({ error: `Missing Durable Object binding: "${binding}"` }, 500);
    }
    const threadId = c.req.query('threadId') ?? 'default';
    const id = ns.idFromName(threadId);
    const stub = ns.get(id);
    return stub.fetch(new Request('https://do/history', { method: 'DELETE' }));
  });

  const fetchHandler: ExportedHandlerFetchHandler = (req, env, ctx) =>
    app.fetch(req, env, ctx);

  return { fetch: fetchHandler, DurableObject: AgentDO };
}
