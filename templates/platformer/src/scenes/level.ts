/**
 * The level scene: input to `Intent`, the physics step, pickups, hazards, checkpoints, the exit,
 * the camera follow, and the draw. Rendering is not mechanics: `update(dt)` runs the fixed step
 * and `render` only reads positions into pre-built `DrawParams`; nothing allocates per frame.
 *
 * Draw order and count: three parallax layers + the map (one draw each), then every sprite
 * (movers, flags, door, coins, player: same material, so one batch), then the particles: six.
 */
import { createScheduler, type Scene } from '@thunderclap/engine/core';
import type { EmitParams } from '@thunderclap/engine/fx';
import {
  createFlipbook,
  createFollow2D,
  type DrawParams,
  type Flipbook,
  type Frame,
  hex,
} from '@thunderclap/engine/render';
import { ease } from '@thunderclap/engine/tween';
import type { GameCtx } from '../ctx';
import { LEVELS } from '../levels';
import { HAZARD, type Level, MOVER_H, MOVER_W, moverAt, TILE } from '../levels/format';
import { type MoverBox, touchesKind, touchesTile } from '../physics/body';
import {
  createPlayer,
  type Intent,
  JUMP_BUFFER,
  PLAYER_H,
  PLAYER_W,
  type Player,
  type PlayerState,
  placePlayer,
  stepPlayer,
} from '../physics/player';
import { recordRun, START_LIVES } from '../save/schema';
import { createHud, formatTime, type Hud } from '../ui/hud';
import { buildWorld, UV, type World } from '../world/world';
import { createPauseScene } from './pause';

const SKY = hex('#5c8fdc');
const COIN_TINT = hex('#ffffff', 1.2);
const HURT_TINT = hex('#ff6b6b', 1.4);
const WHITE = hex('#ffffff');
/** Seconds the player flashes and cannot be hurt again after a hit. */
const HURT_TIME = 1.0;
/** Running dust cadence, seconds. */
const DUST_EVERY = 0.09;

interface Coin {
  readonly col: number;
  readonly row: number;
  taken: boolean;
  /** 0 at pickup to 1 when the pop ends; drawn only while < 1. */
  pop: number;
  readonly draw: DrawParams & { uv: ArrayLike<number> };
}

interface Mover {
  readonly box: MoverBox;
  readonly draw: DrawParams;
}

export function createLevelScene(ctx: GameCtx, level: Level): Scene<GameCtx, Frame> {
  const { design } = ctx;
  const worldW = level.cols * TILE;
  const worldH = level.rows * TILE;

  let world: World | null = null;
  let hud: Hud | null = null;
  let player: Player;
  let checkpoint = -1;
  let timeMs = 0;
  let simTime = 0;
  let coinsGot = 0;
  let hurtLeft = 0;
  // The scene's clock: the running-dust cadence (the player's dash cooldown is its own).
  const timers = createScheduler();
  const dustCadence = timers.cooldown('dust', DUST_EVERY);
  let finished = false;
  let bookState: PlayerState | '' = '';

  const movers: Mover[] = level.movers.map(() => ({
    box: { x: 0, y: 0, w: MOVER_W * TILE, h: MOVER_H, dx: 0, dy: 0 },
    draw: { x: 0, y: 0, w: MOVER_W * TILE, h: MOVER_H, uv: UV.moverHalf },
  }));
  const moverBoxes: MoverBox[] = movers.map((m) => m.box);
  const moverTmp = { x: 0, y: 0, dx: 0, dy: 0 };

  const coins: Coin[] = level.coins.map((c) => ({
    col: c.col,
    row: c.row,
    taken: false,
    pop: 0,
    draw: {
      x: c.col * TILE + TILE / 2,
      y: c.row * TILE + TILE / 2,
      w: TILE,
      h: TILE,
      uv: ctx.frames.coin[0]!,
      tint: COIN_TINT,
      emissive: 0.4,
    },
  }));
  const flags: DrawParams[] = level.checkpoints.map((c) => ({
    x: c.col * TILE + TILE / 2,
    y: c.row * TILE + TILE / 2,
    w: TILE,
    h: TILE,
    uv: UV.flagOff,
  }));
  const door: DrawParams = {
    x: level.exit.col * TILE + TILE / 2,
    y: level.exit.row * TILE + TILE / 2,
    w: TILE,
    h: TILE,
    uv: UV.door,
    emissive: 0.3,
  };
  const playerDraw: DrawParams & { uv: ArrayLike<number> } = {
    x: 0,
    y: 0,
    w: TILE,
    h: TILE,
    uv: ctx.frames.idle[0]!,
    tint: WHITE,
  };
  const book: Flipbook = createFlipbook({ frames: ctx.frames.idle, fps: 4 });
  const coinBook: Flipbook = createFlipbook({ frames: ctx.frames.coin, fps: 8 });
  const intent: Intent = { move: 0, jumpPressed: false, jumpHeld: false, dashPressed: false };

  // The camera: a 180×240 dead zone around the player, 260 px of look-ahead in the run direction,
  // eased over 0.18 s, never showing outside the level. Writes `ctx.camera.x/y`.
  const follow = createFollow2D(ctx.camera, {
    deadZone: { w: 180, h: 240 },
    lookAhead: { x: 260, y: 0 },
    lookAheadSmoothing: 0.35,
    smoothing: 0.18,
    bounds: { minX: 0, minY: 0, maxX: worldW, maxY: worldH },
  });

  const dust: EmitParams = {
    x: 0,
    y: 0,
    angle: -Math.PI / 2,
    spread: 1.2,
    speed: [40, 140],
    life: [0.25, 0.5],
    size: [8, 2],
    colorStart: hex('#d8c7a8', 1),
    gravity: [0, 300],
    emissive: 0.1,
  };
  const sparkle: EmitParams = {
    x: 0,
    y: 0,
    spread: Math.PI,
    speed: [120, 360],
    life: [0.3, 0.7],
    size: [10, 2],
    colorStart: hex('#ffe066', 1.5),
    gravity: [0, 600],
    emissive: 1.2,
  };
  const hurtBurst: EmitParams = {
    x: 0,
    y: 0,
    spread: Math.PI,
    speed: [200, 500],
    life: [0.3, 0.6],
    size: [8, 2],
    colorStart: hex('#ff6b6b', 1.5),
    gravity: [0, 800],
  };

  const spawnPoint = (): { x: number; y: number } => {
    const at = checkpoint >= 0 ? level.checkpoints[checkpoint]! : level.spawn;
    spawnTmp.x = at.col * TILE + (TILE - PLAYER_W) / 2;
    spawnTmp.y = (at.row + 1) * TILE - PLAYER_H;
    return spawnTmp;
  };
  const spawnTmp = { x: 0, y: 0 };

  const respawn = () => {
    const at = spawnPoint();
    placePlayer(player, at.x, at.y);
    follow.teleport(at.x + PLAYER_W / 2, at.y + PLAYER_H / 2);
    hurtLeft = HURT_TIME;
  };

  const die = () => {
    if (hurtLeft > 0 || finished) return;
    ctx.audio.play('hurt', { bus: 'sfx' });
    hurtBurst.x = player.body.x + PLAYER_W / 2;
    hurtBurst.y = player.body.y + PLAYER_H / 2;
    ctx.particles.emit(hurtBurst, 24);
    ctx.run.lives--;
    if (ctx.run.lives <= 0) {
      finished = true;
      ctx.run.lives = START_LIVES;
      ctx.ui.toasts.show('Out of lives. Back to the title.', { tone: 'danger', duration: 3000 });
      ctx.toTitle();
      return;
    }
    hud?.setLives(ctx.run.lives);
    respawn();
  };

  const finish = () => {
    finished = true;
    const ms = Math.round(timeMs);
    let improved = false;
    ctx.save.update((p) => {
      improved = recordRun(p, level.id, ms, coinsGot);
      p.lives = ctx.run.lives;
      return p;
    });
    ctx.audio.play('coin', { bus: 'sfx', rate: 1.5 });
    ctx.ui.toasts.show(
      `${level.name} clear in ${formatTime(ms)} with ${coinsGot}/${coins.length} coins${improved ? ' (new best)' : ''}`,
      { tone: 'success', duration: 3500 },
    );
    const next = ctx.run.levelIndex + 1;
    if (next < LEVELS.length) {
      ctx.run.levelIndex = next;
      ctx.startLevel(LEVELS[next]!);
    } else {
      ctx.ui.toasts.show('All levels clear.', { tone: 'success', duration: 3500 });
      ctx.toTitle();
    }
  };

  const takeCoin = (c: Coin) => {
    c.taken = true;
    coinsGot++;
    hud?.setCoins(coinsGot, coins.length);
    ctx.audio.play('coin', { bus: 'sfx', rate: 0.9 + Math.random() * 0.2 });
    sparkle.x = c.draw.x;
    sparkle.y = c.draw.y;
    ctx.particles.emit(sparkle, 14);
    ctx.tweens.to(c, { pop: 1 }, 0.4, { ease: ease.quadOut });
    ctx.tweens.to(c.draw, { y: c.draw.y - 70 }, 0.4, { ease: ease.backOut });
  };

  const setBook = (state: PlayerState) => {
    if (state === bookState) return;
    bookState = state;
    const f = ctx.frames;
    switch (state) {
      case 'idle':
        book.play(f.idle);
        book.fps = 3;
        break;
      case 'run':
        book.play(f.run);
        book.fps = 12;
        break;
      case 'jump':
        book.play(f.jump);
        break;
      case 'fall':
        book.play(f.fall);
        break;
      case 'land':
        book.play(f.land);
        break;
      case 'dash':
        book.play(f.dash);
        break;
    }
  };

  const updateMovers = (dt: number) => {
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i]!;
      moverAt(level.movers[i]!, simTime, dt, moverTmp);
      m.box.x = moverTmp.x;
      m.box.y = moverTmp.y;
      m.box.dx = moverTmp.dx;
      m.box.dy = moverTmp.dy;
      m.draw.x = moverTmp.x + m.box.w / 2;
      m.draw.y = moverTmp.y + m.box.h / 2;
    }
  };

  return {
    name: `level-${level.id}`,
    enter() {
      world = buildWorld(ctx.renderer, ctx.atlas, level, design.width, design.height);
      hud = createHud(ctx);
      player = createPlayer(0, 0);
      timers.clear();
      checkpoint = -1;
      timeMs = 0;
      simTime = 0;
      coinsGot = 0;
      finished = false;
      updateMovers(0);
      respawn();
      hurtLeft = 0;
      hud.setCoins(0, coins.length);
      hud.setLives(ctx.run.lives);
      hud.setTime(0);
      hud.setDash(0);
    },
    exit() {
      world?.destroy();
      world = null;
      hud?.remove();
      hud = null;
    },
    update(dt) {
      if (finished) return;
      const { input } = ctx;
      if (input.pressed('pause')) {
        ctx.stack.push(createPauseScene(ctx, level));
        return;
      }
      simTime += dt;
      timeMs += dt * 1000;
      hurtLeft = Math.max(0, hurtLeft - dt);
      timers.update(dt);

      // Intent: keyboard, pad and the touch zones all arrive through the same actions.
      intent.move = input.axis('left', 'right');
      intent.jumpPressed = input.buffered('jump', JUMP_BUFFER * 1000);
      intent.jumpHeld = input.held('jump');
      intent.dashPressed = input.pressed('dash');

      updateMovers(dt);
      stepPlayer(player, intent, level, moverBoxes, dt);
      const b = player.body;

      if (player.jumped) {
        input.consume('jump');
        ctx.audio.play('jump', { bus: 'sfx' });
      }
      if (player.dashed) ctx.audio.play('jump', { bus: 'sfx', rate: 0.6 });
      if (player.landed || player.dashed) {
        dust.x = b.x + PLAYER_W / 2;
        dust.y = b.y + PLAYER_H;
        ctx.particles.emit(dust, player.dashed ? 10 : 6);
      }
      if (player.state === 'run' && b.grounded && dustCadence.use()) {
        dust.x = b.x + PLAYER_W / 2 - player.facing * 12;
        dust.y = b.y + PLAYER_H;
        ctx.particles.emit(dust, 2);
      }

      // Hazards and the pit.
      if (b.y > worldH + 4 * TILE || touchesKind(b, level, HAZARD)) {
        die();
        if (finished) return;
      }

      // Checkpoints, coins, exit.
      for (let i = 0; i < level.checkpoints.length; i++) {
        if (
          i !== checkpoint &&
          touchesTile(b, level.checkpoints[i]!.col, level.checkpoints[i]!.row)
        ) {
          checkpoint = i;
          for (let k = 0; k < flags.length; k++) flags[k]!.uv = k === i ? UV.flagOn : UV.flagOff;
          ctx.audio.play('coin', { bus: 'sfx', rate: 0.6 });
        }
      }
      for (const c of coins) if (!c.taken && touchesTile(b, c.col, c.row, 10)) takeCoin(c);
      if (touchesTile(b, level.exit.col, level.exit.row, 12)) {
        finish();
        return;
      }

      // Camera and animation.
      follow.update(
        dt,
        b.x + PLAYER_W / 2,
        b.y + PLAYER_H / 2,
        Math.abs(b.vx) > 40 ? player.facing : 0,
        0,
      );
      setBook(player.state);
      book.update(dt);
      coinBook.update(dt);

      hud?.setTime(timeMs);
      hud?.setDash(player.dash.remaining);
    },
    render(frame) {
      if (!world) return;
      frame.clear(SKY[0], SKY[1], SKY[2]);
      world.parallax.update(ctx.camera.x, ctx.camera.y);
      world.parallax.draw(frame);
      world.map.draw(frame);

      for (const m of movers) frame.sprite(ctx.atlas, m.draw);
      for (const f of flags) frame.sprite(ctx.atlas, f);
      frame.sprite(ctx.atlas, door);
      const coinUv = coinBook.uv;
      for (const c of coins) {
        if (c.pop >= 1) continue;
        c.draw.uv = coinUv;
        const s = TILE * (1 + c.pop * 0.9);
        c.draw.w = s;
        c.draw.h = s;
        frame.sprite(ctx.atlas, c.draw);
      }

      const b = player.body;
      playerDraw.x = b.x + PLAYER_W / 2;
      playerDraw.y = b.y + PLAYER_H - TILE / 2;
      playerDraw.w = TILE * player.facing;
      playerDraw.uv = book.uv;
      // Hurt flash: skip every other 1/12 s while invulnerable.
      const flash = hurtLeft > 0 && Math.floor(hurtLeft * 12) % 2 === 0;
      playerDraw.tint = flash ? HURT_TINT : WHITE;
      frame.sprite(ctx.atlas, playerDraw);

      frame.drawable(ctx.particles);
    },
  };
}
