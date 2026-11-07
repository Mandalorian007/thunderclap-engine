/**
 * The dungeon's texture atlas, drawn on a canvas at boot: no files, no network. Every sprite in
 * the room (floor, wall, torch, coin, player, the bat's four flipbook frames and a solid white
 * cell for the fog quads) lives in this one 128×128 texture, so the whole scene is one material
 * and one draw call.
 */

import { hash2f } from '@thunderclap/engine/core';

export const TILE = 32;
const COLS = 4;
const ROWS = 4;
const SIZE = TILE * COLS;
/** Half a texel inset so nearest sampling never bleeds a neighbour cell into a tile's edge. */
const INSET = 0.5 / SIZE;

export const CELL = {
  floorA: 0,
  floorB: 1,
  wall: 2,
  torch: 3,
  coin: 4,
  player: 5,
  white: 6,
  bat0: 8,
  bat1: 9,
  bat2: 10,
  bat3: 11,
} as const;

/** UV rectangle (u0, v0, u1, v1) of atlas cell `i`. */
export function cellUv(i: number): [number, number, number, number] {
  const c = i % COLS;
  const r = Math.floor(i / COLS);
  return [c / COLS + INSET, r / ROWS + INSET, (c + 1) / COLS - INSET, (r + 1) / ROWS - INSET];
}

type Ctx2D = CanvasRenderingContext2D;

function cellOrigin(i: number): [number, number] {
  return [(i % COLS) * TILE, Math.floor(i / COLS) * TILE];
}

function floor(g: Ctx2D, i: number, seed: number): void {
  const [ox, oy] = cellOrigin(i);
  g.fillStyle = '#2a2633';
  g.fillRect(ox, oy, TILE, TILE);
  for (let y = 0; y < TILE; y += 4) {
    for (let x = 0; x < TILE; x += 4) {
      const n = hash2f(seed, x, y);
      const v = 34 + Math.floor(n * 14);
      g.fillStyle = `rgb(${v},${v - 4},${v + 6})`;
      g.fillRect(ox + x, oy + y, 4, 4);
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(ox, oy, TILE, 1);
  g.fillRect(ox, oy, 1, TILE);
}

function wall(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  g.fillStyle = '#4b4658';
  g.fillRect(ox, oy, TILE, TILE);
  g.fillStyle = '#6a6479';
  for (let row = 0; row < 4; row++) {
    const off = row % 2 ? 8 : 0;
    for (let x = -16; x < TILE; x += 16) {
      g.fillRect(
        ox + Math.max(0, x + off) + 1,
        oy + row * 8 + 1,
        Math.min(14, TILE - (x + off) - 1),
        6,
      );
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(ox, oy + TILE - 2, TILE, 2);
}

function torch(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  g.fillStyle = '#5a3a1e';
  g.fillRect(ox + 14, oy + 14, 4, 14);
  g.fillStyle = '#ffd36b';
  g.beginPath();
  g.arc(ox + 16, oy + 11, 6, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff6d0';
  g.beginPath();
  g.arc(ox + 16, oy + 12, 3, 0, Math.PI * 2);
  g.fill();
}

function coin(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  g.fillStyle = '#e8b931';
  g.beginPath();
  g.arc(ox + 16, oy + 16, 8, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff1a8';
  g.beginPath();
  g.arc(ox + 14, oy + 14, 3, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#8a6a10';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(ox + 16, oy + 16, 8, 0, Math.PI * 2);
  g.stroke();
}

function player(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  g.fillStyle = '#3fe0ff';
  g.fillRect(ox + 4, oy + 4, 24, 24);
  g.fillStyle = '#0b3a48';
  g.fillRect(ox + 9, oy + 11, 4, 4);
  g.fillRect(ox + 19, oy + 11, 4, 4);
  g.fillRect(ox + 11, oy + 20, 10, 2);
}

function white(g: Ctx2D, i: number): void {
  const [ox, oy] = cellOrigin(i);
  g.fillStyle = '#ffffff';
  g.fillRect(ox, oy, TILE, TILE);
}

/** Four wing poses: up, mid, down, mid. */
function bat(g: Ctx2D, i: number, frame: number): void {
  const [ox, oy] = cellOrigin(i);
  const lift = [-7, 0, 6, 0][frame] ?? 0;
  g.fillStyle = '#5a4472';
  g.beginPath();
  g.moveTo(ox + 16, oy + 18);
  g.quadraticCurveTo(ox + 8, oy + 12 + lift, ox + 2, oy + 18 + lift);
  g.quadraticCurveTo(ox + 8, oy + 20 + lift / 2, ox + 14, oy + 22);
  g.lineTo(ox + 16, oy + 18);
  g.quadraticCurveTo(ox + 24, oy + 12 + lift, ox + 30, oy + 18 + lift);
  g.quadraticCurveTo(ox + 24, oy + 20 + lift / 2, ox + 18, oy + 22);
  g.closePath();
  g.fill();
  g.fillStyle = '#7a5a94';
  g.beginPath();
  g.arc(ox + 16, oy + 18, 4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ff5a5a';
  g.fillRect(ox + 14, oy + 16, 1.5, 1.5);
  g.fillRect(ox + 17, oy + 16, 1.5, 1.5);
}

/** Draws the atlas. Returns the canvas; upload it with `renderer.textureFromSource`. */
export function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  g.clearRect(0, 0, SIZE, SIZE);
  floor(g, CELL.floorA, 1);
  floor(g, CELL.floorB, 2);
  wall(g, CELL.wall);
  torch(g, CELL.torch);
  coin(g, CELL.coin);
  player(g, CELL.player);
  white(g, CELL.white);
  bat(g, CELL.bat0, 0);
  bat(g, CELL.bat1, 1);
  bat(g, CELL.bat2, 2);
  bat(g, CELL.bat3, 3);
  return canvas;
}
