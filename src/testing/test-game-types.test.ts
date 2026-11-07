/**
 * ws/testing-3: `TestGameOptions` takes `createGame`'s `P`, so `createTestGame` infers the
 * pointer targets from `pointers.testers` as `createGame` does. Plain Node (`overlay: false`).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EngineCtx } from '../core/game';
import { type PickHit, planeTester } from '../input';
import { createTestGame, type TestGameOptions } from './test-game';

describe('createTestGame pointer types (ws/testing-3)', () => {
  it('P is inferred from pointers.testers; EngineCtx<A> still takes the ctx', async () => {
    const game = await createTestGame({
      overlay: false,
      input: { bindings: { go: [{ key: 'Space' }] } },
      pointers: { testers: [planeTester(0, { id: 7 })] },
    });
    expectTypeOf(game.ctx.pointers.hit).toEqualTypeOf<PickHit<{ id: number }> | null>();
    // @ts-expect-error the inferred router's targets are `{ id: number }`
    game.ctx.pointers.addTester(planeTester(0, 'not an id'));
    const takes = (c: EngineCtx<'go'>) => c.pointers;
    expect(takes(game.ctx)).toBe(game.ctx.pointers);
  });

  it('without testers P stays unknown, and a bare TestGameOptions takes testers of any target', async () => {
    const bare = await createTestGame({ overlay: false, input: { bindings: { go: [] } } });
    expectTypeOf(bare.ctx.pointers.hit).toEqualTypeOf<PickHit<unknown> | null>();
    // The default P is `any` (additive): options typed before P existed still accept any tester.
    const opts: TestGameOptions<'go'> = {
      overlay: false,
      input: { bindings: { go: [] } },
      pointers: { testers: [planeTester(0, 'a'), planeTester(1, { id: 1 })] },
    };
    const any = await createTestGame(opts);
    expect(any.ctx.pointers).toBeDefined();
  });
});
