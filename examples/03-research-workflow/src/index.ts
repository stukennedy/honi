import { createAgent, workflow, step, tool } from 'honidev';
import { z } from 'zod';

// Tools for the agent
const searchWeb = tool({
  name: 'search_web',
  description: 'Search the web for information on a topic',
  input: z.object({ query: z.string() }),
  handler: async ({ query }) => {
    // In production: call a real search API (Brave, Serper, etc.)
    return { results: [`Mock results for: ${query}`] };
  },
});

// Research workflow: search → analyse → summarise
export const ResearchWorkflow = workflow({
  steps: [
    step(
      { name: 'search', retries: { limit: 3, backoff: 'exponential' } },
      async ({ query }: { query: string }, wfStep) => {
        return wfStep.do('fetch-search-results', async () => {
          // Simulate web search
          return { query, results: [`Result 1 for ${query}`, `Result 2 for ${query}`] };
        });
      }
    ),
    step(
      { name: 'analyse', timeout: '60 seconds' },
      async ({ query, results }: any, wfStep) => {
        return wfStep.do('analyse-results', async () => {
          return { query, results, analysis: `Analysis of ${results.length} results` };
        });
      }
    ),
    step(
      { name: 'summarise' },
      async ({ query, analysis }: any, wfStep) => {
        return wfStep.do('create-summary', async () => {
          return { query, summary: `Summary: ${analysis}`, completedAt: new Date().toISOString() };
        });
      }
    ),
  ],
  onComplete: async (result) => {
    console.log('Research complete:', result.summary);
  },
  onError: async (error) => {
    console.error('Research failed:', error.message);
  },
});

// Agent that can trigger the workflow
const researchAgent = createAgent({
  name: 'research-agent',
  model: 'claude-sonnet-4-5',
  memory: { enabled: true },
  tools: [searchWeb],
  system: 'You are a research assistant. Help users research topics thoroughly.',
});

export default { fetch: researchAgent.fetch };
export const ResearchAgentDO = researchAgent.DurableObject;
