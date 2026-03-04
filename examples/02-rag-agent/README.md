# Example: RAG Agent

An agent with full tiered memory — Durable Object working memory, D1 episodic history, and Vectorize semantic search (RAG).

## Memory tiers

| Tier | Backing | Purpose |
| --- | --- | --- |
| **Working** | Durable Object | In-flight conversation state (auto-enabled) |
| **Episodic** | D1 | Persistent conversation history across sessions |
| **Semantic** | Vectorize + Workers AI | Similarity search over all past messages |

## How RAG injection works

1. **On each request**: the user's message is embedded via Workers AI and searched against the Vectorize index. The top-K most relevant past messages are prepended to the system prompt as context.
2. **After each response**: both the user message and assistant reply are embedded and upserted into Vectorize for future retrieval.
3. The full conversation history (up to `limit`) is also loaded from D1 for episodic continuity.

This means the agent automatically recalls relevant information from any previous conversation, even across different threads.

## Setup

```bash
# Install dependencies
bun install

# Create D1 database
wrangler d1 create honi-memory
# Update wrangler.toml with the returned database_id

# Run D1 migration (creates honi_messages table)
wrangler d1 migrations apply honi-memory

# Create Vectorize index
wrangler vectorize create honi-semantic --dimensions=768 --metric=cosine

# Set your API key
wrangler secret put ANTHROPIC_API_KEY

# Start local dev server
bun run dev
```

## Usage

```bash
# Tell the agent something to remember
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -H "X-Thread-Id: thread-1" \
  -d '{"message": "Remember that my favourite colour is blue."}'

# Later, in a different thread, it can recall via semantic search
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -H "X-Thread-Id: thread-2" \
  -d '{"message": "What is my favourite colour?"}'
```

## Deploy

```bash
bun run deploy
```
