import { Hono } from 'hono';
import {
  streamText,
  type CoreMessage,
  type LanguageModel,
  type ToolCallRepairFunction,
  type ToolSet,
} from 'ai';
import { resolveModel } from './providers.js';
import { ThreadMemory } from './memory.js';
import { EpisodicMemory } from './episodic.js';
import { SemanticMemory } from './semantic.js';
import { GraphMemory } from './graph.js';
import { RecursiveMemory } from './recursive.js';
import { ObservabilityCollector } from './observability.js';
import { createMcpServer } from './mcp.js';
import { buildToolRuntime, formatToolError } from './tool-runtime.js';
import type { AgentConfig, ToolContext } from './types.js';

/**
 * Anthropic's cache marker. The provider accepts `cacheControl` or
 * `cache_control` under its own namespace; every other provider ignores a
 * namespace it doesn't recognise, so this is inert for them.
 */
const ANTHROPIC_CACHE_MARK = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const;

/** `cache: true` means both breakpoints; an object opts out per breakpoint. */
function resolveCache(cache: AgentConfig['cache']): { system: boolean; history: boolean } {
  if (!cache) return { system: false, history: false };
  if (cache === true) return { system: true, history: true };
  return { system: cache.system !== false, history: cache.history !== false };
}

/**
 * Assemble a turn's prompt, placing Anthropic cache breakpoints when asked.
 *
 * Returns `system` separately from `messages` because the two are mutually
 * exclusive: caching the system prompt REQUIRES carrying it as a message (the
 * provider reads cache control off `providerOptions`, and a top-level `system`
 * string has nowhere to put it), while leaving caching off must reproduce the
 * previous shape byte-for-byte. `system: undefined` means "it's in `messages`".
 *
 * Exported for tests — the placement of breakpoints is the whole behaviour, and
 * it is worth asserting without standing up a Durable Object.
 */
export function buildPrompt(input: {
  systemPrompt: string;
  history: CoreMessage[];
  message: string;
  cache: AgentConfig['cache'];
}): { messages: CoreMessage[]; system: string | undefined } {
  const cache = resolveCache(input.cache);

  const turn: CoreMessage[] = [
    ...input.history,
    { role: 'user' as const, content: input.message },
  ];

  // Breakpoint 2 — the conversation prefix up to, but NOT including, this
  // turn's user message. Marking the last message of `history` is what makes
  // the cache compound: this turn reads what the previous turn wrote, and
  // writes one covering itself for the next. Marking the new user message
  // instead would write a cache nothing ever reads.
  if (cache.history && input.history.length > 0) {
    const prefixEnd = turn.length - 2;
    turn[prefixEnd] = {
      ...turn[prefixEnd],
      providerOptions: ANTHROPIC_CACHE_MARK,
    } as CoreMessage;
  }

  // Breakpoint 1 — tools + system, the stable bulk of the prompt. Anthropic
  // serialises tools ahead of system, so this single breakpoint covers both.
  if (input.systemPrompt && cache.system) {
    return {
      messages: [
        {
          role: 'system' as const,
          content: input.systemPrompt,
          providerOptions: ANTHROPIC_CACHE_MARK,
        },
        ...turn,
      ],
      system: undefined,
    };
  }

  return { messages: turn, system: input.systemPrompt || undefined };
}

/** Assemble cache-sensitive stream inputs without cloning their stable references. */
export function buildAgentStreamOptions<TOOLS extends ToolSet>(input: {
  model: LanguageModel;
  system: string | undefined;
  messages: CoreMessage[];
  tools: TOOLS | undefined;
  repairToolCall: ToolCallRepairFunction<TOOLS> | undefined;
  maxSteps: number;
}) {
  return {
    model: input.model,
    ...(input.system === undefined ? {} : { system: input.system }),
    messages: input.messages,
    tools: input.tools,
    maxSteps: input.maxSteps,
    experimental_repairToolCall: input.repairToolCall,
  };
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
    /** Graph memory — also accessible from tool handlers via ToolContext. */
    graph: GraphMemory | null = null;
    /** @internal */ recursive: RecursiveMemory | null = null;
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

      // Initialize graph memory if configured
      if (config.memory?.graph?.enabled) {
        const graphCfg = config.memory.graph;
        const apiKey = graphCfg.apiKeyEnvVar
          ? (this.env[graphCfg.apiKeyEnvVar] as string | undefined)
          : undefined;

        if (graphCfg.binding) {
          // Service binding: CF-internal, zero-latency
          const fetcher = this.env[graphCfg.binding] as { fetch: (req: Request) => Promise<Response> } | undefined;
          if (fetcher) {
            this.graph = new GraphMemory({ graphId: graphCfg.graphId, fetcher, apiKey });
          } else {
            console.warn(
              `[honi] Graph memory enabled but service binding "${graphCfg.binding}" not found.`,
            );
          }
        } else if (graphCfg.urlEnvVar) {
          // HTTP transport
          const url = this.env[graphCfg.urlEnvVar] as string | undefined;
          if (url) {
            this.graph = new GraphMemory({ graphId: graphCfg.graphId, url, apiKey });
          } else {
            console.warn(
              `[honi] Graph memory enabled but env var "${graphCfg.urlEnvVar}" not found.`,
            );
          }
        } else {
          console.warn(
            '[honi] Graph memory enabled but neither "binding" nor "urlEnvVar" is configured.',
          );
        }
      }

      // Initialize recursive (RLM) memory if configured
      // Uses DO storage directly — no extra binding needed.
      if (config.memory?.recursive?.enabled) {
        this.recursive = new RecursiveMemory(ctx.storage, config.memory.recursive);
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
        // Recursive memory uses DO storage — cleared automatically with memory.clear()
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

      // Route through Cloudflare AI Gateway if configured.
      // Top-level aiGateway wins over the legacy observability.aiGateway shape.
      const gateway = config.aiGateway ?? config.observability?.aiGateway;
      const model = await resolveModel(config.model, {
        env: this.env,
        gateway,
        headers: config.providerHeaders,
      });

      // Build tool context (graph + recursive + env available to all tool handlers)
      const toolCtx: ToolContext = {
        graph: this.graph ?? undefined,
        recursive: this.recursive ?? undefined,
        env: this.env,
      };
      const toolRuntime = config.tools?.length
        ? buildToolRuntime({
            definitions: config.tools,
            context: toolCtx,
            model,
            collector,
            agentName: config.name,
            threadId,
          })
        : undefined;
      const tools = toolRuntime?.tools;

      // Load history: prefer episodic (D1) if available, else DO storage
      const episodicLimit = config.memory?.episodic?.limit ?? 50;
      let history: CoreMessage[] = [];
      if (this.episodic) {
        history = await this.episodic.load(config.name, threadId, episodicLimit);
      } else if (config.memory?.enabled) {
        history = await this.memory.load();
      }

      // Build system prompt with layered memory context
      let systemPrompt = config.system ?? '';

      // Semantic context: embed user message and search for relevant past episodes
      let semanticEntityIds: string[] = [];
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

          // Collect entity IDs from semantic result metadata for graph expansion
          semanticEntityIds = results
            .flatMap((r) => [r.metadata?.entityId, r.metadata?.nodeId])
            .filter((id): id is string => typeof id === 'string');
        }
      }

      // Recursive (RLM) memory: run the REPL loop if enabled.
      // The loop runs before the final streamText call and injects its
      // reasoned answer as additional context into the system prompt.
      if (this.recursive) {
        const recursiveCfg = config.memory?.recursive;
        try {
          const rlmResult = await this.recursive.runLoop(
            body.message,
            model,
            systemPrompt,
            recursiveCfg?.maxDepth,
            recursiveCfg?.timeoutMs,
          );
          if (rlmResult.answer) {
            const rlmContext = [
              '[Document research result — ' + rlmResult.iterations + ' iterations, '
                + rlmResult.chunksRead.length + ' chunks read:]',
              rlmResult.answer,
              '[End of research]',
              '',
            ].join('\n');
            systemPrompt = rlmContext + systemPrompt;
          }
        } catch (err) {
          console.warn('[honi] RLM loop failed — falling back to direct response:', (err as Error).message);
        }
      }

      // Graph context: expand semantic hits + any entity IDs in the user message metadata
      // Graph context is prepended before semantic context so it appears earliest in the prompt
      if (this.graph) {
        const graphCfg = config.memory?.graph;
        const maxEntities = graphCfg?.maxContextEntities ?? 5;
        const contextDepth = graphCfg?.contextDepth ?? 1;

        // Limit how many entities we expand to avoid token blowout
        const entityIds = semanticEntityIds.slice(0, maxEntities);
        if (entityIds.length > 0) {
          const graphContext = await this.graph.toContext(entityIds, contextDepth);
          if (graphContext) {
            systemPrompt = graphContext + '\n\n' + systemPrompt;
          }
        }
      }

      const { messages, system } = buildPrompt({
        systemPrompt,
        history,
        message: body.message,
        cache: config.cache,
      });

      const result = streamText({
        ...buildAgentStreamOptions({
          model,
          system,
          messages,
          tools,
          repairToolCall: toolRuntime?.repairToolCall,
          maxSteps,
        }),
        onFinish: async ({ response, usage, finishReason, providerMetadata }) => {
          if (collector) {
            collector.emit({
              type: 'agent.response',
              agentName: config.name,
              threadId,
              timestamp: Date.now(),
              durationMs: Date.now() - requestStart,
              // Token usage for cost telemetry. `usage` is the AI SDK's
              // promptTokens/completionTokens; `providerMetadata` carries the
              // provider-specific buckets (e.g. Anthropic prompt-cache reads/
              // writes, which are billed at different rates). Without these the
              // agent's spend is invisible to the consumer.
              metadata: {
                model: config.model,
                usage,
                finishReason,
                providerMetadata,
              },
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

          // Recursive memory stores its documents in DO storage;
          // no per-turn bookkeeping needed in onFinish.
        },
      });

      return result.toDataStreamResponse({ getErrorMessage: formatToolError });
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
    // Auth: check Bearer token if secretEnvVar is configured
    if (config.mcp?.secretEnvVar) {
      const env = c.env as Record<string, unknown>;
      const secret = env[config.mcp.secretEnvVar] as string | undefined;
      if (secret) {
        const authHeader = c.req.header('Authorization') ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (token !== secret) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      } else {
        console.warn(`[honi] mcp.secretEnvVar "${config.mcp.secretEnvVar}" is set but env var not found — MCP endpoint is unauthenticated`);
      }
    }

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
