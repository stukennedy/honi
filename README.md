# Honi

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Edge-first AI agents for Cloudflare Workers.**

> The Mastra for developers who deploy on Cloudflare.

Honi is a lightweight framework for building agentic AI applications on Cloudflare Workers. It combines [Hono](https://hono.dev) for routing, [Durable Objects](https://developers.cloudflare.com/durable-objects/) for persistent memory, and the [Vercel AI SDK](https://sdk.vercel.ai) for multi-provider LLM support — all in a single `createAgent()` call.

## Quick Start

### Install

```bash
bun add honidev
```

### Create an Agent

```typescript
// src/index.ts
import { createAgent, tool, z } from 'honidev';

const searchCRM = tool({
  name: 'search_crm',
  description: 'Search HubSpot for deal info',
  input: z.object({ query: z.string() }),
  handler: async ({ query }) => {
    // Your CRM logic here
    return { results: [] };
  },
});

const salesCoach = createAgent({
  name: 'sales-coach',
  model: 'claude-sonnet-4-5',
  memory: { enabled: true },
  tools: [searchCRM],
  system: 'You are a real-time sales coach.',
  binding: 'SALES_COACH_DO',
});

export default { fetch: salesCoach.fetch };
export const SalesCoachDO = salesCoach.DurableObject;
```

### Configure Wrangler

```toml
# wrangler.toml
name = "sales-coach-agent"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[[durable_objects.bindings]]
name = "SALES_COACH_DO"
class_name = "SalesCoachDO"

[[migrations]]
tag = "v1"
new_classes = ["SalesCoachDO"]
```

### Deploy

```bash
wrangler deploy
```

### Chat with Your Agent

```bash
curl -X POST https://your-worker.workers.dev/chat \
  -H "Content-Type: application/json" \
  -H "X-Thread-Id: thread-123" \
  -d '{"message": "What deals are closing this week?"}'
```

## Memory (Phase 2)

Honi supports four tiers of memory, all opt-in:

| Tier | Backing | Survives DO eviction? | Queryable across threads? |
| --- | --- | --- | --- |
| **Working** | Durable Object storage | No | No |
| **Episodic** | D1 | Yes | Yes |
| **Semantic** | Vectorize + Workers AI | Yes | Yes (similarity search) |
| **Graph** | [edgraph](https://github.com/stukennedy/edgraph) (DO) | Yes | Yes (entity/relationship traversal) |

### Setup

Add bindings to your `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "honi-memory"
database_id = "YOUR_DB_ID"

[[vectorize]]
binding = "VECTORIZE"
index_name = "honi-semantic"
dimensions = 768
metric = "cosine"

[ai]
binding = "AI"

# Graph memory — deploy edgraph and add a service binding (or use urlEnvVar for HTTP)
[[services]]
binding = "EDGRAPH"
service = "edgraph"
```

Run the D1 migration:

```bash
wrangler d1 migrations apply honi-memory
```

### Configure

```typescript
const agent = createAgent({
  name: 'my-agent',
  model: 'claude-sonnet-4-5',
  memory: {
    enabled: true,
    episodic: { enabled: true },
    semantic: { enabled: true, topK: 3 },
    graph: {
      enabled: true,
      graphId: 'my-knowledge-base',
      binding: 'EDGRAPH',       // CF service binding (preferred)
      // urlEnvVar: 'EDGRAPH_URL', // or HTTP URL via env var
      apiKeyEnvVar: 'EDGRAPH_API_KEY',
      contextDepth: 1,          // hop depth for context expansion
    },
  },
  system: 'You are a helpful assistant.',
});
```

All tiers are fully opt-in. Missing bindings log a warning and fall back gracefully.

### How it works

1. **On each request**: past messages load from D1 (episodic), the user message is embedded and searched against Vectorize (semantic), and any entity IDs found in semantic results are expanded via graph traversal. All context is prepended to the system prompt.
2. **After each response**: the conversation turn is saved to D1 and both user + assistant messages are embedded and upserted to Vectorize for future retrieval.

### Graph memory — writing entities from tools

Graph memory is most powerful when tools write entities as they discover them:

```typescript
import { tool, GraphMemory } from 'honidev';

const myTool = tool({
  name: 'lookup_customer',
  description: 'Look up a customer by ID',
  input: z.object({ customerId: z.string() }),
  handler: async (input, ctx) => {
    const customer = await db.getCustomer(input.customerId);

    // Write to graph — ctx.graph is the live GraphMemory instance
    if (ctx?.graph && customer) {
      await ctx.graph.upsertNode(customer.id, 'Customer', {
        name: customer.name,
        plan: customer.plan,
      });
      if (customer.accountManagerId) {
        await ctx.graph.upsertEdge(
          customer.id,
          customer.accountManagerId,
          'managed_by',
        );
      }
    }

    return customer;
  },
});
```

`ctx.graph` is the live `GraphMemory` instance bound to the current agent. Entities written here are immediately available for future context retrieval.

### Using GraphMemory standalone

`GraphMemory` can also be used outside of an agent — as a shared knowledge base across multiple services:

```typescript
import { GraphMemory } from 'honidev';

const graph = new GraphMemory({
  graphId: 'crm',
  url: 'https://edgraph.myapp.workers.dev',
  apiKey: process.env.EDGRAPH_API_KEY,
});

await graph.upsertNode('alice', 'Person', { role: 'CTO', company: 'ACME' });
await graph.upsertNode('acme', 'Company', { industry: 'SaaS' });
await graph.upsertEdge('alice', 'acme', 'works_at');

// Get context block for LLM injection
const context = await graph.toContext(['alice'], 2);
// "[Knowledge graph context:]
//  - (Person:alice) {role="CTO", company="ACME"}
//    → [works_at] → (Company:acme)
//  [End graph context]"

// Traversal
const path = await graph.shortestPath('alice', 'bob');
const neighbours = await graph.getNeighbours('alice', 'out', ['manages']);
```

## Core Concepts

### Agents

An agent is created with `createAgent()` and bundles:

- A **Hono-powered HTTP API** with `/chat`, `/history` routes
- A **Durable Object class** for persistent, per-thread state
- An **LLM connection** with automatic tool-calling loops and streaming

### Tools

Define tools with Zod schemas. Honi auto-generates the JSON schema for the LLM and validates inputs at runtime:

```typescript
const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  input: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  handler: async ({ city, units }) => {
    return { temp: 22, city, units };
  },
});
```

### Memory

When `memory: { enabled: true }`, conversation history is persisted in Durable Object storage. Each thread (identified by `X-Thread-Id` header) gets its own isolated memory.

- `POST /chat` — send a message, get a streaming response
- `GET /history?threadId=xxx` — retrieve conversation history
- `DELETE /history?threadId=xxx` — clear a thread's history

### Supported Models

Honi uses the Vercel AI SDK under the hood. Model routing is automatic based on the model ID prefix:

| Model prefix | Provider | Required binding / env |
| --- | --- | --- |
| `claude-*` | Anthropic | `ANTHROPIC_API_KEY` env var |
| `gpt-*` | OpenAI | `OPENAI_API_KEY` env var |
| `@cf/*` | Workers AI | `AI` binding in wrangler.toml |

Set API keys as Cloudflare Worker secrets:

```bash
wrangler secret put ANTHROPIC_API_KEY
```

#### Workers AI

Use any [Workers AI model](https://developers.cloudflare.com/workers-ai/models/) by prefixing with `@cf/`:

```toml
# wrangler.toml
[ai]
binding = "AI"
```

```typescript
const agent = createAgent({
  name: 'my-agent',
  model: '@cf/meta/llama-3.1-8b-instruct',  // Uses Workers AI
  system: 'You are a helpful assistant.',
});
```

Workers AI support requires the optional `@ai-sdk/cloudflare` package:

```bash
npm install @ai-sdk/cloudflare
```

#### AI Gateway

Route all LLM calls through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for logging, rate limiting, and caching at the edge:

```typescript
const agent = createAgent({
  name: 'my-agent',
  model: 'claude-sonnet-4-5',
  observability: {
    aiGateway: {
      accountId: 'your-account-id',
      gatewayId: 'your-gateway-id',
    },
  },
  system: 'You are a helpful assistant.',
});
// All LLM calls now route through CF AI Gateway for observability
```

### Streaming

All responses stream via the AI SDK data protocol, compatible with the `useChat()` hook from `ai/react`:

```typescript
import { useChat } from 'ai/react';

const { messages, input, handleSubmit } = useChat({
  api: 'https://your-worker.workers.dev/chat',
  headers: { 'X-Thread-Id': 'thread-123' },
});
```

## Comparison

| Feature         | Honi                 | Mastra           | LangChain  |
| --------------- | -------------------- | ---------------- | ---------- |
| **Runtime**     | Cloudflare Workers   | Node.js          | Node.js    |
| **Memory**      | Durable Objects      | Postgres / Redis | Various    |
| **Streaming**   | SSE (AI SDK)         | SSE              | Callbacks  |
| **Deploy**      | `wrangler deploy`    | Self-host        | Self-host  |
| **Cold start**  | ~0 ms (edge)         | Seconds          | Seconds    |
| **Bundle size** | Minimal              | Heavy            | Heavy      |
| **Tool system** | Zod-native           | Zod-native       | Mixed      |
| **Framework**   | Hono                 | Express / Hono   | Custom     |

## Examples

Ready-to-deploy example projects in the [`examples/`](./examples) directory:

| Example | Description |
| --- | --- |
| [`01-simple-agent`](./examples/01-simple-agent) | Minimal hello-world agent with Durable Object memory |
| [`02-rag-agent`](./examples/02-rag-agent) | Full tiered memory — episodic (D1) + semantic RAG (Vectorize) |
| [`03-research-workflow`](./examples/03-research-workflow) | Multi-step research pipeline using Cloudflare Workflows |

Each example includes a `wrangler.toml`, `package.json`, and README with setup instructions.

## Workflows (Phase 3)

Honi wraps [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) with a simple `workflow()` + `step()` API for durable, multi-step agent pipelines.

```typescript
import { workflow, step } from 'honidev';

const IngestWorkflow = workflow({
  steps: [
    step({ name: 'fetch-data', retries: { limit: 3, backoff: 'exponential' } }, async (input, step) => {
      const res = await fetch(input.url);
      return res.json();
    }),
    step({ name: 'process', timeout: '60s' }, async (data, step) => {
      return { processed: true, items: data.length };
    }),
  ],
  onComplete: async (result, env) => {
    console.log('Pipeline complete:', result);
  },
  onError: async (error, env) => {
    console.error('Pipeline failed:', error.message);
  },
});

export { IngestWorkflow };
```

Add to `wrangler.toml`:

```toml
[[workflows]]
name = "ingest-workflow"
binding = "INGEST_WORKFLOW"
class_name = "IngestWorkflow"
```

## CLI (Phase 4)

Honi includes a CLI for scaffolding and managing projects.

```bash
# Install globally
npm install -g honidev

# Create a new project
honi new my-sales-coach

# Start local dev server
honi dev

# Deploy to Cloudflare Workers
honi deploy
```

`honi new` generates a ready-to-run project with `src/index.ts`, `wrangler.toml`, `tsconfig.json`, and `package.json`.

## Observability (Phase 5)

Honi emits structured events for every agent request, tool call, memory operation, and workflow step.

### Configuration

```typescript
const agent = createAgent({
  name: 'my-agent',
  model: 'claude-sonnet-4-5',
  observability: {
    logLevel: 'debug',
    onEvent: (event) => {
      // Send to your logging/analytics service
      console.log(event.type, event.durationMs);
    },
    aiGateway: {
      accountId: 'your-cf-account-id',
      gatewayId: 'your-gateway-id',
    },
  },
});
```

### Event Types

| Event | Emitted When |
| --- | --- |
| `agent.request` | Incoming chat request |
| `agent.response` | Response stream complete |
| `tool.call` | Tool execution starts |
| `tool.result` | Tool execution finishes |
| `memory.load` | Memory loaded from storage |
| `memory.save` | Memory persisted |
| `workflow.start` | Workflow begins |
| `workflow.step` | Workflow step executes |
| `workflow.complete` | Workflow finishes |
| `workflow.error` | Workflow errors |

### AI Gateway

Set `observability.aiGateway` to route LLM calls through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for logging, rate limiting, and caching at the edge.

## API Reference

### `createAgent(config)`

| Option     | Type                  | Default           | Description                                |
| ---------- | --------------------- | ----------------- | ------------------------------------------ |
| `name`     | `string`              | —                 | Agent name                                 |
| `model`    | `string`              | —                 | Model ID (`claude-sonnet-4-5`, `gpt-4o`)   |
| `system`   | `string`              | —                 | System prompt                              |
| `memory`   | `MemoryConfig`        | `{}`                 | Memory configuration (see Phase 2)      |
| `tools`    | `ToolDefinition[]`    | `[]`              | Agent tools                                |
| `binding`  | `string`              | `"AGENT"`         | Durable Object binding name                |
| `maxSteps` | `number`              | `10`              | Max tool-calling loop iterations           |

Returns `{ fetch, DurableObject }`.

### `tool(config)`

| Option        | Type                          | Description              |
| ------------- | ----------------------------- | ------------------------ |
| `name`        | `string`                      | Tool name (sent to LLM)  |
| `description` | `string`                      | What the tool does        |
| `input`       | `ZodType`                     | Zod schema for tool input |
| `handler`     | `(input) => Promise<unknown>` | Tool implementation       |

## License

MIT

## Bundle Size

Honi is designed to fit comfortably within Cloudflare Workers' limits:

| Component | Size |
|-----------|------|
| Honi library (dist/) | ~30 KB |
| Full demo app (with AI SDK) | 691 KB uncompressed |
| **Gzip compressed** | **123 KB** |
| **CF Workers limit** | **1 MB compressed** |

You're using ~12% of the limit with a full-featured agent including all AI SDK providers.

### Optimization Tips

- Only import the providers you need (`@ai-sdk/anthropic` OR `@ai-sdk/openai`, not both)
- Use Workers AI (`@cf/` models) to skip external provider SDKs entirely
- Tree-shaking works — unused features don't add to bundle size

## MCP Server

Honi agents can expose their tools as MCP endpoints, allowing connection from Claude Desktop, Cursor, and other MCP-compatible clients.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | JSON-RPC 2.0 MCP endpoint |
| `/mcp/tools` | GET | List available tools (convenience) |

### Authentication

For remote connections (Cursor, custom clients, any non-local use) you should lock down `/mcp` with a Bearer token. Set `mcp.secretEnvVar` in your agent config:

```typescript
const agent = createAgent({
  name: 'my-agent',
  model: 'claude-sonnet-4-5',
  tools: [searchDocs],
  mcp: { secretEnvVar: 'MCP_SECRET' },
})
```

Then set the secret via Wrangler:

```bash
wrangler secret put MCP_SECRET
```

Clients send `Authorization: Bearer <secret>` on every request. If `secretEnvVar` is not set, `/mcp` is unauthenticated — fine for local Claude Desktop (stdio transport), but don't expose it publicly without this.

### Example: Connect from Claude Desktop

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "my-honi-agent": {
      "url": "https://my-agent.workers.dev/mcp"
    }
  }
}
```

For authenticated remote connections:

```json
{
  "mcpServers": {
    "my-honi-agent": {
      "url": "https://my-agent.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-here"
      }
    }
  }
}
```

## Multi-Agent Orchestration

Honi supports agent-to-agent communication for building complex agentic workflows.

```typescript
import { routeToAgent, callAgentTool, listAgentTools } from 'honidev';

// Send a message to another agent
const response = await routeToAgent(env, { binding: 'OTHER_AGENT' }, 'Hello!');

// Call a specific tool on another agent
const result = await callAgentTool(env, { binding: 'OTHER_AGENT' }, 'search', { query: 'test' });

// List available tools from another agent
const tools = await listAgentTools(env, { binding: 'OTHER_AGENT' });
```

### wrangler.toml Setup

```toml
[[durable_objects.bindings]]
name = "MY_AGENT"
class_name = "MyAgentDO"

[[durable_objects.bindings]]
name = "OTHER_AGENT"
class_name = "OtherAgentDO"
```
