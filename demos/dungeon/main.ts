/**
 * ThunderClap demo: dungeon. A 2D top-down crawl at game scale: a 40×30 tile map from a
 * canvas-drawn atlas, 60 flipbook bats, a player square moved by keys, pad or touch drag with
 * wall collision, flickering emissive torches feeding bloom, a fog-of-war layer, a pause menu
 * walked with the d-pad, a coin counter kept in `save`, and synthesised pickup/hit sounds on the
 * `sfx` bus. Everything the room draws is one material and one draw call.
 *
 * `window.__demo` publishes the numbers e2e/demos/dungeon.spec.ts asserts on.
 */
import { createGame } from '@thunderclap/engine';
import { recipes } from '@thunderclap/engine/audio';
import type { Scene } from '@thunderclap/engine/core';
import { flicker } from '@thunderclap/engine/fx';
import type { DrawParams, Frame, RenderStats } from '@thunderclap/engine/render';
import { createSaveStore, s } from '@thunderclap/engine/save';
import { button, focusableWithin, h, type PadLike, PadNav } from '@thunderclap/engine/ui';
import { buildAtlas, CELL, cellUv, TILE } from './atlas';
import { buildMap, FIRST_COIN_TILE, isSolid, MAP_H, MAP_W, moveBox, rng, SPAWN_TILE } from './map';

const WORLD_W = MAP_W * TILE; // 1280
const WORLD_H = MAP_H * TILE; // 960
const BAT_COUNT = 60;
const PLAYER_HALF = 12;
const PLAYER_SPEED = 180; // px/s
const FOG_LAYER = 2;
const FOG_NEAR = 4.5; // tiles fully lit
const FOG_FAR = 8; // tiles fully dark

export interface DemoState {
  frame: number;
  /** Running average of rendered frames per second. */
  fps: number;
  stats: RenderStats | null;
  drawCalls: number;
  coins: number;
  bats: number;
  playerTile: { x: number; y: number };
  playerPos: { x: number; y: number };
  /** Coins left on the floor. */
  coinsOnFloor: number;
  /** Bat hits taken. */
  hits: number;
  paused: boolean;
  fog: boolean;
  /** Label of the focused pause-menu control, or null. */
  focused: string | null;
  /** True while bats and torches are parked (for deterministic reads). */
  parked: boolean;
  gpu: 'ok' | 'unsupported';
}

export interface DemoApi {
  state: DemoState;
  /** Is tile (tx, ty) a wall? */
  isSolid(tx: number, ty: number): boolean;
  /** Press or release a button on the demo's fake gamepad (standard mapping). */
  pad(index: number, pressed: boolean): void;
  /** Freeze bats and torch flicker. */
  park(on: boolean): void;
  setFog(on: boolean): void;
}

/** The spec reads `window.__demo` through a cast; no global `Window` augmentation, so other demos' shapes coexist in one typecheck. */
const demoWindow = window as unknown as { __demo?: DemoApi };

const state: DemoState = {
  frame: 0,
  fps: 0,
  stats: null,
  drawCalls: 0,
  coins: 0,
  bats: 0,
  playerTile: { x: SPAWN_TILE.x, y: SPAWN_TILE.y },
  playerPos: { x: 0, y: 0 },
  coinsOnFloor: 0,
  hits: 0,
  paused: false,
  fog: true,
  focused: null,
  parked: false,
  gpu: 'unsupported',
};

const padButtons = Array.from({ length: 17 }, () => ({ pressed: false }));
const fakePad: PadLike = { buttons: padButtons, axes: [0, 0, 0, 0] };

const ctx = await createGame({
  root: document.getElementById('app')!,
  title: 'ThunderClap demo: dungeon',
  design: { width: WORLD_W, height: WORLD_H },
  post: { fog: { enabled: false }, bloom: { enabled: true, threshold: 1.0, intensity: 0.8 } },
  save: (host) =>
    createSaveStore({
      game: 'demo-dungeon',
      slot: 'main',
      version: 1,
      defaults: () => ({ coins: 0 }),
      schema: s.object({ coins: s.number({ min: 0, int: true }) }),
      host,
    }),
  input: {
    bindings: {
      left: [{ key: 'ArrowLeft' }, { key: 'KeyA' }, { padButton: 14 }, { padAxis: 0, dir: -1 }],
      right: [{ key: 'ArrowRight' }, { key: 'KeyD' }, { padButton: 15 }, { padAxis: 0, dir: 1 }],
      up: [{ key: 'ArrowUp' }, { key: 'KeyW' }, { padButton: 12 }, { padAxis: 1, dir: -1 }],
      down: [{ key: 'ArrowDown' }, { key: 'KeyS' }, { padButton: 13 }, { padAxis: 1, dir: 1 }],
      pause: [{ key: 'Escape' }, { key: 'KeyP' }, { padButton: 9 }],
      drag: [{ gesture: 'drag' }],
    },
  },
});

if (ctx) {
  state.gpu = 'ok';
  const { renderer, input, gestures, audio, ui, save } = ctx;

  // --- Atlas and material -----------------------------------------------------------------
  const atlas = renderer.textureFromSource(buildAtlas(), 'dungeon-atlas');
  const material = renderer.createSpriteMaterial(atlas, 'dungeon', { sampler: 'nearest-clamp' });
  const UV = {
    floorA: cellUv(CELL.floorA),
    floorB: cellUv(CELL.floorB),
    wall: cellUv(CELL.wall),
    torch: cellUv(CELL.torch),
    coin: cellUv(CELL.coin),
    player: cellUv(CELL.player),
    white: cellUv(CELL.white),
    bat: [cellUv(CELL.bat0), cellUv(CELL.bat1), cellUv(CELL.bat2), cellUv(CELL.bat3)],
  };

  // --- Map --------------------------------------------------------------------------------
  const map = buildMap();
  const tiles: DrawParams[] = [];
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const wall = isSolid(map, tx, ty);
      const uv = wall ? UV.wall : (tx * 7 + ty * 13) % 5 === 0 ? UV.floorB : UV.floorA;
      tiles.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2, w: TILE, h: TILE, uv });
    }
  }

  // --- Torches ----------------------------------------------------------------------------
  const torchTint = map.torches.map(() => [1.6, 1.1, 0.5, 1]);
  const torches: DrawParams[] = map.torches.map((t, i) => ({
    x: t.x * TILE + TILE / 2,
    y: t.y * TILE + TILE / 2,
    w: TILE,
    h: TILE,
    uv: UV.torch,
    tint: torchTint[i],
    emissive: 1.4,
  }));

  // --- Coins ------------------------------------------------------------------------------
  const coinAlive = map.coins.map(() => true);
  const coins: DrawParams[] = map.coins.map((c) => ({
    x: c.x * TILE + TILE / 2,
    y: c.y * TILE + TILE / 2,
    w: 24,
    h: 24,
    uv: UV.coin,
    emissive: 0.4,
  }));
  state.coinsOnFloor = coins.length;

  // --- Bats -------------------------------------------------------------------------------
  const random = rng(11);
  const batVel = new Float32Array(BAT_COUNT * 2);
  const batPhase = new Float32Array(BAT_COUNT);
  const bats: DrawParams[] = [];
  for (let i = 0; i < BAT_COUNT; i++) {
    const t = map.openTiles[Math.floor(random() * map.openTiles.length)]!;
    const a = random() * Math.PI * 2;
    const speed = 40 + random() * 50;
    batVel[i * 2] = Math.cos(a) * speed;
    batVel[i * 2 + 1] = Math.sin(a) * speed;
    batPhase[i] = random() * 4;
    bats.push({
      x: t.x * TILE + TILE / 2,
      y: t.y * TILE + TILE / 2,
      w: TILE,
      h: TILE,
      uv: UV.bat[0],
      tint: [1, 1, 1, 1],
    });
  }
  state.bats = BAT_COUNT;

  // --- Player -----------------------------------------------------------------------------
  const playerTint = [1, 1, 1, 1];
  const player: DrawParams = {
    x: SPAWN_TILE.x * TILE + TILE / 2,
    y: SPAWN_TILE.y * TILE + TILE / 2,
    w: TILE,
    h: TILE,
    uv: UV.player,
    tint: playerTint,
    emissive: 0.6,
  };
  const moved = { x: 0, y: 0 };
  let hitFlash = 0;
  let hitCooldown = 0;

  // --- Fog: one dark quad per tile on its own layer, alpha by distance from the player -------
  const fogTint = tiles.map(() => [0, 0, 0, 0]);
  const fog: DrawParams[] = tiles.map((t, i) => ({
    x: t.x,
    y: t.y,
    w: TILE,
    h: TILE,
    uv: UV.white,
    tint: fogTint[i],
    layers: FOG_LAYER,
  }));

  // --- Audio: synthesised, on the sfx bus ---------------------------------------------------
  audio.define('pickup', recipes.chime({ pitch: 1320, length: 0.5, brightness: 0.7 }));
  audio.define('hit', recipes.thud({ pitch: 90, length: 0.8 }));

  // --- Save -------------------------------------------------------------------------------
  state.coins = save.get().coins;

  // --- HUD --------------------------------------------------------------------------------
  const hud = h('div', {
    id: 'dungeon-coins',
    style: {
      fontFamily: 'var(--tc-font-display)',
      fontSize: 'var(--tc-font-size-l)',
      color: 'var(--tc-color-text)',
    },
  });
  const refreshHud = () => {
    hud.textContent = `Coins: ${state.coins}`;
  };
  refreshHud();
  ui.layout.add(hud, { place: { default: 'top' }, order: 0 });

  // --- Pause menu -------------------------------------------------------------------------
  // The engine's `ctx.padNav` reads the real gamepads; this one also sees the demo's fake pad,
  // so the spec can walk the menu with synthetic d-pad presses.
  const padNav = new PadNav(ui.stack, {
    getGamepads: () => [fakePad, ...(navigator.getGamepads?.() ?? [])],
  });
  let menuClosedTick = -10;
  let tick = 0;

  function openMenu(): void {
    if (ui.stack.topModalElement) return;
    state.paused = true;
    const resume = button('Resume', () => ui.stack.pop('programmatic'), { variant: 'primary' });
    resume.id = 'dungeon-resume';
    const fogBtn = button(state.fog ? 'Fog: on' : 'Fog: off', () => {
      api.setFog(!state.fog);
      fogBtn.textContent = state.fog ? 'Fog: on' : 'Fog: off';
    });
    fogBtn.id = 'dungeon-fog';
    const reset = button('Reset coins', () => {
      state.coins = 0;
      save.update(() => ({ coins: 0 }));
      save.flush();
      refreshHud();
    });
    reset.id = 'dungeon-reset';
    const content = h(
      'div',
      { style: { display: 'grid', gap: '8px', minWidth: '220px' } },
      resume,
      fogBtn,
      reset,
    );
    // The d-pad keys walk the menu too: the engine's panel only handles Tab and Escape.
    content.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const panel = ui.stack.topModalElement;
      if (!panel) return;
      const items = focusableWithin(panel);
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length]?.focus();
      e.preventDefault();
    });
    ui.stack.push({
      title: 'Paused',
      content,
      onClose: () => {
        state.paused = false;
        menuClosedTick = tick;
      },
    });
  }

  // --- Scene ------------------------------------------------------------------------------
  let simTime = 0;

  function updateBats(dt: number): void {
    const px = player.x;
    const py = player.y;
    for (let i = 0; i < BAT_COUNT; i++) {
      const b = bats[i]!;
      let vx = batVel[i * 2]!;
      let vy = batVel[i * 2 + 1]!;
      let nx = b.x + vx * dt;
      let ny = b.y + vy * dt;
      if (isSolid(map, Math.floor(nx / TILE), Math.floor(b.y / TILE))) {
        vx = -vx;
        nx = b.x;
      }
      if (isSolid(map, Math.floor(nx / TILE), Math.floor(ny / TILE))) {
        vy = -vy;
        ny = b.y;
      }
      batVel[i * 2] = vx;
      batVel[i * 2 + 1] = vy;
      b.x = nx;
      b.y = ny;
      b.uv = UV.bat[Math.floor(simTime * 10 + batPhase[i]!) & 3];
      const dx = nx - px;
      const dy = ny - py;
      if (hitCooldown <= 0 && dx * dx + dy * dy < 18 * 18) {
        hitCooldown = 0.8;
        hitFlash = 1;
        state.hits++;
        audio.play('hit', { bus: 'sfx' });
      }
    }
  }

  function updatePlayer(dt: number): void {
    let mx = input.value('right') - input.value('left');
    let my = input.value('down') - input.value('up');
    const drag = gestures.drag;
    if (drag && (drag.phase === 'start' || drag.phase === 'move')) {
      const dx = drag.x - drag.origin.x;
      const dy = drag.y - drag.origin.y;
      const len = Math.hypot(dx, dy);
      if (len > 8) {
        mx = dx / len;
        my = dy / len;
      }
    }
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    if (len > 0) {
      moveBox(
        map,
        player.x,
        player.y,
        PLAYER_HALF,
        mx * PLAYER_SPEED * dt,
        my * PLAYER_SPEED * dt,
        moved,
      );
      player.x = moved.x;
      player.y = moved.y;
    }
    for (let i = 0; i < coins.length; i++) {
      if (!coinAlive[i]) continue;
      const c = coins[i]!;
      if (Math.abs(c.x - player.x) < 20 && Math.abs(c.y - player.y) < 20) {
        coinAlive[i] = false;
        state.coinsOnFloor--;
        state.coins++;
        save.update((d) => ({ coins: d.coins + 1 }));
        save.flush();
        refreshHud();
        audio.play('pickup', { bus: 'sfx' });
      }
    }
  }

  function updateFog(): void {
    const px = player.x / TILE - 0.5;
    const py = player.y / TILE - 0.5;
    for (let i = 0; i < fog.length; i++) {
      const tx = i % MAP_W;
      const ty = (i - tx) / MAP_W;
      let d = Math.hypot(tx - px, ty - py);
      for (let t = 0; t < map.torches.length; t++) {
        const to = map.torches[t]!;
        const dt = Math.hypot(tx - to.x, ty - to.y) + 2.5;
        if (dt < d) d = dt;
      }
      const a = Math.min(1, Math.max(0, (d - FOG_NEAR) / (FOG_FAR - FOG_NEAR)));
      fogTint[i]![3] = a * 0.96;
    }
  }

  const dungeon: Scene<typeof ctx, Frame> = {
    name: 'dungeon',
    update(dt) {
      tick++;
      if (input.pressed('pause') && !state.paused && tick - menuClosedTick > 2) openMenu();
      if (state.paused) return;
      updatePlayer(dt);
      if (!state.parked) {
        simTime += dt;
        updateBats(dt);
      }
      hitCooldown = Math.max(0, hitCooldown - dt);
      hitFlash = Math.max(0, hitFlash - dt * 3);
      updateFog();
      state.playerPos.x = player.x;
      state.playerPos.y = player.y;
      state.playerTile.x = Math.floor(player.x / TILE);
      state.playerTile.y = Math.floor(player.y / TILE);
    },
    render(frame) {
      frame.clear(0.02, 0.015, 0.03);
      for (let i = 0; i < tiles.length; i++) frame.sprite(material, tiles[i]!);
      for (let i = 0; i < coins.length; i++) if (coinAlive[i]) frame.sprite(material, coins[i]!);
      const t = state.parked ? 0 : simTime;
      for (let i = 0; i < torches.length; i++) {
        const f = flicker(t, { seed: i, speed: 7, amount: 0.35, base: 1 });
        const tint = torchTint[i]!;
        tint[0] = 1.6 * f;
        tint[1] = 1.1 * f;
        tint[2] = 0.5 * f;
        frame.sprite(material, torches[i]!);
      }
      for (let i = 0; i < BAT_COUNT; i++) frame.sprite(material, bats[i]!);
      playerTint[1] = 1 - hitFlash * 0.8;
      playerTint[2] = 1 - hitFlash * 0.8;
      frame.sprite(material, player);
      for (let i = 0; i < fog.length; i++) {
        if (fogTint[i]![3] > 0.01) frame.sprite(material, fog[i]!);
      }
    },
  };

  // --- Hooks and the __demo surface ----------------------------------------------------------
  ctx.hooks.update = () => {
    padNav.update();
  };
  ctx.hooks.afterRender = (time) => {
    state.frame = time.frame;
    const fps = time.frameDt > 0 ? 1 / time.frameDt : 0;
    state.fps = state.fps === 0 ? fps : state.fps + (fps - state.fps) * 0.1;
    state.stats = renderer.stats;
    state.drawCalls = renderer.stats.drawCalls;
    const active = document.activeElement;
    state.focused =
      ui.stack.topModalElement && active instanceof HTMLElement && active.textContent
        ? active.textContent
        : null;
  };

  const api: DemoApi = {
    state,
    isSolid: (tx, ty) => isSolid(map, tx, ty),
    pad(index, pressed) {
      const b = padButtons[index];
      if (b) b.pressed = pressed;
    },
    park(on) {
      state.parked = on;
    },
    setFog(on) {
      state.fog = on;
      ctx.camera.layers = on ? 0xffffffff : ~FOG_LAYER >>> 0;
    },
  };
  demoWindow.__demo = api;

  ctx.stack.push(dungeon);
  ctx.loop.start();
  ui.toasts.show(
    `Arrows / WASD / drag to move, Esc or Start to pause. First coin: ${FIRST_COIN_TILE.x},${FIRST_COIN_TILE.y}`,
    { duration: 4000 },
  );
} else {
  demoWindow.__demo = {
    state,
    isSolid: () => true,
    pad() {},
    park() {},
    setFog() {},
  };
}
