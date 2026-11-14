/**
 * The section mesher Worker of the voxel demo: the engine's Worker recipe. The grid source puts
 * raw cells, so the Worker decodes with the engine's raw codec; the block table travels with
 * each job.
 */
import { installSectionMesherWorker, RAW_SECTION_CODEC } from '@thunderclap-engine/engine/voxel';

installSectionMesherWorker({ codec: RAW_SECTION_CODEC });
