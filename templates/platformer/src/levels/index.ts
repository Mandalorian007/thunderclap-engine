/** The levels in play order. Add a file beside these and list it here. */
import type { Level } from './format';
import { meadow } from './meadow';
import { ruins } from './ruins';

export const LEVELS: readonly Level[] = [meadow, ruins];

export function levelById(id: string): Level | undefined {
  return LEVELS.find((l) => l.id === id);
}
