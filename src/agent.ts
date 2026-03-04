import { Hono } from 'hono';
import { streamText, tool as aiTool, type CoreMessage } from 'ai';
import { resolveModel } from './providers.js';
import { ThreadMemory } from './memory.js';
import { EpisodicMemory } from './episodic.js';
import { SemanticMemory } from './semantic.js';
import { ObservabilityCollector } from './observability.js';
import { createMcpServer } from './mcp.js';
import type { AgentConfig, ToolDefinition } from './types.js';

function buildTools(tools: ToolDefinition[], collector?: ObservabilityCollector, agentName?: string, threadId?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: Record<string, any> = {};
  for (const t of tools) {
    result[t.name] = aiTool({
      description: t.description,
      parameters: t.input,
      execute: async (args) => {
        if (collector) {
          const start = Date.now();
          collector.emit({
            type: 'tool.call',
            agentName: agentName!,
            threadId,
            timestamp: start,
            metadata: { tool: t.name, args },
          });
          try {
            const toolResult = await t.handler(args);
            collector.emit({
              type: 'tool.result',
              agentName: agentName!,
              threadId,
              timestamp: Date.now(),
              durationMs: Date.now() - start,
              metadata: { tool: t.name },
            });
            return toolResult;
          } catch (err) {
            collector.emit({
              type: 'tool.result',
              agentName: agentName!,
              threadId,
              timestamp: Date.now(),
              durationMs: Date.now() - start,
              metadata: { tool: t.name },
              error: (err as Error).message,
            });
            throw err;
          }
        }
        return t.handler(args);
      },
    });
  }
  return result;
}

export function createAgent(config: AgentConfig) {
  const binding = config.binding ?? 'AGENT';
  const maxSteps = config.maxSteps ?? 10;

  // Create observability collector if configured
  const collector = config.observability
    ? new ObservabilityCollector(config.observability)
    : undefined;

  class AgentDO implements DurableObject {
    /** @internal */ memory: ThreadMemory;
    /** @internal */ state: DurableObjectState;
    /** @internal */ episodic: EpisodicMemory | null = null;
    /** @internal */ semantic: SemanticMemory | null = null;
    /** @internal */ env: Record<string, unknown>;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.state = ctx;
      this.env = env as Record<string, unknown>;
      this.memory = new ThreadMemory(ctx.storage);

      // Initialize episodic memory if configured
      if (config.memory?.episodic?.enabled) {
        const dbBinding = config.memory.episodic.binding ?? 'DB';
        const db = this.env[dbBinding] as D1Database | undefined;
        if (db) {
          this.episodic = new EpisodicMemory(db);
        } else {
          console.warn(
            `[honi] Episodic memory enabled but D1 binding "${dbBinding}" not found. Falling back to DO-only memory.`,
          );
        }
      }

      // Initialize semantic memory if configured
      if (config.memory?.semantic?.enabled) {
        const vecBinding = config.memory.semantic.binding ?? 'VECTORIZE';
        const aiBinding = config.memory.semantic.aiBinding ?? 'AI';
        const vec = this.env[vecBinding] as VectorizeIndex | undefined;
        const ai = this.env[aiBinding] as Ai | undefined;
        if (vec && ai) {
          this.semantic = new SemanticMemory(vec, ai);
        } else {
          console.warn(
            `[honi] Semantic memory enabled but bindings "${vecBinding}" and/or "${aiBinding}" not found. Falling back to DO-only memory.`,
          );
        }
      }
    }

    async fetch(request: Request): Promise<Response> {
      const threadId =
        request.headers.get('x-thread-id') ??
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

      // POST /mcp — MCP server endpoint
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname.endsWith('/mcp')) {
        const mcpServer = createMcpServer(config.tools ?? []);
        return mcpServer.handleHttp(request);
      }

      // POST — chat
      const requestStart = Date.now();
      const body = (await request.json()) as { message: string };

      if (collector) {
        collector.emit({
          type: 'agent.request',
          agentName: config.name,
          threadId,
          timestamp: requestStart,
          metadata: { messageLength: body.message.length },
        });
      }

      // Resolve AI Gateway URL if configured
      let gatewayUrl: string | undefined;
      if (collector) {
        if (config.model.startsWith('claude-')) {
          gatewayUrl = collector.getAiGatewayUrl('anthropic');
        } else if (config.model.startsWith('gpt-')) {
          gatewayUrl = collector.getAiGatewayUrl('openai');
        }
      }

      const model = await resolveModel(config.model, { env: this.env, gatewayUrl });
      const tools = config.tools?.length
        ? buildTools(config.tools, collector, config.name, threadId)
        : undefined;

      // Load history: prefer episodic (D1) if available, else DO storage
      const episodicLimit = config.memory?.episodic?.limit ?? 50;
      let history: CoreMessage[] = [];
      if (this.episodic) {
        history = await this.episodic.load(config.name, threadId, episodicLimit);
      } else if (config.memory?.enabled) {
        history = await this.memory.load();
      }

      // Semantic context: embed user message and search for relevant past context
      let systemPrompt = config.system ?? '';
      if (this.semantic) {
        const topK = config.memory?.semantic?.topK ?? 3;
        const results = await this.semantic.search(body.message, topK);
        if (results.length > 0) {
          const contextLines = results.map(
            (r) => `- ${r.text} (similarity: ${r.score.toFixed(2)})`,
          );
          const contextBlock = [
            '[Relevant context from past conversations:]',
            ...contextLines,
            '[End of context]',
            '',
          ].join('\n');
          systemPrompt = contextBlock + systemPrompt;
        }
      }

      const messages: CoreMessage[] = [
        ...history,
        { role: 'user' as const, content: body.message },
      ];

      const result = streamText({
        model,
        system: systemPrompt || undefined,
        messages,
        tools,
        maxSteps,
        onFinish: async ({ response }) => {
          if (collector) {
            collector.emit({
              type: 'agent.response',
              agentName: config.name,
              threadId,
              timestamp: Date.now(),
              durationMs: Date.now() - requestStart,
            });
          }

          const newMessages: CoreMessage[] = [
            { role: 'user' as const, content: body.message },
            ...(response.messages as CoreMessage[]),
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
            await this.semantic.upsert(
              crypto.randomUUID(),
              body.message,
              { agent: config.name, thread: threadId, role: 'user' },
            );
            // Index assistant responses
            for (const msg of response.messages) {
              if (msg.role === 'assistant' && typeof msg.content === 'string') {
                await this.semantic.upsert(
                  crypto.randomUUID(),
                  msg.content,
                  { agent: config.name, thread: threadId, role: 'assistant' },
                );
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

  // MCP Server endpoint — exposes agent tools to MCP clients
  app.post('/mcp', async (c) => {
    const env = c.env as Record<string, DurableObjectNamespace>;
    const ns = env[binding];
    if (!ns) {
      return c.json({ error: `Missing Durable Object binding: "${binding}"` }, 500);
    }
    const threadId = c.req.header('x-thread-id') ?? c.req.query('threadId') ?? 'default';
    const id = ns.idFromName(threadId);
    const stub = ns.get(id);
    return stub.fetch(new Request('https://do/mcp', { 
      method: 'POST', 
      body: await c.req.text(),
      headers: { 'content-type': 'application/json' }
    }));
  });

  // MCP tools list (convenience GET endpoint)
  app.get('/mcp/tools', async (c) => {
    const mcpServer = createMcpServer(config.tools ?? []);
    return c.json({ tools: mcpServer.tools });
  });

  const fetchHandler: ExportedHandlerFetchHandler = (req, env, ctx) =>
    app.fetch(req, env, ctx);

  return { fetch: fetchHandler, DurableObject: AgentDO };
}
