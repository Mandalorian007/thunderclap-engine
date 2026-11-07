/**
 * What the ARPG demo publishes on `window.__demo` for the e2e spec and for poking at in the
 * console. Plain data only; the spec's helpers live on `window.__arpgApi`.
 */
export interface ArpgDemoState {
  ready: boolean;
  /** `'ok'`, `'unsupported'`, `'pending'` or `'error: …'`. */
  gpu: string;
  /** Frames rendered since load. */
  frame: number;
  /** Frames per second, smoothed. */
  fps: number;
  /** Seconds of fixed-step simulation since load. */
  simTime: number;
  /** `renderer.stats.drawCalls` (scene, shadow and post passes) of the last frame. */
  drawCalls: number;
  /** Scene triangles submitted in the last frame (shadow passes not counted). */
  triangles: number;
  /** The hero's feet, world units. */
  heroPos: [number, number, number];
  /** The anim graph's state: `'move'` or `'attack'`. */
  heroState: string;
  /** The hero's ground speed, units per second. */
  heroSpeed: number;
  heroHealth: number;
  heroMana: number;
  /** Length of the navmesh path of the last ground click (0 when none was found). */
  pathLength: number;
  /** The last click's snapped ground point, or null while none. */
  moveTarget: [number, number, number] | null;
  /** True while the hero follows a click path. */
  pathing: boolean;
  enemiesAlive: number;
  kills: number;
  /** Hits landed on enemies since load. */
  hits: number;
  /** Damage numbers spawned as crits (the third blow on a ghoul, `ui.floats`). */
  crits: number;
  /** Markers on the minimap (braziers and live ghouls). */
  mapMarkers: number;
  /** Minimap taps that snapped to the navmesh and started a walk. */
  mapPicks: number;
  /** Swings started since load. */
  attacks: number;
  /** `'iron'`, `'gilded'` or `'bone'`. */
  gearSet: string;
  /** Material labels of the worn helmet, shoulders and weapon. */
  gearMaterialIds: [string, string, string];
  /** Gear swaps since load (the skeleton is built once: `rigBuilds` stays 1). */
  gearSwaps: number;
  rigBuilds: number;
  /** Camera pitch below the horizon, degrees. */
  cameraPitch: number;
  /** Navmesh polygons baked from the courtyard. */
  navPolys: number;
  /** The `?seed=N` the spawns came from. */
  seed: number;
  /** `?still`: the idle bob, flame flicker, cape wind and enemy AI are parked. */
  still: boolean;
  /** `gpuDiagnostics.errorCount`. */
  gpuErrors: number;
}

/** Test helpers (functions, so they live beside `__demo` rather than in it). */
export interface ArpgDemoApi {
  /** A world point in client (CSS) px, for synthetic clicks and taps. */
  screenOf(x: number, y: number, z: number): { x: number; y: number };
  /** A world ground point (x, z) on the minimap, in client (CSS) px. */
  mapPointOf(x: number, z: number): { x: number; y: number };
  /** Move the nearest live enemy just in front of the hero and hold it there; returns its index. */
  summon(): number;
}

/** `window` with the demo's two globals (not a global declaration: other demos type `__demo` too). */
export const demoWindow = window as unknown as { __demo?: ArpgDemoState; __arpgApi?: ArpgDemoApi };
