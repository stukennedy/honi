import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { tool } from '../src/tool.js';

describe('tool()', () => {
  it('returns a ToolDefinition with correct fields', () => {
    const t = tool({
      name: 'greet',
      description: 'Greet a user',
      input: z.object({ name: z.string() }),
      handler: async ({ name }) => `Hello, ${name}!`,
    });

    expect(t.name).toBe('greet');
    expect(t.description).toBe('Greet a user');
    expect(t.input).toBeDefined();
    expect(typeof t.handler).toBe('function');
  });

  it('handler executes correctly', async () => {
    const t = tool({
      name: 'add',
      description: 'Add two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      handler: async ({ a, b }) => a + b,
    });

    const result = await t.handler({ a: 2, b: 3 });
    expect(result).toBe(5);
  });

  it('input schema validates correctly', () => {
    const t = tool({
      name: 'echo',
      description: 'Echo message',
      input: z.object({ message: z.string() }),
      handler: async ({ message }) => message,
    });

    const valid = t.input.safeParse({ message: 'hello' });
    expect(valid.success).toBe(true);

    const invalid = t.input.safeParse({ message: 123 });
    expect(invalid.success).toBe(false);
  });

  it('preserves an invalid-argument handler on the tool definition', async () => {
    const validationError = new z.ZodError([
      {
        code: 'invalid_enum_value',
        options: ['IC', 'Manager'],
        path: ['seniorityBand'],
        received: 'Senior Manager',
        message: "Invalid enum value. Expected 'IC' | 'Manager', received 'Senior Manager'",
      },
    ]);
    const t = tool({
      name: 'submitRatings',
      description: 'Submit final ratings',
      input: z.object({ seniorityBand: z.enum(['IC', 'Manager']) }),
      handler: async () => 'submitted',
      onInvalidArguments: async (rawArgs, error) => ({
        rawArgs,
        issue: error.issues[0]?.code,
      }),
    });

    await expect(
      t.onInvalidArguments?.({ seniorityBand: 'Senior Manager' }, validationError),
    ).resolves.toEqual({
      rawArgs: { seniorityBand: 'Senior Manager' },
      issue: 'invalid_enum_value',
    });
  });
});
