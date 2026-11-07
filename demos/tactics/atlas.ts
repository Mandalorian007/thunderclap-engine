/**
 * The tactics atlas, painted on a canvas at boot: no files, no network. One 512×512 texture of
 * 64×64 cells holds the three terrain diamonds, the cliff riser (left and right faces of one
 * elevation step), the overlay diamond and cursor outline, a white square for health bars and
 * the unit's eight flipbook frames (four facings × two steps). Everything the map, overlays and
 * units draw is this one material, so the whole skirmish is one draw call.
 */
import { hash2f } from '@thunderclap/engine/core';
import { EH, TH, TW } from './iso';

export const CELL_SIZE = 64;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;
const SIZE = CELL_SIZE * ATLAS_COLS;
/** Half a texel inset so nearest sampling never bleeds a neighbour cell. */
const INSET = 0.5 / SIZE;

export const CELL = {
  grass: 0,
  mud: 1,
  water: 2,
  riser: 3,
  overlay: 4,
  cursor: 5,
  white: 6,
  shadow: 7,
  /** Unit frames: `unit0 + facing * 2 + step`. Facing 0 = +x (down-right), 1 = +y (down-left), 2 = -x, 3 = -y. */
  unit0: 8,
} as const;

/** UV rectangle (u0, v0, u1, v1) of atlas cell `i`. */
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

type Ctx2D = CanvasRenderingContext2D;

function cellOrigin(i: number): [number, number] {
  return [(i % ATLAS_COLS) * CELL_SIZE, Math.floor(i / ATLAS_COLS) * CELL_SIZE];
}

/** The diamond path, centred in the cell (its centre is the cell centre). */
function diamondPath(g: Ctx2D, ox: number, oy: number, inset = 0): void {
  const cx = ox + CELL_SIZE / 2;
  const cy = oy + CELL_SIZE / 2;
  g.beginPath();
  g.moveTo(cx, cy - TH / 2 + inset);
  g.lineTo(cx + TW / 2 - inset * 2, cy);
  g.lineTo(cx, cy + TH / 2 - inset);
  g.lineTo(cx - TW / 2 + inset * 2, cy);
  g.closePath();
}

function terrain(g: Ctx2D, i: number, base: string, speck: string, seed: number): void {
  const [ox, oy] = cellOrigin(i);
  diamondPath(g, ox, oy);
  g.fillStyle = base;
  g.fill();
  g.save();
  g.clip();
  for (let k = 0; k < 40; k++) {
    const x = ox + hash2f(seed, k, 1) * CELL_SIZE;
    const y = oy + CELL_SIZE / 2 - TH / 2 + hash2f(seed, k, 2) * TH;
    g.fillStyle = speck;
    g.globalAlpha = 0.35 + hash2f(seed, k, 3) * 0.4;
    g.fillRect(x, y, 2, 1);
  }
  g.restore();
  g.globalAlpha = 1;
  diamondPath(g, ox, oy, 0.5);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 1;
  g.stroke();
}

/** Left and right faces hanging from the diamond's lower edges, one step (EH) tall. */
function riser(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  const cx = ox + CELL_SIZE / 2;
  const cy = oy + CELL_SIZE / 2;
  g.fillStyle = '#6b4f33';
  g.beginPath();
  g.moveTo(cx - TW / 2, cy);
  g.lineTo(cx, cy + TH / 2);
  g.lineTo(cx, cy + TH / 2 + EH);
  g.lineTo(cx - TW / 2, cy + EH);
  g.closePath();
  g.fill();
  g.fillStyle = '#4e3824';
  g.beginPath();
  g.moveTo(cx, cy + TH / 2);
  g.lineTo(cx + TW / 2, cy);
  g.lineTo(cx + TW / 2, cy + EH);
  g.lineTo(cx, cy + TH / 2 + EH);
  g.closePath();
  g.fill();
  // Strata lines.
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1;
  for (const dy of [5, 11]) {
    g.beginPath();
    g.moveTo(cx - TW / 2, cy + dy);
    g.lineTo(cx, cy + TH / 2 + dy);
    g.lineTo(cx + TW / 2, cy + dy);
    g.stroke();
  }
}

function overlay(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  diamondPath(g, ox, oy, 1.5);
  g.fillStyle = '#ffffff';
  g.fill();
}

function cursor(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  diamondPath(g, ox, oy, 1);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2.5;
  g.stroke();
}

function white(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  g.fillStyle = '#ffffff';
  g.fillRect(ox, oy, CELL_SIZE, CELL_SIZE);
}

function shadow(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  g.fillStyle = '#000000';
  g.beginPath();
  g.ellipse(ox + CELL_SIZE / 2, oy + CELL_SIZE / 2, 16, 8, 0, 0, Math.PI * 2);
  g.fill();
}

/**
 * A pawn: a body, a head and a pair of eyes that face one of the four iso directions. Drawn in
 * greys so the side's tint colours it. `step` 1 lifts the body for the walk bob.
 */
function unit(g: Ctx2D, i: number, facing: number, step: number): void {
  const [ox, oy] = cellOrigin(i);
  const cx = ox + CELL_SIZE / 2;
  const baseY = oy + CELL_SIZE - 8 - step * 3;
  // Body.
  g.fillStyle = '#d8d8e0';
  g.beginPath();
  g.ellipse(cx, baseY - 14, 11, 15, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#9a9aa8';
  g.beginPath();
  g.ellipse(cx, baseY - 2, 11, 5, 0, 0, Math.PI * 2);
  g.fill();
  // Head.
  g.fillStyle = '#f2f2f6';
  g.beginPath();
  g.arc(cx, baseY - 34, 9, 0, Math.PI * 2);
  g.fill();
  // Eyes: facing 0 (+x) looks down-right, 1 (+y) down-left, 2 (-x) up-left (hidden: a hint
  // on the back), 3 (-y) up-right.
  const dx = facing === 0 ? 4 : facing === 1 ? -4 : facing === 2 ? -3 : 3;
  const dy = facing <= 1 ? 2 : -3;
  g.fillStyle = facing <= 1 ? '#1a1a28' : '#6a6a78';
  g.fillRect(cx + dx - 3, baseY - 35 + dy, 2, 2);
  g.fillRect(cx + dx + 1, baseY - 35 + dy, 2, 2);
  // A sash across the body marks the facing side too.
  g.strokeStyle = '#5a5a6c';
  g.lineWidth = 2;
  g.beginPath();
  if (facing === 0 || facing === 3) {
    g.moveTo(cx - 8, baseY - 22);
    g.lineTo(cx + 8, baseY - 10);
  } else {
    g.moveTo(cx + 8, baseY - 22);
    g.lineTo(cx - 8, baseY - 10);
  }
  g.stroke();
}

/** Draws the atlas. Returns the canvas; upload it with `renderer.textureFromSource`. */
export function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  g.clearRect(0, 0, SIZE, SIZE);
  terrain(g, CELL.grass, '#4f8a3a', '#2f5e22', 1);
  terrain(g, CELL.mud, '#7a5a3a', '#4a3620', 2);
  terrain(g, CELL.water, '#2d5f9a', '#7fb4e6', 3);
  riser(g, CELL.riser);
  overlay(g, CELL.overlay);
  cursor(g, CELL.cursor);
  white(g, CELL.white);
  shadow(g, CELL.shadow);
  for (let facing = 0; facing < 4; facing++) {
    for (let step = 0; step < 2; step++) unit(g, CELL.unit0 + facing * 2 + step, facing, step);
  }
  return canvas;
}
