# Honi

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Edge-first AI agents for Cloudflare Workers.**

> The Mastra for developers who deploy on Cloudflare.

Honi is a lightweight framework for building agentic AI applications on Cloudflare Workers. It combines [Hono](https://hono.dev) for routing, [Durable Objects](https://developers.cloudflare.com/durable-objects/) for persistent memory, and the [Vercel AI SDK](https://sdk.vercel.ai) for multi-provider LLM support — all in a single `createAgent()` call.

## Quick Start

### Install

```bash
bun add honi
```

### Create an Agent

```typescript
// src/index.ts
import { createAgent, tool, z } from '@stukennedy/honi';

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

Honi supports three tiers of memory, all opt-in:

| Tier | Backing | Survives DO eviction? | Queryable across threads? |
| --- | --- | --- | --- |
| **Working** | Durable Object storage | No | No |
| **Episodic** | D1 | Yes | Yes |
| **Semantic** | Vectorize + Workers AI | Yes | Yes (similarity search) |

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
    enabled: true,              // DO working memory
    episodic: { enabled: true },        // D1 conversation history
    semantic: { enabled: true, topK: 3 }, // Vectorize RAG context
  },
  system: 'You are a helpful assistant.',
});
```

Episodic and semantic memory are fully opt-in. If the required bindings are missing, Honi logs a warning and falls back to DO-only memory.

### How it works

1. **On each request**: past messages load from D1 (episodic) and the user message is embedded and searched against Vectorize (semantic). Top-K relevant results are prepended to the system prompt.
2. **After each response**: the conversation turn is saved to D1 and both user + assistant messages are embedded and upserted to Vectorize for future retrieval.

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

### Multi-Provider LLM Support

Honi uses the Vercel AI SDK under the hood. Model routing is automatic:

| Model ID   | Provider  |
| ---------- | --------- |
| `claude-*` | Anthropic |
| `gpt-*`    | OpenAI    |

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your Cloudflare Worker secrets:

```bash
wrangler secret put ANTHROPIC_API_KEY
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
import { workflow, step } from '@stukennedy/honi';

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
npm install -g @stukennedy/honi

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
