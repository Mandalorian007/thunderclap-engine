import { describe, expect, it } from 'vitest';
import { BindingSet } from './bindings';
import { createFakeDevice } from './fake-gpu';
import { createSamplers, defaultTextures, Texture } from './texture';

type Group = { entries: { binding: number; resource: unknown }[] };

describe('BindingSet default textures', () => {
  it('binds the registry white to every unset 2D slot when no default view is given', () => {
    const fake = createFakeDevice();
    const s = createSamplers(fake.device)['linear-clamp'];
    const set = new BindingSet(fake.device, { uniformBytes: 16, textures: 4 }, s, null, 'm');
    const g = set.bindGroup as unknown as Group;
    const white = defaultTextures(fake.device).white.view;
    expect(g.entries.map((e) => e.binding)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const e of g.entries.slice(2)) expect(e.resource).toBe(white);
    expect(fake.errors).toEqual([]);
  });

  it('keeps a caller-supplied default view and rebuilds when a slot is set later', () => {
    const fake = createFakeDevice();
    const s = createSamplers(fake.device)['linear-clamp'];
    const mine = new Texture(fake.device, { width: 1, height: 1, label: 'mine' });
    const set = new BindingSet(fake.device, { textures: 2 }, s, mine.view, 'm');
    const before = set.bindGroup as unknown as Group;
    expect(before.entries[1]!.resource).toBe(mine.view);
    expect(before.entries[2]!.resource).toBe(mine.view);
    // The registry is not touched when the caller brings its own white.
    expect(fake.textures.filter((t) => t.label === 'default-white')).toHaveLength(0);

    const tex = new Texture(fake.device, { width: 2, height: 2, label: 'later' });
    set.setTexture(1, tex);
    const after = set.bindGroup as unknown as Group;
    expect(after).not.toBe(before);
    expect(after.entries[1]!.resource).toBe(mine.view);
    expect(after.entries[2]!.resource).toBe(tex.view);
  });

  it('a set without textures never touches the registry', () => {
    const fake = createFakeDevice();
    const s = createSamplers(fake.device)['linear-clamp'];
    const set = new BindingSet(fake.device, { uniformBytes: 16 }, s, null, 'u');
    expect(set.bindGroup).toBeDefined();
    expect(fake.textures).toHaveLength(0);
  });
});
