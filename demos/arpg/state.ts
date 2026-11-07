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
  /** `renderer.stats.triangles`: scene triangles of the last frame (shadow passes not counted). */
  triangles: number;
  /** `renderer.stats.lodCounts`: instances drawn per LOD level (walls, pillars, drums, ghouls). */
  lodCounts: number[];
  /** Ghouls burning away on a dissolve material right now. */
  dissolving: number;
  /** The most ghouls seen dissolving at once since load (counted when it happens). */
  dissolvePeak: number;
  /** Camera distance from its target, metres (24 by default; the wheel and `zoom` change it). */
  cameraDistance: number;
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
  /**
   * `?still` only: the mean brightness (0..255) of the canvas's centre column (640 on
   * desktop-1280) less the mean of the columns 4 px either side, read back once on frame 60;
   * a floor gap shows as a positive spike, a grout line as a negative one. Null before (and
   * without `?still`).
   */
  centreSeam: number | null;
  /** The layout's form factor (`ui.layout.formFactor`). */
  formFactor: string;
  /** `ui.layout.overflows()` as of the last re-layout: widget ids that overflow their region. */
  overflows: string[];
  /** The content-sized `bottom` bar's height, CSS px (ws/ui-8: the orbs and slots size it). */
  bottomBar: number;
  /** The share of the layout's height between the top and bottom bars (the world's band), 0..1. */
  worldView: number;
  /** The `fill` region's share of the layout's area (the world's rect), 0..1. */
  worldArea: number;
  /** The health and mana orbs' regions: `['left', 'right']` on phone-landscape, else bottom. */
  orbRegions: [string, string];
  /**
   * The LOD level each ghoul (by index, its `setKey` key) drew at last frame
   * (`renderer.lodLevelOf` on the ghoul list), -1 when it did not draw.
   */
  ghoulLevels: number[];
  /** Ghoul list flushes that followed a death (the list lost a slot since the last frame). */
  deathFlushes: number;
  /**
   * On those flushes, how many ghouls that drew both frames changed LOD level. Keyed by ghoul
   * id (ws/render-7), a death moves no other ghoul's level: this stays 0.
   */
  deathLodShifts: number;
  /** The ghoul list keeps per-instance previous matrices (`velocity: true`, `?blur` only). */
  ghoulVelocity: boolean;
}

/** Test helpers (functions, so they live beside `__demo` rather than in it). */
export interface ArpgDemoApi {
  /** A world point in client (CSS) px, for synthetic clicks and taps. */
  screenOf(x: number, y: number, z: number): { x: number; y: number };
  /** A world ground point (x, z) on the minimap, in client (CSS) px. */
  mapPointOf(x: number, z: number): { x: number; y: number };
  /** Set the camera distance (clamped to 14..64 m); returns the distance applied. */
  zoom(distance: number): number;
  /** Move the nearest live enemy just in front of the hero and hold it there; returns its index. */
  summon(): number;
}

/** `window` with the demo's two globals (not a global declaration: other demos type `__demo` too). */
export const demoWindow = window as unknown as { __demo?: ArpgDemoState; __arpgApi?: ArpgDemoApi };
