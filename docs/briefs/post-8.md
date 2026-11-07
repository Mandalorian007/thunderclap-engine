# Brief: ws/post-8

Read `docs/briefs/common.md` first. Then read the ws/post-7 and ws/render-8 rows and notes in `docs/STATUS.md`. This brief closes their wish: *PostStack should compare `renderer.jitter === hook` and drop its WeakMap*. Then read `src/post/post-stack.ts`, `src/post/{post6,post7}.test.ts`, and the `renderer.jitter` getter in `src/render/renderer.ts` (read only).

## Goal

The post stack decides whether it owns the jitter hook by asking the renderer, not by keeping its own map.

STATUS row, *done when*:

- **Owner by getter.** `PostStack` clears or re-installs its hook by comparing `renderer.jitter === this.hook`. The module `WeakMap<Renderer, PostStack>` is deleted.
  - All five post7 cases pass unchanged: A→B, `null`, destroying A after a swap, A→B→A, and the twin stacks.
  - Add one case: a page-installed hook (`renderer.setJitter(fn)` by hand) is never cleared by a stack.
- **Unchanged.** post2, post3, post4, depth-post and xr all pass. The 2D goldens stay at 0 px.
- **Docs.** The post README *Hook ownership* bullet and one CHANGELOG line.

## Files owned

You own:
- `src/post/**`
- `CHANGELOG.md`

Do not edit:
- `src/render/**` (read only)
- `demos/**`
- `templates/**`

**Branch** from `ws/render-8` at b3dc3b6. It is in E-031 train 10, and it carries the getter. Merge origin/main before your final gate. Use `E2E_PORT_OFFSET=1150`. Gate per E-031, with post2, post3, post4, depth-post and xr each run alone.
