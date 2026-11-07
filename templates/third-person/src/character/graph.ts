/**
 * The character's animation graph: four states over the five generated clips. The scene sets
 * two parameters a frame (`speed` 0..1 and the one-shot `attack` / `hit` flags) and reads the
 * state back for the mechanics (an attack locks movement, a hit interrupts an attack).
 */
import {
  type AnimationClip,
  type AnimationMixer,
  type AnimGraph,
  type AnimGraphDesc,
  createAnimGraph,
} from '@thunderclap-engine/engine/anim';
import { RUN_SPEED, WALK_SPEED } from './controller';

export type Clips = Record<'idle' | 'walk' | 'run' | 'attack' | 'hit', AnimationClip>;

/** Normalised speed at which the walk clip plays alone; 1 is the run. */
export const WALK_POINT = WALK_SPEED / RUN_SPEED;

export function graphDesc(clips: Clips): AnimGraphDesc {
  return {
    params: { speed: 0, attack: false, hit: false },
    states: {
      idle: { clip: clips.idle },
      locomotion: {
        blend: {
          param: 'speed',
          points: [
            { at: WALK_POINT, clip: clips.walk },
            { at: 1, clip: clips.run },
          ],
        },
      },
      attack: { clip: clips.attack, loop: false },
      hit: { clip: clips.hit, loop: false },
    },
    transitions: [
      // A hit interrupts anything, an attack anything but a hit.
      { from: '*', to: 'hit', when: (p) => p.hit === true, fade: 0.05 },
      { from: 'idle', to: 'attack', when: (p) => p.attack === true, fade: 0.08 },
      { from: 'locomotion', to: 'attack', when: (p) => p.attack === true, fade: 0.08 },
      { from: 'attack', to: 'idle', when: () => true, fade: 0.15, exitTime: 0.95 },
      { from: 'hit', to: 'idle', when: () => true, fade: 0.12, exitTime: 0.9 },
      { from: 'idle', to: 'locomotion', when: (p) => (p.speed as number) > 0.08, fade: 0.15 },
      { from: 'locomotion', to: 'idle', when: (p) => (p.speed as number) <= 0.08, fade: 0.2 },
    ],
    initial: 'idle',
  };
}

export function createCharacterGraph(mixer: AnimationMixer, clips: Clips): AnimGraph {
  return createAnimGraph(mixer, graphDesc(clips));
}
