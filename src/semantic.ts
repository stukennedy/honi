export interface SemanticResult {
  text: string;
  score: number;
  metadata: Record<string, string>;
}

export class SemanticMemory {
  constructor(
    private vectorize: VectorizeIndex,
    private ai: Ai,
  ) {}

  async embed(text: string): Promise<number[]> {
    const result = await this.ai.run('@cf/baai/bge-base-en-v1.5', {
      text: [text],
    });
    return (result as { data: number[][] }).data[0];
  }

  async upsert(
    id: string,
    text: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    const values = await this.embed(text);
    await this.vectorize.upsert([
      { id, values, metadata: { ...metadata, text } },
    ]);
  }

  async search(query: string, topK = 3): Promise<SemanticResult[]> {
    const values = await this.embed(query);
    const matches = await this.vectorize.query(values, {
      topK,
      returnMetadata: 'all',
    });
    return matches.matches
      .filter((m) => m.score > 0.7)
      .map((m) => ({
        text: (m.metadata?.text as string) ?? '',
        score: m.score,
        metadata: (m.metadata ?? {}) as Record<string, string>,
      }));
  }
}
