import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createAgent } from '../src/agent.js';
import { tool } from '../src/tool.js';

/**
 * Both MCP surfaces honour the bearer secret. GET /mcp/tools used to be an
 * unauthenticated "convenience" route — but tool names, descriptions, and
 * schemas are a map of the agent's capabilities, not public metadata.
 */

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function makeAgent(withSecret: boolean) {
  return createAgent({
    name: 'auth-agent',
    model: 'claude-haiku-4-5',
    tools: [
      tool({
        name: 'secretCapability',
        description: 'Internal capability',
        input: z.object({}),
        handler: async () => 'ok',
      }),
    ],
    ...(withSecret ? { mcp: { secretEnvVar: 'MCP_SECRET' } } : {}),
  });
}

const request = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://worker${path}`, { headers });

describe('GET /mcp/tools bearer auth', () => {
  it('rejects requests without the bearer token', async () => {
    const agent = makeAgent(true);
    const response = await agent.fetch(request('/mcp/tools'), { MCP_SECRET: 's3cret' }, ctx);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('secretCapability');
  });

  it('rejects a wrong token', async () => {
    const agent = makeAgent(true);
    const response = await agent.fetch(
      request('/mcp/tools', { Authorization: 'Bearer nope' }),
      { MCP_SECRET: 's3cret' },
      ctx,
    );
    expect(response.status).toBe(401);
  });

  it('serves the tool list with the correct token', async () => {
    const agent = makeAgent(true);
    const response = await agent.fetch(
      request('/mcp/tools', { Authorization: 'Bearer s3cret' }),
      { MCP_SECRET: 's3cret' },
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('secretCapability');
  });

  it('stays open when no secret is configured (unchanged default)', async () => {
    const agent = makeAgent(false);
    const response = await agent.fetch(request('/mcp/tools'), {}, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('secretCapability');
  });
});

describe('POST /mcp bearer auth (regression)', () => {
  it('still rejects an unauthenticated request', async () => {
    const agent = makeAgent(true);
    const response = await agent.fetch(
      new Request('https://worker/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      { MCP_SECRET: 's3cret' },
      ctx,
    );
    expect(response.status).toBe(401);
  });
});
