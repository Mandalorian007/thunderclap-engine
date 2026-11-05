/**
 * The Chromium switches the shell sets with `app.commandLine.appendSwitch` before the app is
 * ready, so WebGPU is on whatever the Chromium defaults of this Electron are (D-041, Phase 4).
 * Pure, so it is unit-tested; README.md lists the result per OS.
 *
 * - Every OS: `enable-unsafe-webgpu`. Turns WebGPU on even where Chromium has not shipped it
 *   (Linux) and skips Chromium's WebGPU adapter blocklist. The game is WebGPU-only, so a
 *   blocklisted adapter would otherwise mean no game at all. Dawn picks Metal on macOS,
 *   D3D12 on Windows and Vulkan on Linux.
 * - Linux: `enable-features=Vulkan`, the backend Dawn needs there.
 */

export type Switch = readonly [name: string, value?: string];

export function webgpuSwitches(platform: string): Switch[] {
  const out: Switch[] = [['enable-unsafe-webgpu']];
  if (platform === 'linux') out.push(['enable-features', 'Vulkan']);
  return out;
}

/**
 * `TC_GPU_SWITCHES` (unpackaged runs only, e.g. CI on SwiftShader): space-separated
 * `--name` or `--name=value`, used instead of the defaults.
 */
export function parseSwitches(text: string): Switch[] {
  const out: Switch[] = [];
  for (const raw of text.split(/\s+/)) {
    const t = raw.replace(/^--/, '');
    if (!t) continue;
    const eq = t.indexOf('=');
    out.push(eq < 0 ? [t] : [t.slice(0, eq), t.slice(eq + 1)]);
  }
  return out;
}
