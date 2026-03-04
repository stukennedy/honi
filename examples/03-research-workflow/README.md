# Example: Research Workflow

A multi-step research workflow that searches, analyses, and summarises results using Honi's workflow system built on [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

## How it works

The research workflow defines a durable, multi-step pipeline:

```
search → analyse → summarise
```

Each step runs as a separate Cloudflare Workflow step, which means:
- Steps are **durable** — if the Worker restarts mid-execution, the workflow resumes from the last completed step
- Steps can have **retries** with configurable backoff strategies
- Steps can have **timeouts** to prevent runaway execution

## Workflow steps

| Step | Config | Description |
| --- | --- | --- |
| `search` | 3 retries, exponential backoff | Fetches search results for a query |
| `analyse` | 60s timeout | Analyses and processes the raw results |
| `summarise` | default | Creates a final summary |

## Retry configuration

```typescript
step(
  { name: 'search', retries: { limit: 3, backoff: 'exponential' } },
  async (input, wfStep) => { ... }
)
```

- `limit` — max number of retry attempts
- `backoff` — `'exponential'` or `'linear'`

## Lifecycle hooks

- `onComplete(result)` — called when all steps finish successfully
- `onError(error)` — called if any step fails after exhausting retries

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
# Chat with the research agent
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -H "X-Thread-Id: thread-1" \
  -d '{"message": "Research the latest trends in edge computing"}'
```

## Deploy

```bash
bun run deploy
```
