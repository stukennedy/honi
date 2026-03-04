export interface SemanticResult {
    text: string;
    score: number;
    metadata: Record<string, string>;
}
export declare class SemanticMemory {
    private vectorize;
    private ai;
    constructor(vectorize: VectorizeIndex, ai: Ai);
    embed(text: string): Promise<number[]>;
    upsert(id: string, text: string, metadata: Record<string, string>): Promise<void>;
    search(query: string, topK?: number): Promise<SemanticResult[]>;
}
//# sourceMappingURL=semantic.d.ts.map