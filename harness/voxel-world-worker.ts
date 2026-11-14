/**
 * The section mesher Worker of the voxel-world page (harness/voxel-world.html): the line a game
 * writes, with its own codec.
 */
import { installSectionMesherWorker } from '@thunderclap-engine/engine/voxel';
import { RUNS_CODEC } from './voxel-world-codec';

installSectionMesherWorker({ codec: RUNS_CODEC });
