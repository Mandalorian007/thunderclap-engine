/**
 * Device tier detection (ws/intents-quality, D1 §2.12): a first guess at how much a device can
 * draw, from facts the page can read, with the reason in words. The tier is a name only; what
 * each tier turns on (draw distance, shadows, counts) is the game's. A guess, not a measure: the
 * governor (`createGovernor`) corrects it from frames actually drawn.
 *
 * Generalized from Forge Wilds' settings/device.ts (`readDevice`, `gpuInfo`, `autoTier`).
 */

/** The GPU adapter, as far as WebGPU says. */
export interface GpuInfo {
  /** Vendor, architecture and description as the adapter reports them (`''` when it doesn't). */
  readonly description: string;
  /** A software adapter (WebGPU's fallback). */
  readonly fallback: boolean;
  /** `limits.maxTextureDimension2D`: 16384 on recent desktop and Apple GPUs, 8192 on many phones. */
  readonly maxTexture: number;
  /** `limits.maxBufferSize`, bytes. */
  readonly maxBuffer: number;
}

/** What the page knows about its device (`readDevice`). */
export interface DeviceInfo {
  /** The primary pointer is coarse (a finger). */
  readonly touch: boolean;
  /** An iPad: its own user agent, or Safari's desktop one with touch points. */
  readonly ipad: boolean;
  /** A phone-sized touch screen (shorter side under 500 CSS px). */
  readonly phone: boolean;
  /** WebKit (every iPad and iPhone browser): reports 4 or 8 cores whatever the chip has. */
  readonly webkit: boolean;
  /** `navigator.hardwareConcurrency`, 0 when unknown. */
  readonly cores: number;
  /** A standalone headset's browser (`headsetBrowser`). */
  readonly headset: boolean;
  /** Driven by automation (`navigator.webdriver`). */
  readonly automated: boolean;
  /** The adapter's facts, once there is one (`gpuInfo`). */
  readonly gpu: GpuInfo | null;
}

/** A device's tier: what it can be expected to draw. The game gives each its values. */
export type QualityTier = 'low' | 'medium' | 'high';

/** The tiers, lowest first. */
export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];

/** `detectTier`'s answer: the tier and why, in a sentence a settings menu can show. */
export interface TierChoice {
  readonly tier: QualityTier;
  readonly reason: string;
}

/** Whether `userAgent` is a standalone headset's browser (Quest Browser, Pico, Wolvic). */
export function headsetBrowser(userAgent: string): boolean {
  return /OculusBrowser|\bQuest\b|Pico|Wolvic/i.test(userAgent);
}

/** Reads the page's device. `gpu` is `null`: pass `gpuInfo(adapter)` once the renderer has one. */
export function readDevice(gpu: GpuInfo | null = null): DeviceInfo {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const ua = nav?.userAgent ?? '';
  const media = (q: string): boolean => {
    try {
      return typeof matchMedia === 'function' && matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  const touchPoints = nav?.maxTouchPoints ?? 0;
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const webkit =
    (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) || /iPad|iPhone/.test(ua);
  const w = typeof innerWidth === 'number' ? innerWidth : 0;
  const h = typeof innerHeight === 'number' ? innerHeight : 0;
  const touch = media('(pointer: coarse)') || ipad;
  const short = Math.min(w, h);
  return {
    touch,
    ipad,
    phone: touch && short > 0 && short < 500,
    webkit,
    cores: nav?.hardwareConcurrency ?? 0,
    headset: headsetBrowser(ua),
    automated: nav?.webdriver === true,
    gpu,
  };
}

/** The slice of a `GPUAdapter` `gpuInfo` reads. */
export interface AdapterLike {
  readonly info?: {
    readonly vendor?: string;
    readonly architecture?: string;
    readonly description?: string;
    readonly isFallbackAdapter?: boolean;
  };
  readonly limits: { readonly maxTextureDimension2D: number; readonly maxBufferSize: number };
}

/** The adapter's facts the tier reads. */
export function gpuInfo(adapter: AdapterLike): GpuInfo {
  const i = adapter.info;
  const parts: string[] = [];
  for (const p of [i?.vendor, i?.architecture, i?.description]) {
    if (p && !parts.includes(p)) parts.push(p);
  }
  return {
    description: parts.join(' '),
    fallback: i?.isFallbackAdapter === true,
    maxTexture: adapter.limits.maxTextureDimension2D,
    maxBuffer: adapter.limits.maxBufferSize,
  };
}

/**
 * The tier a device starts at: `high` unless something certain says it can't keep up. A software
 * GPU, a standalone headset's browser or a mobile Adreno GPU is `low`; small texture limits, or two
 * cores where the browser reports cores honestly (not WebKit), are `medium`. Nothing else is
 * guessed down from the kind of device (a phone or a tablet starts `high`): the governor sheds from
 * frames actually measured, so the player never has to raise a cautious default.
 */
export function detectTier(device: DeviceInfo = readDevice()): TierChoice {
  const facts: string[] = [];
  const gpu = device.gpu;
  if (gpu) facts.push(`${gpu.description || 'this GPU'} (textures up to ${gpu.maxTexture} px)`);
  if (device.headset) facts.push("a standalone headset's browser");
  else if (device.ipad) facts.push('an iPad');
  else if (device.phone) facts.push('a phone-sized touch screen');
  facts.push(
    device.webkit ? "WebKit, which doesn't report its cores" : `${device.cores || 'unknown'} cores`,
  );
  const seen = facts.join(', ');
  if (gpu?.fallback) {
    return { tier: 'low', reason: `low: ${seen}. A software GPU draws on the processor.` };
  }
  if (device.headset || /adreno/i.test(gpu?.description ?? '')) {
    return { tier: 'low', reason: `low: ${seen}. A standalone headset's GPU is a phone's.` };
  }
  if (gpu && gpu.maxTexture < 8192) {
    return { tier: 'medium', reason: `medium: ${seen}. Small texture limits mark a small GPU.` };
  }
  if (!device.webkit && device.cores > 0 && device.cores <= 2) {
    return { tier: 'medium', reason: `medium: ${seen}. Two cores.` };
  }
  return {
    tier: 'high',
    reason: `high: ${seen}. Nothing says it can't keep up${gpu ? '' : " (the GPU isn't known yet)"}.`,
  };
}
