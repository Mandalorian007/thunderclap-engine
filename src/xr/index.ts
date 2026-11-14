/**
 * `@thunderclap-engine/engine/xr` (ws/xr-merge): headset comfort and controllers, beside the
 * session and the stereo views (`./kit`'s `ctx.xr`, `XrSurface`, the core's eye views). Pure: no
 * WebXR global, no DOM; a game takes what it wants. See README.md.
 */
export {
  EASE_MAX_JUMP,
  EASE_TAU_S,
  type EaseBody,
  JUMP_FADE_MS,
  SNAP_BLINK,
  SNAP_BLINK_MS,
  SpeedLimit,
  type SpeedLimitOptions,
  VIGNETTE_DEFAULT,
  ViewEase,
  type ViewEaseOptions,
  Vignette,
} from './comfort';
export {
  type ComponentLayout,
  type ControllerHand,
  type ControllerLayout,
  type ControllerPart,
  ControllerPose,
  componentState,
  FALLBACK_PROFILE,
  layoutOf,
  type ProfileJson,
  Prop,
  profileFor,
  type ResponseLayout,
  responseValue,
  STATE_DEFAULT,
  STATE_PRESSED,
  STATE_TOUCHED,
} from './controller';
export {
  type CalibrateWhy,
  HEAD_MAX,
  HEAD_MIN,
  HeightCalibration,
  type HeightMode,
  type HeightReport,
  WAIT_MS,
} from './height';
export { createPads, type PadSource, readPads, type XrPads } from './pads';
export {
  type BodyBox,
  cellBoxBlocked,
  HeadPivot,
  PIVOT_MAX,
  type PivotBlocked,
  type SolidAt,
} from './pivot';
export {
  headRelative,
  headYawOf,
  REARM,
  SNAP_AT,
  STICK_DEAD,
  XR_BUTTON,
  type XrButtonName,
  type XrPad,
  XrSticks,
  type XrSticksOptions,
} from './sticks';
