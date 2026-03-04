# Example: Simple Agent

A minimal hello-world Honi agent. This is the simplest possible setup — a single agent with in-memory conversation history backed by a Durable Object.

## What it does

- Creates an agent with Durable Object working memory
- Exposes `/chat` (POST) and `/history` (GET) endpoints
- Streams responses using the Vercel AI SDK data protocol

## Setup

```bash
# Install dependencies
bun install

# Set your API key
wrangler secret put ANTHROPIC_API_KEY

# Start local dev server
bun run dev
```

## Usage

```bash
# Chat with the agent
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -H "X-Thread-Id: thread-1" \
  -d '{"message": "Hello! What can you help me with?"}'
```

## Deploy

```bash
bun run deploy
```

## Project structure

```
src/index.ts     # Agent definition and exports
wrangler.toml    # Cloudflare Worker + Durable Object config
package.json     # Dependencies
```
