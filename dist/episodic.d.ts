import type { CoreMessage } from 'ai';
export declare class EpisodicMemory {
    private db;
    constructor(db: D1Database);
    init(): Promise<void>;
    append(agentName: string, threadId: string, messages: CoreMessage[]): Promise<void>;
    load(agentName: string, threadId: string, limit?: number): Promise<CoreMessage[]>;
    clear(agentName: string, threadId: string): Promise<void>;
    search(agentName: string, query: string, limit?: number): Promise<CoreMessage[]>;
}
//# sourceMappingURL=episodic.d.ts.map