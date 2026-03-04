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
import { createAgent, tool, z } from 'honi';

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

## API Reference

### `createAgent(config)`

| Option     | Type                  | Default           | Description                                |
| ---------- | --------------------- | ----------------- | ------------------------------------------ |
| `name`     | `string`              | —                 | Agent name                                 |
| `model`    | `string`              | —                 | Model ID (`claude-sonnet-4-5`, `gpt-4o`)   |
| `system`   | `string`              | —                 | System prompt                              |
| `memory`   | `{ enabled: boolean }`| `{ enabled: false }` | Enable DO-backed memory                 |
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
