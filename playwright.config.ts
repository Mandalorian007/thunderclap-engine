import { defineConfig, devices } from '@playwright/test';
import type { HarnessOptions } from './e2e/fixtures';
import {
  HARNESS_PORT,
  HARNESS_URL,
  TEMPLATE_PORTS,
  type TemplateName,
  templateUrl,
  WRAPPER_PORT,
  WRAPPER_URL,
} from './e2e/ports';

// Engine e2e (D-041 addendum 2): verifies the engine's platform capability once for every game,
// on the noun-free harness page (harness/). Run with `pnpm test:e2e`. The game's own e2e (tests/e2e) tests product only.
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
  /** Run only these specs on this row (rows added for one capability). */
  testMatch?: RegExp;
}

/**
 * The phones match the game's mobile specs (tests/e2e/mobile*.spec.ts, landscape CSS px). Their
 * safe-area insets (iphone 47, promax 59) are emulated by e2e/layout.spec.ts through CDP
 * (`Emulation.setSafeAreaInsetsOverride`), so `env(safe-area-inset-*)` is real there.
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
  // Upright rows for the layout regions (ws/layout): the portrait form factors.
  { name: 'phone-port', width: 390, height: 844, touch: true, testMatch: /layout\.spec\.ts/ },
  { name: 'tablet-port', width: 820, height: 1180, touch: true, testMatch: /layout\.spec\.ts/ },
];

/**
 * The WebKit row (D2 §2 R1, ws/rails): the engine's iPad target, Playwright's WebKit on the
 * iPad Pro 11 landscape profile (touch, DPR 2). It runs only the specs below, which prove WebGPU
 * boot, the draw paths, input and layout; the rest of the matrix stays Chromium. It runs on macOS,
 * where Playwright's WebKit has WebGPU (`E2E_WEBKIT=0` drops it, `E2E_WEBKIT=1` forces it
 * elsewhere). A test that fails only here for a reason outside the engine is
 * `test.fixme(browserName === 'webkit', '<reason>')` in its spec, and docs/releasing.md lists it.
 */
export const WEBKIT_SPECS = [
  'smoke',
  'core',
  'kit',
  'models',
  'actors',
  'mesh',
  'views',
  'stream',
  'bench',
  'ui',
  'ui-spec',
  'net',
  'input',
  'layout',
  'lights',
  'look',
  'voxel',
  'voxel-world',
  'render4',
  'post2',
  'demos/voxel',
  'demos/showroom',
];
const webkitMatch = new RegExp(`(^|/)e2e/(${WEBKIT_SPECS.join('|')})\\.spec\\.ts$`);
const webkitOn =
  process.env.E2E_WEBKIT === '1' ||
  (process.env.E2E_WEBKIT !== '0' && process.platform === 'darwin');

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
  },
  projects: [
    ...MATRIX.map((m) => ({
      name: m.name,
      ...(m.testMatch ? { testMatch: m.testMatch } : {}),
      use: {
        browserName: 'chromium' as const,
        launchOptions: { args: webgpuArgs() },
        viewport: { width: m.width, height: m.height },
        ...(m.touch
          ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
          : { isMobile: false, hasTouch: false, deviceScaleFactor: 1 }),
        wrapper: m.wrapper ?? ('top' as const),
      },
    })),
    ...(webkitOn
      ? [
          {
            name: 'webkit-ipad',
            testMatch: webkitMatch,
            use: {
              ...devices['iPad Pro 11 landscape'],
              browserName: 'webkit' as const,
              wrapper: 'top' as const,
            },
          },
        ]
      : []),
  ],
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
    // One Vite dev server per template for e2e/templates.spec.ts (the template's own `pnpm dev`
    // on a fixed port): cheaper than a build and the same code path a developer runs.
    ...(Object.keys(TEMPLATE_PORTS) as TemplateName[]).map((name) => ({
      command: `pnpm --filter @thunderclap-engine/template-${name} exec vite --port ${TEMPLATE_PORTS[name]} --strictPort --host 127.0.0.1`,
      url: templateUrl(name),
      reuseExistingServer: !isCI,
      timeout: 60_000,
    })),
  ],
});
