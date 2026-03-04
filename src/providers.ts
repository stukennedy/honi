import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export function resolveModel(modelId: string): LanguageModel {
  if (modelId.startsWith('claude-')) {
    const provider = createAnthropic();
    return provider(modelId);
  }
  if (modelId.startsWith('gpt-')) {
    const provider = createOpenAI();
    return provider(modelId);
  }
  throw new Error(`Unsupported model: "${modelId}". Use a claude-* or gpt-* model ID.`);
}
