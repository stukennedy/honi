export class SemanticMemory {
    vectorize;
    ai;
    constructor(vectorize, ai) {
        this.vectorize = vectorize;
        this.ai = ai;
    }
    async embed(text) {
        const result = await this.ai.run('@cf/baai/bge-base-en-v1.5', {
            text: [text],
        });
        return result.data[0];
    }
    async upsert(id, text, metadata) {
        const values = await this.embed(text);
        await this.vectorize.upsert([
            { id, values, metadata: { ...metadata, text } },
        ]);
    }
    async search(query, topK = 3) {
        const values = await this.embed(query);
        const matches = await this.vectorize.query(values, {
            topK,
            returnMetadata: 'all',
        });
        return matches.matches
            .filter((m) => m.score > 0.7)
            .map((m) => ({
            text: m.metadata?.text ?? '',
            score: m.score,
            metadata: (m.metadata ?? {}),
        }));
    }
}
//# sourceMappingURL=semantic.js.map