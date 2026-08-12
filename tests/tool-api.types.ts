import { z } from 'zod';
import type { HoniEvent } from '../src/observability.js';
import type { ToolDefinition } from '../src/types.js';

const input = z.object({ seniorityBand: z.enum(['IC', 'Manager']) });

const definition = {
  name: 'submitRatings',
  description: 'Submit final ratings',
  input,
  handler: async ({ seniorityBand }) => seniorityBand,
  onInvalidArguments: async (rawArgs, error) => ({
    rawArgs,
    issue: error.issues[0]?.code,
  }),
} satisfies ToolDefinition<typeof input>;

const repairEvent: HoniEvent = {
  type: 'tool.repair',
  agentName: 'ratings-agent',
  timestamp: 123,
  metadata: { tool: definition.name, attempt: 1, outcome: 'handled' },
};

void repairEvent;
