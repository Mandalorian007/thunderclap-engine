/**
 * The section mesher Worker of the reference voxel scene (harness/ref-run.ts): the streamed
 * world's `installSectionMesherWorker`, the path the S4 row measures. The scene feeds raw grid
 * cells (`feedVoxelGrid`), so the Worker decodes with the engine's raw codec.
 */
import { installSectionMesherWorker, RAW_SECTION_CODEC } from '@thunderclap-engine/engine/voxel';

installSectionMesherWorker({ codec: RAW_SECTION_CODEC });
