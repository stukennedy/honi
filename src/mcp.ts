/**
 * MCP (Model Context Protocol) Server Support
 * 
 * Enables Honi agents to expose their tools as MCP endpoints,
 * allowing Claude Desktop, Cursor, and other MCP clients to connect.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition } from './types';

// MCP JSON-RPC 2.0 types
export interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: McpError;
}

export interface McpError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolsListResult {
  tools: McpToolInfo[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

// MCP Error codes
export const MCP_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Convert Honi tool definitions to MCP tool format
 */
export function toolsToMcp(tools: ToolDefinition[]): McpToolInfo[] {
  return tools.map((tool) => {
    const jsonSchema = zodToJsonSchema(tool.input, { target: 'openApi3' });
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: jsonSchema as McpToolInfo['inputSchema'],
    };
  });
}

/**
 * Create an MCP server handler for a set of tools
 */
export function createMcpServer(tools: ToolDefinition[]) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  async function handleRequest(request: McpRequest): Promise<McpResponse> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: 'honi-agent',
                version: '0.4.0',
              },
            },
          };
        }

        case 'tools/list': {
          const mcpTools = toolsToMcp(tools);
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: mcpTools } as McpToolsListResult,
          };
        }

        case 'tools/call': {
          const callParams = params as unknown as McpToolCallParams;
          const { name, arguments: args } = callParams;
          const tool = toolMap.get(name);
          
          if (!tool) {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: MCP_ERRORS.METHOD_NOT_FOUND,
                message: `Tool not found: ${name}`,
              },
            };
          }

          try {
            const result = await tool.handler(args || {});
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text }],
              } as McpToolCallResult,
            };
          } catch (err) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
                isError: true,
              } as McpToolCallResult,
            };
          }
        }

        case 'notifications/initialized':
        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }

        default: {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCP_ERRORS.METHOD_NOT_FOUND,
              message: `Method not found: ${method}`,
            },
          };
        }
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: MCP_ERRORS.INTERNAL_ERROR,
          message: (err as Error).message,
        },
      };
    }
  }

  /**
   * HTTP handler for MCP requests (POST /mcp)
   */
  async function handleHttp(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json() as McpRequest;
      
      if (body.jsonrpc !== '2.0' || !body.method) {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: MCP_ERRORS.INVALID_REQUEST, message: 'Invalid JSON-RPC request' },
        });
      }

      const response = await handleRequest(body);
      return Response.json(response);
    } catch {
      return Response.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: MCP_ERRORS.PARSE_ERROR, message: 'Parse error' },
      });
    }
  }

  return {
    handleRequest,
    handleHttp,
    tools: toolsToMcp(tools),
  };
}

export type McpServer = ReturnType<typeof createMcpServer>;
