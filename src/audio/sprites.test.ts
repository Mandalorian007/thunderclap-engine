import { describe, expect, it } from 'vitest';
import { fakeBuffer, setupEngine } from './fake-context.test-util';
import { parseSpriteRef, spriteSchedule, spriteSheetFrom } from './sprites';

describe('sprite references and schedules', () => {
  it('splits name#clip at the first hash and leaves plain names alone', () => {
    expect(parseSpriteRef('fx#hit')).toEqual({ sheet: 'fx', clip: 'hit' });
    expect(parseSpriteRef('fx#a#b')).toEqual({ sheet: 'fx', clip: 'a#b' });
    expect(parseSpriteRef('fx')).toBeNull();
  });

  it('converts ms ranges to seconds, loop points inside the clip, whole range without', () => {
    const sheet = {
      sprites: { hit: [500, 250], hum: [1000, 1000] },
      loopPoints: { hum: [200, 800] },
    } as const;
    expect(spriteSchedule(sheet, 'fx', 'hit')).toEqual({
      offset: 0.5,
      duration: 0.25,
      loopStart: 0.5,
      loopEnd: 0.75,
    });
    const out = { offset: 0, duration: 0, loopStart: 0, loopEnd: 0 };
    expect(spriteSchedule(sheet, 'fx', 'hum', out)).toBe(out);
    expect(out).toEqual({ offset: 1, duration: 1, loopStart: 1.2, loopEnd: 1.8 });
    // Loop points past the clip are clamped to it.
    const long = { sprites: { a: [0, 100] }, loopPoints: { a: [50, 900] } } as const;
    expect(spriteSchedule(long, 's', 'a').loopEnd).toBeCloseTo(0.1);
  });

  it('throws a readable error for an unknown clip', () => {
    const sheet = { sprites: { hit: [0, 10], miss: [10, 10] } } as const;
    expect(() => spriteSchedule(sheet, 'fx', 'nope')).toThrow(
      '[audio] sprite sheet "fx" has no clip "nope" (clips: hit, miss)',
    );
  });

  it('builds a sheet from a sidecar and a buffer', () => {
    const buffer = fakeBuffer(2);
    const sheet = spriteSheetFrom({ src: 'fx.ogg', sprites: { a: [0, 10] } }, buffer);
    expect(sheet.buffer).toBe(buffer);
    expect(sheet.sprites).toEqual({ a: [0, 10] });
  });
});

describe('AudioEngine sprites', () => {
  it('play(name#clip) schedules start(when, offset, duration); loop uses the loop points', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    ctx.currentTime = 2;
    audio.defineSprites('fx', {
      buffer: fakeBuffer(3),
      sprites: { hit: [500, 250], hum: [1000, 1000] },
      loopPoints: { hum: [200, 800] },
    });
    expect(audio.has('fx')).toBe(true);
    expect(audio.spriteSheet('fx')?.sprites.hit).toEqual([500, 250]);
    const hit = audio.play('fx#hit', { gain: 0.5 });
    expect(hit.playing).toBe(true);
    const s = ctx.played[0]!;
    expect([s.startedAt, s.offset, s.duration, s.loop]).toEqual([2, 0.5, 0.25, false]);
    audio.loop('fx#hum');
    const h = ctx.played[1]!;
    expect([h.startedAt, h.offset, h.duration, h.loop]).toEqual([2, 1, null, true]);
    expect([h.loopStart, h.loopEnd]).toEqual([1.2, 1.8]);
    // The whole buffer still plays under the sheet's name.
    audio.play('fx');
    const whole = ctx.played[2]!;
    expect([whole.offset, whole.duration]).toEqual([null, null]);
    expect(audio.voices('sfx')).toHaveLength(2);
  });

  it('throws readably for an unknown clip or sheet, and a factory sheet renders lazily', async () => {
    const { ctx, audio } = setupEngine();
    await audio.unlock();
    audio.defineSprites('fx', { buffer: fakeBuffer(1), sprites: { hit: [0, 100] } });
    expect(() => audio.play('fx#nope')).toThrow('sprite sheet "fx" has no clip "nope"');
    expect(() => audio.play('zz#hit')).toThrow('unknown sprite sheet "zz"');
    let built = 0;
    audio.defineSprites('lazy', {
      source: async () => {
        built++;
        return fakeBuffer(1);
      },
      sprites: { a: [100, 100] },
    });
    expect(built).toBe(0);
    audio.play('lazy#a');
    expect(built).toBe(1);
    await audio.prepare();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.played.at(-1)!.offset).toBe(0.1);
    // Redefining the name as a plain sound drops the sheet.
    audio.define('fx', async () => fakeBuffer(1));
    expect(audio.spriteSheet('fx')).toBeNull();
  });
});
