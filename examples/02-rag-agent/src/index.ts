import { createAgent, tool } from '@stukennedy/honi';
import { z } from 'zod';

const saveNote = tool({
  name: 'save_note',
  description: 'Save an important fact or note to long-term memory',
  input: z.object({ content: z.string(), category: z.string().optional() }),
  handler: async ({ content, category }) => {
    // The semantic memory layer will auto-embed this on next turn
    return { saved: true, content };
  },
});

const agent = createAgent({
  name: 'rag-agent',
  model: 'claude-sonnet-4-5',
  memory: {
    enabled: true,
    episodic: { enabled: true, limit: 100 },
    semantic: { enabled: true, topK: 5 },
  },
  tools: [saveNote],
  system: `You are a knowledgeable assistant with long-term memory.
You remember past conversations and can recall relevant context automatically.
When asked to remember something important, use the save_note tool.`,
});

export default { fetch: agent.fetch };
export const RagAgentDO = agent.DurableObject;
