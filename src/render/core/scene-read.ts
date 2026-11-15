/**
 * The core's scene-read group (ws/scene-read-fit): one bind group that hands a later pass the
 * scene as the passes before it left it, the depth attachment (`core.sceneDepthView`) at
 * binding 0 and the copy of the target's colour (`core.sceneColorView`) at binding 1. A draw set
 * that `readsDepth` or `readsColor` (`DrawSetDesc`) has it bound after its own groups and
 * declared in its prelude as `core_scene_depth` and `core_scene_color`; a drawable binds
 * `core.sceneRead.group` itself. The group is re-made when either view is (a resize, the first
 * colour copy, a device restore: `core.targetsVersion` bumps), and a set's bundles are recorded
 * again with it. A view the core has not made (no depth yet, no `CoreTarget.texture` to copy
 * colour from) is a 1×1 stand-in: `textureDimensions(...).x == 1` reads as "none".
 */

/** WGSL declaring the scene-read group at `group`: `core_scene_depth` and `core_scene_color`. */
export function coreSceneReadWgsl(group: number): string {
  return `@group(${group}) @binding(0) var core_scene_depth: texture_depth_2d;
@group(${group}) @binding(1) var core_scene_color: texture_2d<f32>;
`;
}

/** The scene-read group (`RenderCore.sceneRead`). */
export interface CoreSceneRead {
  /** Its layout (fragment stage: a depth texture, an unfilterable-float colour texture). */
  readonly layout: GPUBindGroupLayout;
  /** The group over the current views: re-made when `version` moves, so read it at bind time. */
  readonly group: GPUBindGroup;
  /** The core's `targetsVersion` the group follows. */
  readonly version: number;
}

/** @internal What the group reads from the core. */
export interface SceneReadSource {
  readonly device: GPUDevice;
  readonly sceneDepthView: GPUTextureView | null;
  readonly sceneColorView: GPUTextureView | null;
  readonly targetsVersion: number;
}

/** @internal The core's one scene-read group; follows the core onto a restored device. */
export class SceneRead implements CoreSceneRead {
  private dev: GPUDevice | null = null;
  private lay: GPUBindGroupLayout | null = null;
  private noDepth: GPUTextureView | null = null;
  private noColor: GPUTextureView | null = null;
  private made: GPUBindGroup | null = null;
  private madeVersion = -1;

  constructor(private readonly src: SceneReadSource) {}

  get version(): number {
    return this.src.targetsVersion;
  }

  get layout(): GPUBindGroupLayout {
    this.sync();
    return this.lay!;
  }

  get group(): GPUBindGroup {
    this.sync();
    const src = this.src;
    if (this.made && this.madeVersion === src.targetsVersion) return this.made;
    const device = this.dev!;
    if (!src.sceneDepthView) {
      this.noDepth ??= device
        .createTexture({
          label: 'core scene-read no depth',
          size: [1, 1],
          format: 'depth32float',
          usage: GPUTextureUsage.TEXTURE_BINDING,
        })
        .createView();
    }
    if (!src.sceneColorView) {
      this.noColor ??= device
        .createTexture({
          label: 'core scene-read no colour',
          size: [1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING,
        })
        .createView();
    }
    this.made = device.createBindGroup({
      label: 'core scene-read',
      layout: this.lay!,
      entries: [
        { binding: 0, resource: src.sceneDepthView ?? this.noDepth! },
        { binding: 1, resource: src.sceneColorView ?? this.noColor! },
      ],
    });
    this.madeVersion = src.targetsVersion;
    return this.made;
  }

  /** On first use and on a new device: the layout again, the stand-ins and the group dropped. */
  private sync(): void {
    const device = this.src.device;
    if (this.dev === device) return;
    this.dev = device;
    const F = GPUShaderStage.FRAGMENT;
    this.lay = device.createBindGroupLayout({
      label: 'core scene-read',
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.noDepth = null;
    this.noColor = null;
    this.made = null;
    this.madeVersion = -1;
  }
}
