/**
 * `@thunderclap-engine/engine/fx/weather` (ws/fx-fit): weather and lightning alone, a subpath a
 * game can load when the weather first turns (a dynamic `import()`, its own chunk) instead of
 * shipping it in the first download. The same classes as `./fx` exports: pick one path per game.
 *
 * ```ts
 * let fx: typeof import('@thunderclap-engine/engine/fx/weather') | null = null;
 * async function storm(core: RenderCore) {
 *   fx ??= await import('@thunderclap-engine/engine/fx/weather');
 *   return new fx.Weather(core, fx.WEATHER_RAIN); // warmed by the core before it draws
 * }
 * ```
 */
export type { LightningOptions } from './lightning';
export {
  LIGHTNING_FLOATS,
  LIGHTNING_SEGMENTS,
  LIGHTNING_STRANDS,
  LIGHTNING_WGSL,
  Lightning,
  lightningFlash,
} from './lightning';
export type {
  PrecipLayer,
  PrecipShape,
  WeatherConfig,
  WeatherDensityKnobOptions,
  WeatherHeightDecode,
  WeatherOcclusionMap,
  WeatherOptions,
} from './weather';
export {
  WEATHER_DUST_STORM,
  WEATHER_RAIN,
  WEATHER_RAIN_SPLASHES,
  WEATHER_SNOW,
  Weather,
  weatherDensityKnob,
} from './weather';
export {
  WEATHER_HEAD_FLOATS,
  WEATHER_LAYER_FLOATS,
  WEATHER_MAX_LAYERS,
  WEATHER_WGSL,
} from './weather-wgsl';
