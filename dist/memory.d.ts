import type { CoreMessage } from 'ai';
export declare class ThreadMemory {
    private storage;
    constructor(storage: DurableObjectStorage);
    load(): Promise<CoreMessage[]>;
    append(messages: CoreMessage[]): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=memory.d.ts.map