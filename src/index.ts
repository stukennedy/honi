export { createAgent } from './agent.js';
export { tool } from './tool.js';
export { EpisodicMemory } from './episodic.js';
export { SemanticMemory } from './semantic.js';
export type { SemanticResult } from './semantic.js';
export { z } from 'zod';
export type {
  AgentConfig,
  ToolDefinition,
  MemoryConfig,
  EpisodicConfig,
  SemanticConfig,
} from './types.js';

// Phase 3 — Workflows
export { workflow, step } from './workflow.js';
export type { WorkflowStepDef, HoniWorkflowConfig, StepConfig } from './workflow.js';

// Phase 5 — Observability
export { ObservabilityCollector, createObservability } from './observability.js';
export type { ObservabilityConfig, HoniEvent, HoniEventType } from './observability.js';
