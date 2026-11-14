/**
 * The chunk mesher Worker of the reference voxel scene (harness/ref-run.ts): `createVoxelChunks`
 * with `createVoxelMesher`, the path the S4 row measures. The engine's `installVoxelMesherWorker`
 * keeps a mirror of the grid here and answers each `mesh` request with a transferred vertex +
 * index buffer. (harness/voxel-worker.ts is the section mesher of the streamed world.)
 */
import { installVoxelMesherWorker } from '@thunderclap-engine/engine/voxel';

installVoxelMesherWorker();
