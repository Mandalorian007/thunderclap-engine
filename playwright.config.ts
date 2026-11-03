import { defineConfig } from '@playwright/test';
import type { HarnessOptions } from './e2e/fixtures';
import { HARNESS_PORT, HARNESS_URL, WRAPPER_PORT, WRAPPER_URL } from './e2e/ports';

// Engine e2e (D-041 addendum 2): verifies the engine's platform capability once for every game,
// on the noun-free harness page (harness/). Run with `pnpm test:e2e` here, or
// `pnpm test:e2e:engine` from the repo root. The game's own e2e (tests/e2e) tests product only.
//
// Every spec runs on every entry of the matrix below: desktop, iPad and the four phones from
// the game's mobile specs, plus the harness inside an itch-style cross-origin iframe.

const isCI = !!process.env.CI;

/**
 * Chromium flags that give a WebGPU adapter in headless mode. These are the same as the game's
 * playwright.config.ts (see docs/research/itch-webgpu.md): Metal on macOS, SwiftShader on Linux.
 * Override with E2E_CHROMIUM_ARGS="--flag1 --flag2".
 */
function webgpuArgs(): string[] {
  const override = process.env.E2E_CHROMIUM_ARGS;
  if (override) return override.split(/\s+/).filter(Boolean);
  const base = ['--enable-unsafe-webgpu'];
  if (process.platform === 'darwin') return [...base, '--use-angle=metal'];
  if (process.platform === 'linux') {
    return [
      ...base,
      '--use-angle=swiftshader',
      '--enable-features=Vulkan',
      '--use-webgpu-adapter=swiftshader',
    ];
  }
  return base;
}

interface MatrixEntry {
  name: string;
  width: number;
  height: number;
  /** Touch device: isMobile + hasTouch + DPR 2. */
  touch?: boolean;
  wrapper?: HarnessOptions['wrapper'];
}

/**
 * The phones match the game's mobile specs (tests/e2e/mobile*.spec.ts, landscape CSS px). Their
 * safe-area insets (iphone 47, promax 59) are not emulated yet, because the harness has no
 * safe-area layout to test. That arrives with the layout contract.
 */
const MATRIX: MatrixEntry[] = [
  { name: 'desktop-1280', width: 1280, height: 720 },
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'ipad', width: 1180, height: 820, touch: true },
  { name: 'phone-se', width: 667, height: 320, touch: true },
  { name: 'phone-iphone', width: 844, height: 340, touch: true },
  { name: 'phone-promax', width: 932, height: 380, touch: true },
  { name: 'phone-android', width: 915, height: 360, touch: true },
  { name: 'itch-iframe', width: 1280, height: 720, wrapper: 'itch-iframe' },
];

export default defineConfig<HarnessOptions>({
  testDir: 'e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // In the Linux CI container WebGPU is SwiftShader (CPU), which sometimes loses the device ("A valid
  // external Instance reference no longer exists"). Locally that was about 1 test in 3 with 5
  // workers and about 1 in 8 with 1 worker. The whole matrix takes about a minute serially.
  workers: isCI ? 1 : undefined,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: webgpuArgs() },
  },
  projects: MATRIX.map((m) => ({
    name: m.name,
    use: {
      browserName: 'chromium',
      viewport: { width: m.width, height: m.height },
      ...(m.touch
        ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
        : { isMobile: false, hasTouch: false, deviceScaleFactor: 1 }),
      wrapper: m.wrapper ?? 'top',
    },
  })),
  webServer: [
    {
      command: `pnpm exec vite --config vite.harness.config.ts --port ${HARNESS_PORT} --strictPort --host 127.0.0.1`,
      url: HARNESS_URL,
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: `node e2e/wrapper.mjs --port ${WRAPPER_PORT} --target ${HARNESS_URL}`,
      url: WRAPPER_URL,
      reuseExistingServer: !isCI,
      timeout: 30_000,
    },
  ],
});
