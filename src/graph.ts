/**
 * GraphMemory — edge-native property graph for structured entity/relationship recall.
 *
 * Wraps the edgraph REST API (https://github.com/stukennedy/edgraph).
 * Supports two transport modes:
 *   - Service binding: zero-latency DO-to-DO via CF internal network
 *   - HTTP: external edgraph worker (cross-account or external)
 */

export interface GraphNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  properties: Record<string, unknown>;
  createdAt?: string;
}

export interface TraversalNode {
  node: GraphNode;
  depth: number;
  parentId: string | null;
  viaEdgeId: string | null;
}

export interface TraversalResult {
  from: string;
  count: number;
  nodes: TraversalNode[];
}

export interface PathResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  length: number;
}

export interface SubgraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeCount: number;
  edgeCount: number;
}

export interface GraphMemoryOptions {
  /** Graph identifier (maps to one DO instance in edgraph). */
  graphId: string;
  /** Service binding fetcher (CF internal network — preferred). */
  fetcher?: { fetch: (req: Request) => Promise<Response> };
  /** HTTP URL for external edgraph worker. */
  url?: string;
  /** API key for write operations. */
  apiKey?: string;
}

export class GraphMemory {
  private graphId: string;
  private fetcher: { fetch: (req: Request) => Promise<Response> } | null;
  private url: string | null;
  private apiKey: string | null;

  constructor(opts: GraphMemoryOptions) {
    this.graphId = opts.graphId;
    this.fetcher = opts.fetcher ?? null;
    this.url = opts.url ?? null;
    this.apiKey = opts.apiKey ?? null;

    if (!this.fetcher && !this.url) {
      throw new Error('[honi/graph] GraphMemory requires either a service binding fetcher or a URL.');
    }
  }

  // ─── Transport ───────────────────────────────────────────────────────────────

  private base(): string {
    return `/graphs/${this.graphId}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    requireAuth = false,
  ): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (requireAuth && this.apiKey) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }

    const init: RequestInit = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    let response: Response;
    if (this.fetcher) {
      response = await this.fetcher.fetch(new Request(`https://edgraph${path}`, init));
    } else {
      response = await fetch(`${this.url}${path}`, init);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`[honi/graph] ${method} ${path} → ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  // ─── Nodes ───────────────────────────────────────────────────────────────────

  /** Create or update a node. Uses PUT to upsert by ID. */
  async upsertNode(
    id: string,
    label: string,
    properties: Record<string, unknown>,
  ): Promise<GraphNode> {
    try {
      // Try update first
      return await this.request<GraphNode>(
        'PUT',
        `${this.base()}/nodes/${id}`,
        { label, properties },
        true,
      );
    } catch {
      // Create if not found
      return this.request<GraphNode>(
        'POST',
        `${this.base()}/nodes`,
        { id, label, properties },
        true,
      );
    }
  }

  async getNode(id: string): Promise<GraphNode | null> {
    try {
      return await this.request<GraphNode>('GET', `${this.base()}/nodes/${id}`);
    } catch {
      return null;
    }
  }

  async deleteNode(id: string): Promise<void> {
    await this.request<void>('DELETE', `${this.base()}/nodes/${id}`, undefined, true);
  }

  async listNodes(opts: { label?: string; limit?: number; offset?: number } = {}): Promise<GraphNode[]> {
    const params = new URLSearchParams();
    if (opts.label) params.set('label', opts.label);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const result = await this.request<{ nodes: GraphNode[] }>('GET', `${this.base()}/nodes${qs ? `?${qs}` : ''}`);
    return result.nodes ?? [];
  }

  // ─── Edges ───────────────────────────────────────────────────────────────────

  /** Create a directed edge between two nodes. */
  async upsertEdge(
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> = {},
  ): Promise<GraphEdge> {
    // Check if edge already exists
    const existing = await this.request<{ edges: GraphEdge[] }>(
      'GET',
      `${this.base()}/edges?fromId=${fromId}&toId=${toId}&type=${type}`,
    );
    if (existing.edges?.length > 0) {
      return this.request<GraphEdge>(
        'PUT',
        `${this.base()}/edges/${existing.edges[0].id}`,
        { properties },
        true,
      );
    }
    return this.request<GraphEdge>(
      'POST',
      `${this.base()}/edges`,
      { fromId, toId, type, properties },
      true,
    );
  }

  async deleteEdge(id: string): Promise<void> {
    await this.request<void>('DELETE', `${this.base()}/edges/${id}`, undefined, true);
  }

  async getNeighbours(
    id: string,
    direction: 'in' | 'out' | 'both' = 'out',
    types?: string[],
  ): Promise<GraphNode[]> {
    const params = new URLSearchParams({ direction });
    if (types?.length) params.set('type', types.join(','));
    const result = await this.request<{ neighbours: GraphNode[] }>(
      'GET',
      `${this.base()}/nodes/${id}/neighbours?${params}`,
    );
    return result.neighbours ?? [];
  }

  // ─── Traversal ───────────────────────────────────────────────────────────────

  async traverse(
    from: string,
    opts: {
      direction?: 'in' | 'out' | 'both';
      maxDepth?: number;
      edgeTypes?: string[];
      nodeLabels?: string[];
      algorithm?: 'bfs' | 'dfs';
      limit?: number;
    } = {},
  ): Promise<TraversalResult> {
    return this.request<TraversalResult>('POST', `${this.base()}/traverse`, {
      from,
      direction: opts.direction ?? 'out',
      maxDepth: opts.maxDepth ?? 2,
      edgeTypes: opts.edgeTypes,
      nodeLabels: opts.nodeLabels,
      algorithm: opts.algorithm ?? 'bfs',
      limit: opts.limit ?? 100,
    });
  }

  async shortestPath(from: string, to: string, maxDepth = 6): Promise<PathResult | null> {
    try {
      const result = await this.request<{ path: PathResult | null }>(
        'POST',
        `${this.base()}/paths`,
        { from, to, direction: 'out', maxDepth },
      );
      return result.path ?? null;
    } catch {
      return null;
    }
  }

  async subgraph(root: string, depth = 2, direction: 'in' | 'out' | 'both' = 'out'): Promise<SubgraphResult> {
    return this.request<SubgraphResult>('POST', `${this.base()}/subgraph`, {
      root,
      depth,
      direction,
    });
  }

  // ─── Context Generation ───────────────────────────────────────────────────────

  /**
   * Convert a set of entity IDs into an LLM-injectable context block.
   * Expands each entity to its local neighbourhood (depth 1 by default).
   * Deduplicates nodes across multiple starting points.
   *
   * Returns empty string if no entities found.
   */
  async toContext(entityIds: string[], depth = 1): Promise<string> {
    if (!entityIds.length) return '';

    const seenNodes = new Map<string, GraphNode>();
    const seenEdges = new Map<string, GraphEdge>();

    for (const id of entityIds) {
      try {
        const sub = await this.subgraph(id, depth, 'both');
        for (const n of sub.nodes) seenNodes.set(n.id, n);
        for (const e of sub.edges) seenEdges.set(e.id, e);
      } catch {
        // Node may not exist — skip silently
      }
    }

    if (!seenNodes.size) return '';

    const lines: string[] = ['[Knowledge graph context:]'];

    // Group edges by fromId for easy lookup
    const edgesByFrom = new Map<string, GraphEdge[]>();
    for (const e of seenEdges.values()) {
      const bucket = edgesByFrom.get(e.fromId) ?? [];
      bucket.push(e);
      edgesByFrom.set(e.fromId, bucket);
    }

    for (const node of seenNodes.values()) {
      const propStr = Object.entries(node.properties)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      lines.push(`- (${node.label}:${node.id})${propStr ? ` {${propStr}}` : ''}`);

      const edges = edgesByFrom.get(node.id) ?? [];
      for (const edge of edges) {
        const target = seenNodes.get(edge.toId);
        const targetLabel = target ? `(${target.label}:${edge.toId})` : edge.toId;
        const edgePropStr = Object.entries(edge.properties ?? {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ');
        lines.push(
          `  → [${edge.type}]${edgePropStr ? ` {${edgePropStr}}` : ''} → ${targetLabel}`,
        );
      }
    }

    lines.push('[End graph context]');
    return lines.join('\n');
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  async stats(): Promise<{ nodeCount: number; edgeCount: number }> {
    return this.request('GET', `${this.base()}/stats`);
  }
}
