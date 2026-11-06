/**
 * The mesher Worker of the voxel page (harness/voxel.html): the three lines a game writes.
 * The engine's `installVoxelMesherWorker` keeps a mirror of the grid here and answers each
 * `mesh` request with a transferred vertex + index buffer.
 */
import { installVoxelMesherWorker } from '@thunderclap/engine/voxel';

installVoxelMesherWorker();
