import { createAgent } from 'honidev';

const agent = createAgent({
  name: 'simple-agent',
  model: 'claude-sonnet-4-5',
  memory: { enabled: true },
  system: 'You are a helpful assistant. Be concise and friendly.',
});

export default { fetch: agent.fetch };
export const SimpleAgentDO = agent.DurableObject;
