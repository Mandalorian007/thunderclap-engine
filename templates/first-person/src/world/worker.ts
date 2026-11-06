/**
 * The mesher Worker: builds the terrain for a seed once, then meshes each chunk it is asked for
 * into the buffer that came with the request and transfers it back. Game code, not engine code.
 */
import { meshChunk } from './mesher';
import type { ChunkReply, ChunkRequest } from './protocol';
import { createTerrain, type Terrain } from './terrain';

let terrain: Terrain | null = null;

self.addEventListener('message', (e: MessageEvent<ChunkRequest>) => {
  const { seed, cx, cz, buffer } = e.data;
  if (!terrain || terrain.seed !== seed) terrain = createTerrain(seed);
  const m = meshChunk(terrain, cx, cz, buffer);
  const reply: ChunkReply = { cx, cz, buffer, ...m };
  self.postMessage(reply, { transfer: [buffer] });
});
