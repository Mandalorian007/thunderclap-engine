import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import rules from '../shared/rules.json';
import { step } from './rules';
import { schema } from './schema';

describe('the client twin of the server', () => {
  it('steps like the shared cases', () => {
    for (const c of rules.cases) {
      const [x, y] = c.from as [number, number];
      expect(step({ x, y }, c.keys), JSON.stringify(c)).toEqual({ x: c.to[0], y: c.to[1] });
    }
  });

  it('hashes its schema like the server', () => {
    const committed = readFileSync(new URL('../shared/schema-hash.txt', import.meta.url), 'utf8');
    expect(schema.hash).toBe(committed.trim());
  });
});
