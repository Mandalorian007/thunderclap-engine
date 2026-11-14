/**
 * `@thunderclap-engine/engine/quality`: device tier detection and the frame governor
 * (ws/intents-quality, D1 §2.12). See README.md.
 */
export {
  createGovernor,
  type Governor,
  type GovernorChange,
  type GovernorOptions,
  type Knob,
} from './governor';
export {
  type DynamicResolutionKnobOptions,
  dynamicResolutionKnob,
  type StepKnobOptions,
  stepKnob,
  toggleKnob,
} from './knobs';
export {
  type AdapterLike,
  type DeviceInfo,
  detectTier,
  type GpuInfo,
  gpuInfo,
  headsetBrowser,
  QUALITY_TIERS,
  type QualityTier,
  readDevice,
  type TierChoice,
} from './tier';
