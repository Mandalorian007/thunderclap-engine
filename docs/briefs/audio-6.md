# Brief: ws/audio-6

Read `docs/briefs/common.md` first, then the ws/audio-5 row and notes in `docs/STATUS.md`. Then read:
- `src/audio/README.md`, *Ducking* and *Bus scale*
- `src/audio/{audio,duck}.ts` and their tests

## Goal

Two duckers on one bus combine instead of fighting. For example, dialogue ducks music, and a stinger ducks music too.

STATUS row, *done when*:

- **Keyed scales.** `setBusScale(bus, scale, tc?, key?)` keeps one scale per key. The bus's effective scale is the product of all its keys.
  - `key` defaults to `'default'`, so existing callers are unchanged.
  - `clearBusScale(bus, key)` removes one.
  - `busScale(bus, key?)` returns that key's scale, or the product when `key` is omitted.
- **Ducker.** `createDucker` uses its own unique key, and `dispose()` clears it.
  - Test: two duckers on music both active give a product; releasing one leaves the other's duck; disposing one clears its key.
  - All the audio-5 pause and background tests stay green.
- **Docs.** The README *Bus scale* section, the types list and a CHANGELOG line.

## Files owned

You own:
- `src/audio/**`
- `e2e/music.spec.ts`, for an append only if needed
- `CHANGELOG.md`

Branch from `main` (6fedfbf or later). Use `E2E_PORT_OFFSET=940`. Gate per E-031 with the music, audio4, lifecycle and zones specs each run alone.
