/**
 * The section mesher Worker of the voxel page (harness/voxel.html): the line a game writes. The
 * grid source puts raw cells, so the Worker decodes with the engine's raw codec.
 */
import { installSectionMesherWorker, RAW_SECTION_CODEC } from '@thunderclap-engine/engine/voxel';

installSectionMesherWorker({ codec: RAW_SECTION_CODEC });
