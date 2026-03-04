/**
 * Multi-Agent Orchestration
 * 
 * Enables agents to spawn sub-agents and route requests between agents.
 * Similar to CF Agents' routeAgentRequest.
 */

export interface AgentReference {
  /** Durable Object namespace binding name */
  binding: string;
  /** Optional thread/instance ID (defaults to 'default') */
  threadId?: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentResponse {
  messages: AgentMessage[];
  /** Final assistant response */
  response: string;
}

/**
 * Route a chat message to another agent.
 * Returns the full response (non-streaming).
 */
export async function routeToAgent(
  env: Record<string, DurableObjectNamespace>,
  agent: AgentReference,
  message: string,
): Promise<AgentResponse> {
  const ns = env[agent.binding];
  if (!ns) {
    throw new Error(`Agent binding not found: ${agent.binding}`);
  }
  
  const threadId = agent.threadId ?? 'default';
  const id = ns.idFromName(threadId);
  const stub = ns.get(id);
  
  const response = await stub.fetch(new Request('https://agent/chat', {
    method: 'POST',
    headers: { 
      'content-type': 'application/json',
      'x-thread-id': threadId,
    },
    body: JSON.stringify({ message }),
  }));

  if (!response.ok) {
    throw new Error(`Agent request failed: ${response.status}`);
  }

  // Parse streaming response to get final message
  const text = await response.text();
  const lines = text.split('\n').filter(l => l.startsWith('0:'));
  const fullResponse = lines.map(l => JSON.parse(l.slice(2))).join('');
  
  return {
    messages: [
      { role: 'user', content: message },
      { role: 'assistant', content: fullResponse },
    ],
    response: fullResponse,
  };
}

/**
 * Get conversation history from another agent.
 */
export async function getAgentHistory(
  env: Record<string, DurableObjectNamespace>,
  agent: AgentReference,
): Promise<AgentMessage[]> {
  const ns = env[agent.binding];
  if (!ns) {
    throw new Error(`Agent binding not found: ${agent.binding}`);
  }
  
  const threadId = agent.threadId ?? 'default';
  const id = ns.idFromName(threadId);
  const stub = ns.get(id);
  
  const response = await stub.fetch(new Request('https://agent/history'));
  if (!response.ok) {
    throw new Error(`Failed to get agent history: ${response.status}`);
  }
  
  const data = await response.json() as { messages: AgentMessage[] };
  return data.messages;
}

/**
 * Clear conversation history for another agent.
 */
export async function clearAgentHistory(
  env: Record<string, DurableObjectNamespace>,
  agent: AgentReference,
): Promise<void> {
  const ns = env[agent.binding];
  if (!ns) {
    throw new Error(`Agent binding not found: ${agent.binding}`);
  }
  
  const threadId = agent.threadId ?? 'default';
  const id = ns.idFromName(threadId);
  const stub = ns.get(id);
  
  const response = await stub.fetch(new Request('https://agent/history', { method: 'DELETE' }));
  if (!response.ok) {
    throw new Error(`Failed to clear agent history: ${response.status}`);
  }
}

/**
 * Call an MCP tool on another agent.
 */
export async function callAgentTool(
  env: Record<string, DurableObjectNamespace>,
  agent: AgentReference,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const ns = env[agent.binding];
  if (!ns) {
    throw new Error(`Agent binding not found: ${agent.binding}`);
  }
  
  const threadId = agent.threadId ?? 'default';
  const id = ns.idFromName(threadId);
  const stub = ns.get(id);
  
  const response = await stub.fetch(new Request('https://agent/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  }));

  if (!response.ok) {
    throw new Error(`MCP tool call failed: ${response.status}`);
  }

  const result = await response.json() as { result?: { content?: Array<{ text: string }> }; error?: { message: string } };
  if (result.error) {
    throw new Error(`MCP error: ${result.error.message}`);
  }
  
  const content = result.result?.content?.[0]?.text;
  if (!content) {
    return null;
  }
  
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * List available tools from another agent via MCP.
 */
export async function listAgentTools(
  env: Record<string, DurableObjectNamespace>,
  agent: AgentReference,
): Promise<Array<{ name: string; description?: string }>> {
  const ns = env[agent.binding];
  if (!ns) {
    throw new Error(`Agent binding not found: ${agent.binding}`);
  }
  
  const threadId = agent.threadId ?? 'default';
  const id = ns.idFromName(threadId);
  const stub = ns.get(id);
  
  const response = await stub.fetch(new Request('https://agent/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/list',
    }),
  }));

  if (!response.ok) {
    throw new Error(`MCP tools/list failed: ${response.status}`);
  }

  const result = await response.json() as { result?: { tools: Array<{ name: string; description?: string }> } };
  return result.result?.tools ?? [];
}
