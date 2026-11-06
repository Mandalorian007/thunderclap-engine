/**
 * The texture atlas, painted on a canvas at boot: no files, no network. Every tile, the coin and
 * player flipbook frames, the props and the parallax scenery live in one 512×512 texture of 64 px
 * cells, so the whole world is one material and the sprites batch into one draw.
 *
 * Replace this with a loaded image (`renderer.textureFromSource(img)`) and keep `CELL` in step.
 */
import { TILE } from '../levels/format';

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;
const SIZE = TILE * ATLAS_COLS;
/** Half a texel inset so nearest sampling never bleeds a neighbour cell into a sprite's edge. */
const INSET = 0.5 / SIZE;

export const CELL = {
  groundTop: 0,
  groundFill: 1,
  oneWay: 2,
  spike: 3,
  mover: 4,
  door: 5,
  flagOff: 6,
  flagOn: 7,
  coin0: 8,
  coin1: 9,
  coin2: 10,
  coin3: 11,
  idle0: 16,
  idle1: 17,
  run0: 18,
  run1: 19,
  run2: 20,
  run3: 21,
  jump: 22,
  fall: 23,
  land: 24,
  dash: 25,
  white: 26,
  peak: 32,
  mountain: 33,
  hillTop: 34,
  hill: 35,
  treeTop: 36,
  trunk: 37,
  cloud: 38,
  star: 39,
} as const;

/** UV rectangle (u0, v0, u1, v1) of atlas cell `i`, inset half a texel. */
export function cellUv(i: number): [number, number, number, number] {
  const c = i % ATLAS_COLS;
  const r = Math.floor(i / ATLAS_COLS);
  return [
    c / ATLAS_COLS + INSET,
    r / ATLAS_ROWS + INSET,
    (c + 1) / ATLAS_COLS - INSET,
    (r + 1) / ATLAS_ROWS - INSET,
  ];
}

type G = CanvasRenderingContext2D;

function at(i: number): [number, number] {
  return [(i % ATLAS_COLS) * TILE, Math.floor(i / ATLAS_COLS) * TILE];
}

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function speckle(g: G, i: number, base: [number, number, number], range: number, seed: number) {
  const [ox, oy] = at(i);
  for (let y = 0; y < TILE; y += 4) {
    for (let x = 0; x < TILE; x += 4) {
      const n = hash(x, y, seed) * range;
      g.fillStyle = `rgb(${(base[0] + n) | 0},${(base[1] + n) | 0},${(base[2] + n) | 0})`;
      g.fillRect(ox + x, oy + y, 4, 4);
    }
  }
}

function groundTop(g: G, i: number) {
  const [ox, oy] = at(i);
  speckle(g, i, [92, 64, 44], 18, 1);
  g.fillStyle = '#5fb55a';
  g.fillRect(ox, oy, TILE, 12);
  g.fillStyle = '#8fe07a';
  g.fillRect(ox, oy, TILE, 4);
  g.fillStyle = '#3f8a44';
  for (let x = 0; x < TILE; x += 8) g.fillRect(ox + x + ((hash(x, 0, 2) * 4) | 0), oy + 12, 4, 4);
}

function groundFill(g: G, i: number) {
  speckle(g, i, [84, 58, 40], 16, 3);
  const [ox, oy] = at(i);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (let k = 0; k < 6; k++) {
    g.fillRect(ox + ((hash(k, 1, 4) * 56) | 0), oy + ((hash(k, 2, 4) * 56) | 0), 8, 4);
  }
}

function oneWay(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#9a6b3c';
  g.fillRect(ox, oy, TILE, 14);
  g.fillStyle = '#c99257';
  g.fillRect(ox, oy, TILE, 5);
  g.fillStyle = '#6b4626';
  g.fillRect(ox, oy + 14, TILE, 3);
  for (let x = 8; x < TILE; x += 16) g.fillRect(ox + x, oy + 17, 4, 6);
}

function spike(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#d9dde6';
  for (let k = 0; k < 4; k++) {
    g.beginPath();
    g.moveTo(ox + k * 16, oy + TILE);
    g.lineTo(ox + k * 16 + 8, oy + 18);
    g.lineTo(ox + k * 16 + 16, oy + TILE);
    g.closePath();
    g.fill();
  }
  g.fillStyle = '#8b93a3';
  g.fillRect(ox, oy + TILE - 6, TILE, 6);
}

function mover(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#4d5d7a';
  g.fillRect(ox, oy, TILE, TILE / 2);
  g.fillStyle = '#8ea4cf';
  g.fillRect(ox, oy, TILE, 6);
  g.fillStyle = '#2f3a4e';
  g.fillRect(ox, oy + TILE / 2 - 6, TILE, 6);
  g.fillStyle = '#f2d16b';
  for (let x = 4; x < TILE; x += 20) g.fillRect(ox + x, oy + 12, 6, 6);
}

function door(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#3b2a4a';
  g.fillRect(ox + 10, oy + 4, 44, 60);
  g.fillStyle = '#8f6bd1';
  g.fillRect(ox + 16, oy + 10, 32, 54);
  g.fillStyle = '#e9d8ff';
  g.fillRect(ox + 24, oy + 16, 16, 20);
  g.fillStyle = '#ffd36b';
  g.fillRect(ox + 40, oy + 40, 5, 5);
}

function flag(g: G, i: number, on: boolean) {
  const [ox, oy] = at(i);
  g.fillStyle = '#d9dde6';
  g.fillRect(ox + 28, oy + 6, 5, 58);
  g.fillStyle = on ? '#6be07a' : '#8b93a3';
  g.beginPath();
  g.moveTo(ox + 33, oy + 8);
  g.lineTo(ox + 58, oy + 18);
  g.lineTo(ox + 33, oy + 30);
  g.closePath();
  g.fill();
}

function coin(g: G, i: number, frame: number) {
  const [ox, oy] = at(i);
  const w = [20, 14, 6, 14][frame]!;
  g.fillStyle = '#d99a1c';
  g.beginPath();
  g.ellipse(ox + 32, oy + 32, w + 2, 22, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffd34d';
  g.beginPath();
  g.ellipse(ox + 32, oy + 32, w, 20, 0, 0, Math.PI * 2);
  g.fill();
  if (frame !== 2) {
    g.fillStyle = '#fff2b0';
    g.fillRect(ox + 32 - Math.max(2, w / 3), oy + 20, Math.max(2, w / 2), 10);
  }
}

/** The hero: a chunky figure with a scarf; the pose varies by frame. */
function hero(
  g: G,
  i: number,
  pose: 'idle0' | 'idle1' | 'run0' | 'run1' | 'run2' | 'run3' | 'jump' | 'fall' | 'land' | 'dash',
) {
  const [ox, oy] = at(i);
  const squash = pose === 'land' ? 6 : pose === 'idle1' ? 2 : 0;
  const stretch = pose === 'jump' ? -4 : 0;
  const bodyTop = oy + 14 + squash + stretch;
  const bodyH = 34 - squash - stretch;
  const lean = pose === 'dash' ? 8 : pose.startsWith('run') ? 3 : 0;
  // Legs.
  g.fillStyle = '#2b3350';
  const legSpread: Record<typeof pose, [number, number]> = {
    idle0: [22, 36],
    idle1: [22, 36],
    run0: [14, 42],
    run1: [24, 34],
    run2: [40, 18],
    run3: [24, 34],
    jump: [20, 40],
    fall: [26, 32],
    land: [14, 44],
    dash: [10, 46],
  };
  const [l0, l1] = legSpread[pose];
  g.fillRect(ox + l0, bodyTop + bodyH - 4, 10, 18 - squash);
  g.fillRect(ox + l1 - 6, bodyTop + bodyH - 4, 10, 18 - squash);
  // Body.
  g.fillStyle = '#4dabf7';
  g.fillRect(ox + 18 + lean, bodyTop + 10, 28, bodyH - 8);
  // Head.
  g.fillStyle = '#ffd8b4';
  g.fillRect(ox + 20 + lean, bodyTop - 4, 24, 20);
  g.fillStyle = '#2b3350';
  g.fillRect(ox + 36 + lean, bodyTop + 2, 4, 4);
  // Scarf, streaming back.
  g.fillStyle = '#ff6b6b';
  g.fillRect(ox + 18 + lean, bodyTop + 12, 28, 6);
  const tail = pose === 'dash' ? 22 : pose.startsWith('run') ? 14 : 8;
  g.fillRect(ox + 18 + lean - tail, bodyTop + 12 + (pose === 'fall' ? -6 : 2), tail, 5);
  // Arms.
  g.fillStyle = '#ffd8b4';
  if (pose === 'jump' || pose === 'fall') {
    g.fillRect(ox + 12 + lean, bodyTop + 2, 8, 16);
    g.fillRect(ox + 44 + lean, bodyTop + 2, 8, 16);
  } else {
    g.fillRect(ox + 12 + lean, bodyTop + 18, 8, 14);
    g.fillRect(ox + 44 + lean, bodyTop + 18, 8, 14);
  }
}

function solid(g: G, i: number, color: string) {
  const [ox, oy] = at(i);
  g.fillStyle = color;
  g.fillRect(ox, oy, TILE, TILE);
}

function peak(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#3a3f66';
  g.beginPath();
  g.moveTo(ox, oy + TILE);
  g.lineTo(ox + 32, oy + 6);
  g.lineTo(ox + TILE, oy + TILE);
  g.closePath();
  g.fill();
  g.fillStyle = '#e8ecf7';
  g.beginPath();
  g.moveTo(ox + 22, oy + 24);
  g.lineTo(ox + 32, oy + 6);
  g.lineTo(ox + 42, oy + 24);
  g.closePath();
  g.fill();
}

function hillTop(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#2f6b4f';
  g.beginPath();
  g.moveTo(ox, oy + TILE);
  g.quadraticCurveTo(ox + 32, oy - 10, ox + TILE, oy + TILE);
  g.closePath();
  g.fill();
}

function treeTop(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#1f4f3a';
  g.beginPath();
  g.moveTo(ox + 32, oy + 2);
  g.lineTo(ox + 60, oy + TILE);
  g.lineTo(ox + 4, oy + TILE);
  g.closePath();
  g.fill();
  g.fillStyle = '#2f7a55';
  g.beginPath();
  g.moveTo(ox + 32, oy + 2);
  g.lineTo(ox + 48, oy + 40);
  g.lineTo(ox + 16, oy + 40);
  g.closePath();
  g.fill();
}

function trunk(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#1f4f3a';
  g.beginPath();
  g.moveTo(ox + 4, oy);
  g.lineTo(ox + 60, oy);
  g.lineTo(ox + 52, oy + 30);
  g.lineTo(ox + 12, oy + 30);
  g.closePath();
  g.fill();
  g.fillStyle = '#4a3324';
  g.fillRect(ox + 26, oy + 26, 12, 38);
}

function cloud(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath();
  g.ellipse(ox + 24, oy + 36, 18, 10, 0, 0, Math.PI * 2);
  g.ellipse(ox + 40, oy + 32, 16, 12, 0, 0, Math.PI * 2);
  g.ellipse(ox + 32, oy + 40, 22, 8, 0, 0, Math.PI * 2);
  g.fill();
}

function star(g: G, i: number) {
  const [ox, oy] = at(i);
  g.fillStyle = '#ffffff';
  g.fillRect(ox + 12, oy + 20, 3, 3);
  g.fillRect(ox + 44, oy + 8, 2, 2);
  g.fillRect(ox + 30, oy + 44, 2, 2);
}

/** Paints the atlas; the caller uploads it with `renderer.textureFromSource`. */
export function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  g.clearRect(0, 0, SIZE, SIZE);
  groundTop(g, CELL.groundTop);
  groundFill(g, CELL.groundFill);
  oneWay(g, CELL.oneWay);
  spike(g, CELL.spike);
  mover(g, CELL.mover);
  door(g, CELL.door);
  flag(g, CELL.flagOff, false);
  flag(g, CELL.flagOn, true);
  coin(g, CELL.coin0, 0);
  coin(g, CELL.coin1, 1);
  coin(g, CELL.coin2, 2);
  coin(g, CELL.coin3, 3);
  hero(g, CELL.idle0, 'idle0');
  hero(g, CELL.idle1, 'idle1');
  hero(g, CELL.run0, 'run0');
  hero(g, CELL.run1, 'run1');
  hero(g, CELL.run2, 'run2');
  hero(g, CELL.run3, 'run3');
  hero(g, CELL.jump, 'jump');
  hero(g, CELL.fall, 'fall');
  hero(g, CELL.land, 'land');
  hero(g, CELL.dash, 'dash');
  solid(g, CELL.white, '#ffffff');
  peak(g, CELL.peak);
  solid(g, CELL.mountain, '#3a3f66');
  hillTop(g, CELL.hillTop);
  solid(g, CELL.hill, '#2f6b4f');
  treeTop(g, CELL.treeTop);
  trunk(g, CELL.trunk);
  cloud(g, CELL.cloud);
  star(g, CELL.star);
  return canvas;
}
