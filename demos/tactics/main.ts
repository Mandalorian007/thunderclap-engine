/**
 * ThunderClap demo: tactics. An isometric turn-based skirmish on a 24×24 diamond map with two
 * elevation steps: four player units against six raiders, move and attack ranges as tile
 * overlays, a path preview under the cursor, tweened steps with a facing flipbook, a hit burst
 * and damage caption, a flow-field enemy turn, pinch/wheel zoom with drag pan, a d-pad cursor
 * and a win/lose panel.
 *
 * Rendering: the whole scene (tile tops, cliff risers, overlays, units, health bars) is one
 * list of sprites from one canvas-painted atlas, submitted in depth order (tx + ty ascending,
 * the tile's stack then its overlay then the unit on it), so it is one draw call plus the
 * particle drawable. `createTileLayer` lays a rectangular grid and cannot stagger a diamond,
 * depth-sort against units or lift a tile by its elevation, so a sorted sprite list it is.
 *
 * The iso projection and inverse (`iso.ts`), the rules (`rules.ts`), the map (`map.ts`) and the
 * AI are the demo's; the engine supplies the renderer, nav flow field, tweens, input and
 * gestures, UI layout, anchors and panels, particles and synthesised audio.
 */
import { createGame } from '@thunderclap-engine/engine';
import { recipes } from '@thunderclap-engine/engine/audio';
import { createRandom, type Scene } from '@thunderclap-engine/engine/core';
import type { GamepadLike } from '@thunderclap-engine/engine/input';
import { createFlowField, createNavGrid } from '@thunderclap-engine/engine/nav';
import {
  type DrawParams,
  type Frame,
  hex,
  type RenderStats,
  type RGBA,
} from '@thunderclap-engine/engine/render';
import { createTweens, ease } from '@thunderclap-engine/engine/tween';
import { button, h } from '@thunderclap-engine/engine/ui';
import { buildAtlas, CELL, CELL_SIZE, cellUv } from './atlas';
import { DESIGN_H, DESIGN_W, MAP, tileToWorld, worldToTile } from './iso';
import { buildMap, inBounds, index, MAX_ELEVATION, TERRAIN_COST, TERRAIN_NAME, WATER } from './map';
import {
  canReach,
  createMoveRange,
  ENEMY_KIND,
  facingOf,
  floodMoves,
  inAttackRange,
  type MoveRange,
  makeUnit,
  PLAYER_KINDS,
  pathTo,
  stepCost,
  tileDistance,
  type Unit,
} from './rules';

const params = new URLSearchParams(location.search);
const STILL = params.has('still');
const SEED = Number(params.get('seed') ?? (STILL ? 1 : Math.floor(Math.random() * 1e9))) || 1;
/** Seconds per tile step and per attack. */
const STEP_SECONDS = 0.14;
const ATTACK_SECONDS = 0.25;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

export type Phase = 'player' | 'enemy' | 'over';

export interface DemoState {
  frame: number;
  fps: number;
  stats: RenderStats | null;
  drawCalls: number;
  gpu: 'ok' | 'unsupported' | 'pending';
  seed: number;
  turn: number;
  phase: Phase;
  /** Living units per side. */
  units: { player: number; enemy: number };
  /** Tile under the cursor (pointer or pad), or -1,-1 when off the map. */
  cursorTile: { x: number; y: number };
  /** Selected unit id or null. */
  selected: number | null;
  /** Steps in the previewed (or running) path. */
  pathLength: number;
  /** Steps of the last completed move. */
  lastPathLength: number;
  /** A hash of the map's terrain and elevation; equal for equal seeds. */
  mapHash: number;
  /** True while a move or attack animation runs or the enemy acts. */
  busy: boolean;
  /** Winner once `phase` is `over`. */
  winner: 'player' | 'enemy' | null;
  /** Fake-pad button downs the input has polled (counted in the sim step that read them). */
  padPresses: number;
  /** Fake-pad button ups the input has polled. A press before the last up is counted is merged. */
  padReleases: number;
}

export interface UnitInfo {
  id: number;
  side: 'player' | 'enemy';
  name: string;
  tx: number;
  ty: number;
  hp: number;
  moved: boolean;
  acted: boolean;
  alive: boolean;
}

export interface DemoApi {
  state: DemoState;
  tileInfo(tx: number, ty: number): { elevation: number; terrain: string } | null;
  unitList(): UnitInfo[];
  /** Latched fake gamepad button (standard mapping). */
  pad(index: number, pressed: boolean): void;
  endTurn(): void;
}

const demoWindow = window as unknown as { __demo?: DemoApi };

const state: DemoState = {
  frame: 0,
  fps: 0,
  stats: null,
  drawCalls: 0,
  gpu: 'pending',
  seed: SEED,
  turn: 1,
  phase: 'player',
  units: { player: 0, enemy: 0 },
  cursorTile: { x: -1, y: -1 },
  selected: null,
  pathLength: 0,
  lastPathLength: 0,
  mapHash: 0,
  busy: false,
  winner: null,
  padPresses: 0,
  padReleases: 0,
};

// Fake gamepad, latched so a scripted press survives until the action map has seen it.
const padButtons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
const fakePad: GamepadLike = { connected: true, buttons: padButtons, axes: [0, 0, 0, 0] };
const padSeen = padButtons.map(() => false);
const padReleasePending = padButtons.map(() => false);
// What the input's last poll read per button, for the `padPresses`/`padReleases` counts.
const padPolledDown = padButtons.map(() => false);

const ctx = await createGame({
  root: document.getElementById('app')!,
  title: 'ThunderClap demo: tactics',
  design: { width: DESIGN_W, height: DESIGN_H },
  post: { mist: { enabled: false }, bloom: { enabled: false } },
  input: {
    bindings: {
      select: [{ gesture: 'tap' }, { padButton: 0 }, { key: 'Enter' }, { key: 'Space' }],
      cancel: [{ key: 'Escape' }, { padButton: 1 }],
      cursorUp: [{ key: 'ArrowUp' }, { padButton: 12 }],
      cursorDown: [{ key: 'ArrowDown' }, { padButton: 13 }],
      cursorLeft: [{ key: 'ArrowLeft' }, { padButton: 14 }],
      cursorRight: [{ key: 'ArrowRight' }, { padButton: 15 }],
      endTurn: [{ key: 'KeyE' }, { padButton: 3 }],
      zoomIn: [{ wheel: -1 }, { key: 'Equal' }],
      zoomOut: [{ wheel: 1 }, { key: 'Minus' }],
      drag: [{ gesture: 'drag' }],
    },
    getGamepads: () => [fakePad, ...(navigator.getGamepads?.() ?? [])],
  },
});

if (ctx) {
  state.gpu = 'ok';
  const { renderer, input, gestures, audio, ui, camera } = ctx;
  const map = buildMap(SEED);
  for (let i = 0; i < map.terrain.length; i++) {
    state.mapHash = (Math.imul(state.mapHash, 31) + map.terrain[i]! * 4 + map.elevation[i]!) | 0;
  }
  const random = createRandom(SEED).fork('ai');
  const tweens = createTweens();

  // --- Atlas, material and reusable draw params --------------------------------------------------
  const atlas = renderer.textureFromSource(buildAtlas(), 'tactics-atlas');
  const material = renderer.createSpriteMaterial({
    texture: atlas,
    label: 'tactics',
    sampler: 'nearest-clamp',
  });
  const WHITE: RGBA = [1, 1, 1, 1];
  const TINT_MOVE = hex('#3b8cff', 0.6);
  const TINT_ATTACK = hex('#ff4a3a', 0.6);
  const TINT_PATH = hex('#ffd23b', 0.75);
  const TINT_CURSOR = hex('#ffffff', 1);
  const TINT_CURSOR_BAD = hex('#ff6060', 1);
  const TINT_PLAYER = hex('#5aa0ff');
  const TINT_ENEMY = hex('#ff6a5a');
  const TINT_DONE = hex('#8a8a96');
  const TINT_SHADOW: RGBA = [0, 0, 0, 0.35];
  const TINT_HP_BG: RGBA = [0, 0, 0, 0.7];
  const TINT_HP: RGBA = hex('#5ff07a');
  const TINT_HP_LOW: RGBA = hex('#ff5a4a');

  const sprite = (cell: number, tint: RGBA): DrawParams => ({
    x: 0,
    y: 0,
    w: CELL_SIZE,
    h: CELL_SIZE,
    uv: cellUv(cell),
    tint,
  });

  const pos = { x: 0, y: 0 };
  /** Tile tops, one per tile, centred on the tile's top diamond. */
  const tops: DrawParams[] = [];
  /** Risers per elevation level per tile (`risers[tile][level]`). */
  const risers: DrawParams[][] = [];
  const overlays: DrawParams[] = [];
  const cursorSprite = sprite(CELL.cursor, TINT_CURSOR);
  for (let ty = 0; ty < MAP; ty++) {
    for (let tx = 0; tx < MAP; tx++) {
      const i = index(tx, ty);
      const e = map.elevation[i]!;
      tileToWorld(tx, ty, e, pos);
      const top = sprite(map.terrain[i]!, WHITE);
      top.x = pos.x;
      top.y = pos.y;
      tops.push(top);
      const stack: DrawParams[] = [];
      for (let level = 1; level <= e; level++) {
        tileToWorld(tx, ty, level, pos);
        const r = sprite(CELL.riser, WHITE);
        r.x = pos.x;
        r.y = pos.y;
        stack.push(r);
      }
      risers.push(stack);
      const o = sprite(CELL.overlay, TINT_MOVE);
      o.x = top.x;
      o.y = top.y;
      overlays.push(o);
    }
  }
  /** Tile indices in painter's order: back to front along tx + ty. */
  const drawOrder = Array.from({ length: MAP * MAP }, (_, i) => i).sort((a, b) => {
    const ax = a % MAP;
    const ay = (a - ax) / MAP;
    const bx = b % MAP;
    const by = (b - bx) / MAP;
    return ax + ay - (bx + by) || ax - bx;
  });

  // --- Units ---------------------------------------------------------------------------------------
  const units: Unit[] = [];
  map.playerSpawns.forEach((s, i) => {
    units.push(makeUnit(units.length, 'player', PLAYER_KINDS[i]!, s.x, s.y));
  });
  for (const s of map.enemySpawns)
    units.push(makeUnit(units.length, 'enemy', ENEMY_KIND, s.x, s.y));
  for (const u of units) {
    tileToWorld(u.tx, u.ty, map.elevation[index(u.tx, u.ty)]!, pos);
    u.x = pos.x;
    u.y = pos.y;
  }
  const unitSprites = units.map((u) =>
    sprite(CELL.unit0, u.side === 'player' ? TINT_PLAYER : TINT_ENEMY),
  );
  const shadowSprites = units.map(() => sprite(CELL.shadow, TINT_SHADOW));
  const hpBg = units.map(() => sprite(CELL.white, TINT_HP_BG));
  const hpFill = units.map(() => sprite(CELL.white, TINT_HP));
  /** Unit id per tile or -1, rebuilt every frame from the units' logical tiles. */
  const occupied = new Int16Array(MAP * MAP).fill(-1);
  const rebuildOccupancy = () => {
    occupied.fill(-1);
    for (const u of units) if (u.alive) occupied[index(u.tx, u.ty)] = u.id;
  };
  rebuildOccupancy();
  const countUnits = () => {
    state.units.player = units.filter((u) => u.alive && u.side === 'player').length;
    state.units.enemy = units.filter((u) => u.alive && u.side === 'enemy').length;
  };
  countUnits();

  // --- Nav: the flow field for the enemy turn -------------------------------------------------
  const grid = createNavGrid({
    width: MAP,
    height: MAP,
    cellSize: 1,
    walkable: (x, y) => map.terrain[index(x, y)] !== WATER,
    cost: (x, y) =>
      map.terrain[index(x, y)] === WATER ? 1 : TERRAIN_COST[map.terrain[index(x, y)]!]!,
  });
  const flow = createFlowField(grid);
  const STEP_X = [1, -1, 0, 0];
  const STEP_Y = [0, 0, 1, -1];

  // --- Selection, ranges and overlays ---------------------------------------------------------
  const range: MoveRange = createMoveRange();
  const path = new Int16Array(MAP * MAP);
  let pathLength = 0;
  /** 0 none, 1 move, 2 attack, 3 path. */
  const overlayKind = new Uint8Array(MAP * MAP);
  let selected: Unit | null = null;
  /** The cursor tile; -1 when off the map. Pad steps it, the pointer overrides while it moves. */
  const cursor = { x: -1, y: -1 };
  let padCursor = false;
  const lastPointer = { x: Number.NaN, y: Number.NaN };
  const world = { x: 0, y: 0, z: 0 };

  const unitAt = (tx: number, ty: number): Unit | null => {
    if (!inBounds(tx, ty)) return null;
    const id = occupied[index(tx, ty)]!;
    return id >= 0 ? units[id]! : null;
  };

  const attackTargets = (u: Unit): Unit[] =>
    units.filter((t) => t.alive && t.side !== u.side && inAttackRange(u, t.tx, t.ty));

  const refreshOverlays = () => {
    overlayKind.fill(0);
    pathLength = 0;
    if (selected?.alive) {
      if (!selected.moved) {
        for (let i = 0; i < overlayKind.length; i++) if (canReach(range, i)) overlayKind[i] = 1;
      }
      // Attack reach from where the unit stands (or from any reachable tile when it may still move).
      for (let ty = 0; ty < MAP; ty++) {
        for (let tx = 0; tx < MAP; tx++) {
          const i = index(tx, ty);
          if (overlayKind[i] === 1 || i === range.origin) continue;
          const d = tileDistance(selected.tx, selected.ty, tx, ty);
          if (d >= 1 && d <= selected.range) overlayKind[i] = 2;
        }
      }
      if (!selected.moved && inBounds(cursor.x, cursor.y)) {
        pathLength = pathTo(range, index(cursor.x, cursor.y), path);
        for (let k = 0; k < pathLength; k++) overlayKind[path[k]!] = 3;
      }
    }
    state.pathLength = pathLength;
    state.selected = selected ? selected.id : null;
  };

  const select = (u: Unit | null) => {
    selected = u;
    if (u) {
      rebuildOccupancy();
      floodMoves(map, occupied, u, u.moved ? 0 : u.move, range);
      audio.play('select', { bus: 'sfx' });
    }
    refreshOverlays();
    refreshPanel();
  };

  /** An element with inline CSS text (`h`'s `style` takes an object). */
  const styled = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    css: string,
  ): HTMLElementTagNameMap[K] => {
    const el = h(tag);
    el.style.cssText = css;
    return el;
  };

  // --- Animation: steps, attacks, captions ---------------------------------------------------
  const anchors = ui.anchors(() => camera);
  const caption = (text: string, u: Unit, color: string) => {
    const el = styled(
      'div',
      `font: 700 22px/1 system-ui, sans-serif; color: ${color}; text-shadow: 0 1px 2px #000, 0 0 6px #000; pointer-events: none;`,
    );
    el.textContent = text;
    const anchor = anchors.add(el, [u.x, u.y - 64, 0], { align: [0.5, 1] });
    const rise = { y: u.y - 64, a: 1 };
    tweens
      .to(rise, { y: u.y - 110, a: 0 }, 0.9, {
        ease: ease.quadOut,
        onUpdate: () => {
          anchor.set([u.x, rise.y, 0]);
          el.style.opacity = String(rise.a);
        },
      })
      .then(() => anchor.remove());
  };

  const stepTo = (u: Unit, tileIndex: number): Promise<void> => {
    const tx = tileIndex % MAP;
    const ty = (tileIndex - tx) / MAP;
    u.facing = facingOf(u.tx, u.ty, tx, ty);
    u.tx = tx;
    u.ty = ty;
    rebuildOccupancy();
    tileToWorld(tx, ty, map.elevation[tileIndex]!, pos);
    audio.play('step', { bus: 'sfx' });
    return new Promise((resolve) => {
      tweens.to(u, { x: pos.x, y: pos.y }, STEP_SECONDS, { ease: ease.linear }).then(resolve);
    });
  };

  const moveAlong = async (u: Unit, steps: Int16Array, n: number) => {
    for (let k = 0; k < n; k++) await stepTo(u, steps[k]!);
    u.moved = true;
  };

  const attack = (attacker: Unit, target: Unit): Promise<void> => {
    attacker.facing = facingOf(attacker.tx, attacker.ty, target.tx, target.ty);
    const back = { x: attacker.x, y: attacker.y };
    tileToWorld(target.tx, target.ty, map.elevation[index(target.tx, target.ty)]!, pos);
    const lunge = { x: back.x + (pos.x - back.x) * 0.3, y: back.y + (pos.y - back.y) * 0.3 };
    return new Promise((resolve) => {
      tweens
        .sequence(
          tweens.to(attacker, lunge, ATTACK_SECONDS * 0.4, { ease: ease.quadIn }),
          tweens.to(attacker, back, ATTACK_SECONDS * 0.6, { ease: ease.quadOut }),
        )
        .then(resolve);
      tweens.delay(ATTACK_SECONDS * 0.4).then(() => {
        target.hp = Math.max(0, target.hp - attacker.damage);
        audio.play('hit', { bus: 'sfx' });
        ctx.particles.emit(
          {
            x: target.x,
            y: target.y - 30,
            shape: { kind: 'circle', radius: 6 },
            colorStart: target.side === 'player' ? hex('#7fb4ff') : hex('#ffb24a'),
            speed: [120, 320],
            life: [0.25, 0.5],
            size: [3, 7],
            gravity: [0, 500],
          },
          24,
        );
        caption(`-${attacker.damage}`, target, target.side === 'player' ? '#ff6a5a' : '#ffd23b');
        if (target.hp <= 0) {
          target.alive = false;
          rebuildOccupancy();
          countUnits();
        }
      });
    });
  };

  const checkOver = (): boolean => {
    countUnits();
    if (state.units.enemy === 0 || state.units.player === 0) {
      state.phase = 'over';
      state.winner = state.units.enemy === 0 ? 'player' : 'enemy';
      select(null);
      refreshTurnBar();
      ui.stack.push({
        title: state.winner === 'player' ? 'Victory' : 'Defeat',
        content: h(
          'div',
          { style: { display: 'grid', gap: '12px', minWidth: '220px' } },
          h(
            'p',
            { style: { margin: '0' } },
            state.winner === 'player'
              ? `All raiders down on turn ${state.turn}.`
              : `Your squad fell on turn ${state.turn}.`,
          ),
          button('Play again', () => location.reload(), { variant: 'primary' }),
        ),
        dismissible: false,
      });
      return true;
    }
    return false;
  };

  // --- Player actions ------------------------------------------------------------------------
  const finishUnit = (u: Unit) => {
    u.moved = true;
    u.acted = true;
    if (selected === u) select(null);
    refreshTurnBar();
  };

  const playerAttack = async (u: Unit, target: Unit) => {
    state.busy = true;
    await attack(u, target);
    state.busy = false;
    finishUnit(u);
    checkOver();
  };

  const playerMove = async (u: Unit, tileIndex: number) => {
    const n = pathTo(range, tileIndex, path);
    if (n === 0) return;
    const steps = path.slice(0, n);
    state.busy = true;
    state.pathLength = n;
    overlayKind.fill(0);
    for (let k = 0; k < n; k++) overlayKind[steps[k]!] = 3;
    await moveAlong(u, steps, n);
    state.lastPathLength = n;
    state.busy = false;
    if (state.phase !== 'player') return;
    if (attackTargets(u).length > 0) {
      // Still selected: the attack overlay shows; clicking anything else ends the unit.
      floodMoves(map, occupied, u, 0, range);
      refreshOverlays();
      refreshPanel();
    } else finishUnit(u);
  };

  const confirm = (tx: number, ty: number) => {
    if (state.phase !== 'player' || state.busy || ui.stack.topModalElement) return;
    if (!inBounds(tx, ty)) {
      if (selected?.moved) finishUnit(selected);
      else select(null);
      return;
    }
    const target = unitAt(tx, ty);
    if (selected) {
      if (target && target.side === 'enemy' && inAttackRange(selected, tx, ty)) {
        void playerAttack(selected, target);
        return;
      }
      if (target === selected) {
        if (selected.moved) finishUnit(selected);
        else select(null);
        return;
      }
      if (!selected.moved && !target && canReach(range, index(tx, ty))) {
        void playerMove(selected, index(tx, ty));
        return;
      }
      if (target && target.side === 'player' && !target.acted) {
        if (selected.moved) finishUnit(selected);
        select(target);
        return;
      }
      // An unreachable or out-of-range tile: a moved unit is done; an unmoved one stays selected.
      if (selected.moved) finishUnit(selected);
      return;
    }
    if (target && target.side === 'player' && !target.acted) select(target);
  };

  // --- Enemy turn: flow field toward the nearest player, step by step ------------------------
  const livingPlayers = () => units.filter((u) => u.alive && u.side === 'player');

  const enemyAct = async (e: Unit) => {
    const players = livingPlayers();
    if (players.length === 0) return;
    // Other units block the field; the goals (player tiles) stay walkable so they attract.
    for (const u of units) {
      if (!u.alive || u === e) continue;
      grid.setWalkable(u.tx, u.ty, u.side === 'player');
    }
    flow.build(players.map((p) => ({ x: p.tx, y: p.ty })));
    let budget = e.move;
    let from = index(e.tx, e.ty);
    for (let guard = 0; guard < 8 && attackTargets(e).length === 0; guard++) {
      const fx = from % MAP;
      const fy = (from - fx) / MAP;
      // The field is 8-neighbour and movement is 4-neighbour, so descend its distances over the
      // four neighbours: the cheapest-to-goal free tile this unit can still afford.
      let next = -1;
      let cost = 0;
      let best = flow.distances[from]!;
      for (let k = 0; k < 4; k++) {
        const nx = fx + STEP_X[k]!;
        const ny = fy + STEP_Y[k]!;
        if (!inBounds(nx, ny)) continue;
        const ni = index(nx, ny);
        if (occupied[ni] !== -1) continue;
        const c = stepCost(map, from, ni);
        if (!Number.isFinite(c) || c > budget) continue;
        const d = flow.distances[ni]!;
        if (d < best) {
          best = d;
          next = ni;
          cost = c;
        }
      }
      if (next < 0) break;
      budget -= cost;
      await stepTo(e, next);
      from = next;
    }
    for (const u of units) if (u.alive) grid.setWalkable(u.tx, u.ty, true);
    const targets = attackTargets(e);
    if (targets.length > 0) {
      // Weakest target; the seeded roll breaks ties.
      targets.sort((a, b) => a.hp - b.hp || (random.bool(0.5) ? -1 : 1));
      await attack(e, targets[0]!);
    }
  };

  const runEnemyTurn = async () => {
    state.phase = 'enemy';
    state.busy = true;
    select(null);
    refreshTurnBar();
    for (const e of units) {
      if (!e.alive || e.side !== 'enemy') continue;
      await enemyAct(e);
      if (checkOver()) {
        state.busy = false;
        return;
      }
      await new Promise<void>((r) => tweens.delay(0.08).then(r));
    }
    for (const u of units) {
      u.moved = false;
      u.acted = false;
    }
    state.turn += 1;
    state.phase = 'player';
    state.busy = false;
    refreshTurnBar();
    ui.toasts.show(`Turn ${state.turn}`, { duration: 1200 });
  };

  const endTurn = () => {
    if (state.phase !== 'player' || state.busy) return;
    void runEnemyTurn();
  };

  // --- HUD: turn order bar and unit panel --------------------------------------------------------
  const turnBar = styled(
    'div',
    'display:flex; gap:6px; align-items:center; padding:6px 10px; font: 600 14px system-ui, sans-serif; color:#eef; background: rgba(8,10,18,0.7); border-radius: 8px; flex-wrap: wrap; justify-content:center;',
  );
  const endTurnButton = button('End turn', endTurn, { variant: 'ghost' });
  const refreshTurnBar = () => {
    turnBar.replaceChildren();
    turnBar.append(
      h('span', { style: { marginRight: '6px' } }, `Turn ${state.turn} · ${state.phase}`),
    );
    for (const u of units) {
      const chip = styled(
        'span',
        `padding:2px 8px; border-radius: 999px; border: 2px solid ${u.side === 'player' ? '#5aa0ff' : '#ff6a5a'}; opacity: ${u.alive ? (u.acted ? '0.4' : '1') : '0.15'};${selected === u ? ' background:#fff3;' : ''}`,
      );
      chip.textContent = u.name;
      turnBar.append(chip);
    }
    turnBar.append(endTurnButton);
    endTurnButton.disabled = state.phase !== 'player';
  };
  ui.layout.add(turnBar, { place: { default: 'top' }, order: 0 });

  const panel = styled(
    'div',
    'min-width: 180px; padding: 8px 12px; font: 14px/1.4 system-ui, sans-serif; color:#eef; background: rgba(8,10,18,0.75); border-radius: 8px;',
  );
  const panelHandle = ui.layout.add(panel, { place: { default: 'bottom' }, order: 0 });
  let panelText = '';
  const refreshPanel = () => {
    const hovered = unitAt(cursor.x, cursor.y);
    const u = hovered ?? selected;
    let text: string;
    if (u) {
      const tile = index(u.tx, u.ty);
      text = `${u.name} (${u.side}) · HP ${u.hp}/${u.hpMax} · move ${u.move} · range ${u.range} · dmg ${u.damage} · ${TERRAIN_NAME[map.terrain[tile]!]} +${map.elevation[tile]}${u.acted ? ' · done' : u.moved ? ' · moved' : ''}`;
    } else if (inBounds(cursor.x, cursor.y)) {
      const tile = index(cursor.x, cursor.y);
      text = `Tile ${cursor.x},${cursor.y} · ${TERRAIN_NAME[map.terrain[tile]!]} · height ${map.elevation[tile]}`;
    } else {
      text = 'Tap a unit, then a blue tile to move or a red one to attack. E ends the turn.';
    }
    if (text !== panelText) {
      panelText = text;
      panel.textContent = text;
    }
  };
  void panelHandle;
  refreshTurnBar();
  refreshPanel();

  // --- Audio ---------------------------------------------------------------------------------------
  audio.define('select', recipes.chime({ pitch: 880, length: 0.12 }));
  audio.define('step', recipes.click({ pitch: 300, length: 0.05 }));
  audio.define('hit', recipes.thud({ pitch: 120, length: 0.25 }));

  // --- Cursor: pointer (iso inverse) or pad ----------------------------------------------------
  const elevationAt = (tx: number, ty: number) => map.elevation[index(tx, ty)]!;
  const setCursor = (tx: number, ty: number) => {
    if (tx === cursor.x && ty === cursor.y) return;
    cursor.x = tx;
    cursor.y = ty;
    state.cursorTile.x = tx;
    state.cursorTile.y = ty;
    refreshOverlays();
    refreshPanel();
  };
  const stepCursor = (dx: number, dy: number) => {
    padCursor = true;
    let tx = cursor.x;
    let ty = cursor.y;
    if (!inBounds(tx, ty)) {
      const u = selected ?? units.find((v) => v.alive && v.side === 'player');
      tx = u ? u.tx : MAP >> 1;
      ty = u ? u.ty : MAP >> 1;
    } else {
      tx = Math.max(0, Math.min(MAP - 1, tx + dx));
      ty = Math.max(0, Math.min(MAP - 1, ty + dy));
    }
    setCursor(tx, ty);
  };

  const updateInput = () => {
    const p = input.pointer;
    const pointerMoved = p.x !== lastPointer.x || p.y !== lastPointer.y;
    lastPointer.x = p.x;
    lastPointer.y = p.y;
    if (pointerMoved) padCursor = false;

    // Pan and zoom.
    const drag = gestures.drag;
    if (drag && (drag.phase === 'start' || drag.phase === 'move')) {
      camera.x -= p.dx / camera.zoom;
      camera.y -= p.dy / camera.zoom;
    }
    const pinch = gestures.pinch;
    if (pinch && (pinch.phase === 'move' || pinch.phase === 'start') && pinch.delta > 0) {
      camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * pinch.delta));
    }
    if (p.wheelY !== 0) {
      camera.zoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, camera.zoom * (p.wheelY < 0 ? 1.1 : 1 / 1.1)),
      );
    }
    if (input.pressed('zoomIn') && p.wheelY === 0)
      camera.zoom = Math.min(MAX_ZOOM, camera.zoom * 1.1);
    if (input.pressed('zoomOut') && p.wheelY === 0)
      camera.zoom = Math.max(MIN_ZOOM, camera.zoom / 1.1);

    // Pad / key cursor.
    if (input.pressed('cursorUp')) stepCursor(0, -1);
    if (input.pressed('cursorDown')) stepCursor(0, 1);
    if (input.pressed('cursorLeft')) stepCursor(-1, 0);
    if (input.pressed('cursorRight')) stepCursor(1, 0);

    // Pointer cursor through the iso inverse.
    if (!padCursor && p.inside && !(drag && drag.phase !== 'end')) {
      camera.screenToWorld(p.x, p.y, 0, world);
      worldToTile(world.x, world.y, elevationAt, MAX_ELEVATION, pos);
      setCursor(pos.x, pos.y);
    }

    if (input.pressed('select')) {
      // A tap confirms the tile under it; the pad confirms the pad cursor.
      const tap = gestures.tap;
      if (tap && !padCursor) {
        camera.screenToWorld(tap.x, tap.y, 0, world);
        worldToTile(world.x, world.y, elevationAt, MAX_ELEVATION, pos);
        setCursor(pos.x, pos.y);
      }
      confirm(cursor.x, cursor.y);
    }
    if (input.pressed('cancel') && selected && !state.busy) {
      if (selected.moved) finishUnit(selected);
      else select(null);
    }
    if (input.pressed('endTurn')) endTurn();
  };

  // --- Render ---------------------------------------------------------------------------------------
  let animTime = 0;
  const render = (frame: Frame) => {
    frame.clear(0.04, 0.045, 0.07);
    const bob = Math.floor(animTime * 8) % 2;
    for (let k = 0; k < drawOrder.length; k++) {
      const i = drawOrder[k]!;
      const stack = risers[i]!;
      for (let r = 0; r < stack.length; r++) frame.sprite(material, stack[r]!);
      frame.sprite(material, tops[i]!);
      const kind = overlayKind[i]!;
      if (kind !== 0) {
        const o = overlays[i]!;
        o.tint = kind === 1 ? TINT_MOVE : kind === 2 ? TINT_ATTACK : TINT_PATH;
        frame.sprite(material, o);
      }
      const tx = i % MAP;
      const ty = (i - tx) / MAP;
      if (tx === cursor.x && ty === cursor.y) {
        cursorSprite.x = tops[i]!.x;
        cursorSprite.y = tops[i]!.y;
        cursorSprite.tint =
          selected && !selected.moved && !canReach(range, i) && occupied[i] === -1
            ? TINT_CURSOR_BAD
            : TINT_CURSOR;
        frame.sprite(material, cursorSprite);
      }
      const id = occupied[i]!;
      if (id >= 0) {
        const u = units[id]!;
        const moving = state.busy && (u.x !== tops[i]!.x || u.y !== tops[i]!.y);
        const sh = shadowSprites[id]!;
        sh.x = u.x;
        sh.y = u.y;
        frame.sprite(material, sh);
        const s = unitSprites[id]!;
        s.x = u.x;
        s.y = u.y - CELL_SIZE / 2 + 8;
        s.uv = cellUv(CELL.unit0 + u.facing * 2 + (moving ? bob : 0));
        s.tint =
          u.acted && u.side === 'player' && state.phase === 'player'
            ? TINT_DONE
            : u.side === 'player'
              ? TINT_PLAYER
              : TINT_ENEMY;
        frame.sprite(material, s);
        const bg = hpBg[id]!;
        bg.x = u.x;
        bg.y = u.y - 56;
        bg.w = 30;
        bg.h = 5;
        frame.sprite(material, bg);
        const fill = hpFill[id]!;
        const frac = u.hp / u.hpMax;
        fill.w = 28 * frac;
        fill.h = 3;
        fill.x = u.x - 14 + fill.w / 2;
        fill.y = bg.y;
        fill.tint = frac < 0.35 ? TINT_HP_LOW : TINT_HP;
        frame.sprite(material, fill);
      }
    }
    frame.drawable(ctx.particles, 1);
  };

  const scene: Scene<unknown, Frame> = {
    name: 'tactics',
    update(dt) {
      tweens.update(dt);
      animTime += dt;
      updateInput();
    },
    render(frame) {
      render(frame);
    },
  };

  // --- Hooks and the __demo surface ------------------------------------------------------------
  ctx.hooks.update = () => {
    for (let i = 0; i < padButtons.length; i++) {
      // `input.update()` ran just before this hook in the same step: `pressed` is what it read.
      const down = padButtons[i]!.pressed;
      if (down !== padPolledDown[i]) {
        padPolledDown[i] = down;
        if (down) state.padPresses++;
        else state.padReleases++;
      }
      if (!down) continue;
      if (!padSeen[i]) {
        padSeen[i] = true;
        continue;
      }
      if (padReleasePending[i]) {
        padButtons[i]!.pressed = false;
        padButtons[i]!.value = 0;
        padReleasePending[i] = false;
      }
    }
  };
  ctx.hooks.afterRender = (time) => {
    state.frame = time.frame;
    const fps = time.frameDt > 0 ? 1 / time.frameDt : 0;
    state.fps = state.fps === 0 ? fps : state.fps + (fps - state.fps) * 0.1;
    state.stats = renderer.stats;
    state.drawCalls = renderer.stats.drawCalls;
  };

  const api: DemoApi = {
    state,
    tileInfo(tx, ty) {
      if (!inBounds(tx, ty)) return null;
      const i = index(tx, ty);
      return { elevation: map.elevation[i]!, terrain: TERRAIN_NAME[map.terrain[i]!]! };
    },
    unitList: () =>
      units.map((u) => ({
        id: u.id,
        side: u.side,
        name: u.name,
        tx: u.tx,
        ty: u.ty,
        hp: u.hp,
        moved: u.moved,
        acted: u.acted,
        alive: u.alive,
      })),
    pad(i, pressed) {
      const b = padButtons[i];
      if (!b) return;
      if (pressed) {
        b.pressed = true;
        b.value = 1;
        padSeen[i] = false;
        padReleasePending[i] = false;
      } else if (padSeen[i]) {
        b.pressed = false;
        b.value = 0;
      } else {
        padReleasePending[i] = true;
      }
    },
    endTurn,
  };
  demoWindow.__demo = api;

  ctx.stack.push(scene);
  ctx.loop.start();
  if (!STILL) {
    ui.toasts.show(
      'Tap a unit, then a blue tile to move or a red one to attack. Drag to pan, pinch or wheel to zoom.',
      {
        duration: 4000,
      },
    );
  }
} else {
  state.gpu = 'unsupported';
  demoWindow.__demo = {
    state,
    tileInfo: () => null,
    unitList: () => [],
    pad() {},
    endTurn() {},
  };
}
