// ws/ui-spec: UI described as data. Words bound to model keys (`b`), a model that marks what
// changed, a pure allocation-free layout, `panel(spec)` / `hud(spec)`, a DOM presenter that writes
// only what changed, and a look from `theme(tokens)`. See ./README.md.
export type { SpecBoxes } from './boxes';
export type { CompiledSpec } from './compile';
export {
  type HudItem,
  type HudSpec,
  type HudView,
  hud,
  presentHud,
  presentModal,
  SpecHud,
  type SpecModal,
  type SpecModalOptions,
  type SpecOverlay,
  specScale,
} from './hud';
export {
  measureWith,
  SPEC_FAMILY,
  SPEC_MONO,
  SPEC_SANS,
  SPEC_SERIF,
  type SpecMeasurer,
  textWidth,
  type WrapOptions,
  wrapCount,
  wrapText,
} from './measure';
export type {
  SpecListMove,
  SpecListState,
  SpecModel,
  SpecRow,
  SpecValue,
} from './model';
export {
  panel,
  SpecPanel,
  type SpecPanelOptions,
  type SpecPresenter,
  type SpecSchedule,
} from './panel';
export { type DomOptions, DomPresenter, presentDom } from './present-dom';
export { SPEC_HOLD_MS, SPEC_HOLD_SLOP, type SpecTimer } from './press';
export { defaultSpecTokens, type SpecTheme, type SpecTokens, specTokenVar, theme } from './theme';
export {
  type Bind,
  b,
  type PanelEvent,
  type PanelSpec,
  SPEC_LINE,
  SPEC_TYPE,
  type SpecAlign,
  type SpecButton,
  type SpecButtonPress,
  type SpecCommon,
  type SpecField,
  type SpecFieldKind,
  type SpecFontFamily,
  type SpecGlyphPart,
  type SpecGrid,
  type SpecIcon,
  type SpecList,
  type SpecMark,
  type SpecMeter,
  type SpecNode,
  type SpecNum,
  type SpecPressKind,
  type SpecRange,
  type SpecSlot,
  type SpecStack,
  type SpecStr,
  type SpecTabs,
  type SpecText,
  type SpecTextStyle,
} from './words';
