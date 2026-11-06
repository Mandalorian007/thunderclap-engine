# Brief: ws/input-6

Read `docs/briefs/common.md` first. Then read the ws/e2e-harden engine findings line in `docs/STATUS.md` (finding 2), along with the ws/input-5 and ws/gesture-longpress rows. Also read `src/input/README.md` (*Gestures*, *Look*), `src/input/{gestures,look,pointer-dispatch}.ts` and their tests, and the `e2e/gestures*` or input spec that drives long-press.

## Goal

Gesture classification uses when the event happened, not when the page got round to handling it. A tap is still a tap on a stalled main thread.

STATUS row, *done when*:
- **Event time.** Gestures use `event.timeStamp` for tap, long-press, double-tap and swipe timing and velocity, with the same clock base as `performance.now()`.
  - The long-press timer that fires with no event (still pressed, no move) still uses `performance.now()`, but measures from the down event's `timeStamp`.
  - Where the long-press timer and a late pointer-up race, the up event's `timeStamp` decides.
- **Look.** Apply the same rule to `look.ts` velocity and flick timing if it reads `performance.now()` per event. Say in your report what changed.
- **Tests (dom).** Add a test where pointer-down at t=0 and pointer-up with `timeStamp` 120 are handled 900 ms late: the result must be a tap, not a long-press. Add one test where a real hold past the threshold is still a long-press. The existing gesture tests must stay green.
- **Specs.** Run every input and gesture spec alone, green.
- **Docs.** Add the timing rule to the input README and a CHANGELOG line.

## Files owned

You own:
- `src/input/{gestures,look,pointer-dispatch}.ts` and their tests
- `src/input/README.md`
- `CHANGELOG.md`

Do not edit specs that belong to ws/e2e-harden (in train 2), `demos/**` or `templates/**`.

Branch from `main` (the head of this brief or later). Use `E2E_PORT_OFFSET=850`. Gate per E-031.
