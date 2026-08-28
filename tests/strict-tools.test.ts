import { describe, expect, it } from 'bun:test';
import { resolveModel, strictify, nullable } from '../src/providers.js';

/**
 * OPENROUTER_STRICT_TOOLS rewrites tool schemas into OpenAI's strict shape.
 * The subtle rule: strict mode moves EVERY property into `required`, so an
 * optional argument survives only if the rewrite genuinely admits null.
 */
describe('strictify keeps optional arguments optional', () => {
  it('admits null on an optional enum — widening `type` alone would not', () => {
    const out = strictify({
      type: 'object',
      properties: { band: { type: 'string', enum: ['new_area', 'expert'] } },
      required: [],
    });
    // A value must satisfy type AND enum, so null has to be legal in both.
    expect(out.properties.band.type).toEqual(['string', 'null']);
    expect(out.properties.band.enum).toEqual(['new_area', 'expert', null]);
    expect(out.required).toEqual(['band']);
    expect(out.additionalProperties).toBe(false);
  });

  it('admits null on an optional const by turning it into a union', () => {
    const out = strictify({
      type: 'object',
      properties: { kind: { const: 'scan' } },
      required: [],
    });
    // The const branch keeps the `type` strictify inferred for it (typeless
    // branches get one so strict mode has something to check), then nullable
    // turns the whole thing into a union — a const cannot be widened in place.
    expect(out.properties.kind.anyOf).toEqual([
      { const: 'scan', type: 'string' },
      { type: 'null' },
    ]);
  });

  it('leaves a REQUIRED enum alone — it was never optional', () => {
    const out = strictify({
      type: 'object',
      properties: { band: { type: 'string', enum: ['new_area'] } },
      required: ['band'],
    });
    expect(out.properties.band.enum).toEqual(['new_area']);
    expect(out.properties.band.type).toBe('string');
  });

  it('recurses into arrays and nested objects', () => {
    const out = strictify({
      type: 'object',
      properties: {
        ratings: {
          type: 'array',
          items: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
        },
      },
      required: ['ratings'],
    });
    expect(out.properties.ratings.items.required).toEqual(['note']);
    expect(out.properties.ratings.items.properties.note.type).toEqual(['string', 'null']);
  });

  it('infers a type for typeless branches so strict mode has one', () => {
    expect(strictify({ enum: ['a', 'b'] }).type).toBe('string');
    expect(strictify({ const: 3 }).type).toBe('number');
    expect(strictify({ description: 'anything' }).type).toBe('string');
  });
});

describe('strictify reaches shapes the property walk cannot', () => {
  it('wraps an optional $ref/oneOf/allOf in a null union', () => {
    for (const shape of [{ $ref: '#/$defs/Band' }, { oneOf: [{ type: 'string' }] }, { allOf: [{ type: 'string' }] }]) {
      const out = strictify({ type: 'object', properties: { x: shape }, required: [] });
      expect(out.required).toEqual(['x']);
      // Neither omission nor null would be legal if this passed through.
      expect(out.properties.x.anyOf?.[out.properties.x.anyOf.length - 1]).toEqual({ type: 'null' });
    }
  });

  it('strictifies objects inside $defs and definitions', () => {
    for (const key of ['$defs', 'definitions'] as const) {
      const out = strictify({
        type: 'object',
        properties: { band: { $ref: `#/${key}/Band` } },
        required: ['band'],
        [key]: {
          Band: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
        },
      });
      // Reachable only through $ref — the property walk never visits it, and a
      // function marked strict:true is rejected if it stays unrewritten.
      expect(out[key].Band.required).toEqual(['note']);
      expect(out[key].Band.additionalProperties).toBe(false);
      expect(out[key].Band.properties.note.type).toEqual(['string', 'null']);
    }
  });
});

describe('nullable', () => {
  it('is idempotent', () => {
    const once = nullable({ type: 'string', enum: ['a'] });
    expect(nullable(once)).toEqual(once);
  });

  it('appends to an existing type array and anyOf', () => {
    expect(nullable({ type: ['string', 'number'] }).type).toEqual(['string', 'number', 'null']);
    expect(nullable({ anyOf: [{ type: 'string' }] }).anyOf).toEqual([
      { type: 'string' },
      { type: 'null' },
    ]);
  });
});

describe('gemini-* key requirement is scoped to the DIRECT route', () => {
  it('throws when going straight to Google with no key', async () => {
    await expect(resolveModel('gemini-3.5-flash-lite', { env: {} })).rejects.toThrow(
      /GOOGLE_AI_API_KEY/,
    );
  });

  it('resolves keyless through a gatewayUrl proxy, which supplies the credential', async () => {
    const model = await resolveModel('gemini-3.5-flash-lite', {
      env: {},
      gatewayUrl: 'https://proxy.example/v1',
      headers: { authorization: 'Bearer proxy-token' },
    });
    expect(model).toBeDefined();
  });
});
