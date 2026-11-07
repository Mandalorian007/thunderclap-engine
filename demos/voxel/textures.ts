/**
 * The eight block textures of the voxel demo, painted on canvases at boot (no binary assets):
 * grass top, grass side, dirt, stone, sand, wood, leaves, glowstone, in `Layer` order. The same
 * canvases double as the hotbar icons.
 */
import { hash2f } from '@thunderclap-engine/engine/core';
import { LAYER_COUNT, Layer } from './world';

export const TEXTURE_SIZE = 32;

type Paint = (x: number, y: number) => [number, number, number];

function paint(fn: Paint): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const px = img.data;
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const [r, g, b] = fn(x, y);
      const o = 4 * (x + TEXTURE_SIZE * y);
      px[o] = Math.max(0, Math.min(255, Math.round(r * 255)));
      px[o + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      px[o + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const grassTop: Paint = (x, y) => {
  const n = hash2f(1, x, y);
  const g = 0.45 + n * 0.3;
  return [0.22 + n * 0.12, g, 0.12 + n * 0.08];
};

const dirt: Paint = (x, y) => {
  const n = hash2f(2, x, y);
  const pebble = hash2f(3, x >> 1, y >> 1) > 0.9 ? 0.12 : 0;
  const v = 0.3 + n * 0.18 + pebble;
  return [v + 0.12, v * 0.72, v * 0.42];
};

const grassSide: Paint = (x, y) => {
  // Grass hangs down a ragged edge over dirt.
  const edge = 7 + Math.floor(hash2f(4, x, 0) * 5);
  return y < edge ? grassTop(x, y) : dirt(x, y);
};

const stone: Paint = (x, y) => {
  const n = hash2f(5, x, y);
  const crack = hash2f(6, x >> 2, y >> 2) > 0.84 ? -0.1 : 0;
  const v = 0.42 + n * 0.16 + crack;
  return [v, v, v + 0.03];
};

const sand: Paint = (x, y) => {
  const n = hash2f(7, x, y);
  const v = 0.74 + n * 0.14;
  return [v + 0.08, v, v * 0.68];
};

const wood: Paint = (x, y) => {
  const ring = hash2f(8, Math.floor(x / 4), 0);
  const n = hash2f(9, x, y);
  const v = 0.3 + ring * 0.14 + n * 0.08;
  return [v + 0.1, v * 0.7, v * 0.4];
};

const leaves: Paint = (x, y) => {
  const n = hash2f(10, x, y);
  const hole = hash2f(11, x >> 1, y >> 1) > 0.88;
  const g = hole ? 0.16 : 0.32 + n * 0.3;
  return [g * 0.45, g, g * 0.35];
};

const glowstone: Paint = (x, y) => {
  const n = hash2f(12, x >> 1, y >> 1);
  const cell = hash2f(13, x >> 3, y >> 3);
  const v = 0.7 + n * 0.2 + cell * 0.1;
  return [v + 0.1, v * 0.85, v * 0.45];
};

/** Paint the eight textures in `Layer` order. */
export function paintBlockTextures(): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = new Array(LAYER_COUNT);
  out[Layer.GrassTop] = paint(grassTop);
  out[Layer.GrassSide] = paint(grassSide);
  out[Layer.Dirt] = paint(dirt);
  out[Layer.Stone] = paint(stone);
  out[Layer.Sand] = paint(sand);
  out[Layer.Wood] = paint(wood);
  out[Layer.Leaves] = paint(leaves);
  out[Layer.Glowstone] = paint(glowstone);
  return out;
}

/** A hotbar icon: the block's side texture scaled up crisply. */
export function blockIcon(texture: HTMLCanvasElement, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(texture, 0, 0, size, size);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.imageRendering = 'pixelated';
  return canvas;
}
