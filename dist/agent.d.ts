import { ThreadMemory } from './memory.js';
import { EpisodicMemory } from './episodic.js';
import { SemanticMemory } from './semantic.js';
import type { AgentConfig } from './types.js';
export declare function createAgent(config: AgentConfig): {
    fetch: ExportedHandlerFetchHandler<unknown, unknown>;
    DurableObject: {
        new (ctx: DurableObjectState, env: unknown): {
            /** @internal */ memory: ThreadMemory;
            /** @internal */ state: DurableObjectState;
            /** @internal */ episodic: EpisodicMemory | null;
            /** @internal */ semantic: SemanticMemory | null;
            /** @internal */ env: Record<string, unknown>;
            fetch(request: Request): Promise<Response>;
        };
    };
};
//# sourceMappingURL=agent.d.ts.map