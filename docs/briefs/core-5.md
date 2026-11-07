# Brief: ws/core-5

Read `docs/briefs/common.md` first. Then read the ws/core-4 and ws/input-10 rows and notes in `docs/STATUS.md`. This brief closes their wish: *a `createGame` test with playback installed mid-session*. Then read `src/core/game.ts` and its tests, plus `src/input/README.md` *Clock* and *Recording*.

## Goal

The clock path a real game takes when it starts a replay from a menu, after the session has been running, is under test.

STATUS row, *done when*:

- **Mid-session playback.** A `createGame` test runs live for N ticks so the clock has advanced, then installs a playback of a recording that contains a long-press. Assert:
  - the long-press fires on its recorded tick index
  - the loop skips its own clock advance while the playback drives `ctx.clock`, and resumes it when the playback ends
  - fixed-update order stays `playback.step()` → `clock.advance` → `input.update()`
- **Speed.** The same test at playback speed 4 fires on the same tick index.
- **If it fails**, the cause is a real bug. Fix it in `src/core` if it is core's. If it is input's, report it with evidence and don't patch `src/input`.
- **Docs.** One CHANGELOG line under *Tests*, plus a core README note only if behaviour changed.

## Files owned

You own:
- `src/core/**`
- `CHANGELOG.md`

Do not edit:
- `src/input/**`
- `demos/**`
- `templates/**`

**Branch** from `ws/input-10` at c2de796, which carries the anchor; it is in E-031 train 11. Merge origin/main before your final gate. Use `E2E_PORT_OFFSET=1170`. Gate per E-031: check, snap, and the replay and game specs run alone.
