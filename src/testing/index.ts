// @thunderclap-engine/engine/testing: helpers for a game's unit tests. Never imported by the engine.

export {
  createFakeDevice,
  type FakeBindGroup,
  type FakeBuffer,
  type FakeBufferCopy,
  type FakeDevice,
  FakeGpuValidationError,
  type FakePass,
  type FakeQuerySet,
  type FakeTexture,
  type FakeView,
  fakeCanvasContext,
  fakeRendererGpu,
  installGpuGlobals,
  type PassCommand,
} from '../render/fake-gpu';
export {
  type AllocCounts,
  BudgetError,
  type BudgetLimits,
  budget,
  countAllocs,
  createWorkMeter,
  diffTraceGolden,
  expectProportional,
  type GpuCounts,
  type ProportionalOptions,
  type ProportionalResult,
  type RunOptions,
  sha256Hex,
  type TraceGolden,
  traceGolden,
  type WorkMeter,
  type WorkMeterOptions,
  type WorkReport,
} from './budget';
export {
  createFakeHost,
  type FakeHapticCall,
  type FakeHost,
  type FakeHostOptions,
  type FakeWakeLock,
} from './fake-host';
export { createFixedClock, type FixedClock } from './fixed-clock';
export {
  createTestGame,
  type TestGame,
  type TestGameOptions,
} from './test-game';
