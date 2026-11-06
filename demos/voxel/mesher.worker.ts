/**
 * The mesher Worker of the voxel demo: the engine's Worker recipe. `installVoxelMesherWorker`
 * keeps a mirror of the page's grid here and answers each `mesh` request with one transferred
 * buffer; the game only names its block rules (functions cannot cross the thread boundary).
 */
import { installVoxelMesherWorker } from '@thunderclap/engine/voxel';
import { blockLayer, outsideBlock } from './world';

installVoxelMesherWorker({ layerOf: blockLayer, outside: outsideBlock });
