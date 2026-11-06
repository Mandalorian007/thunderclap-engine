/**
 * `@thunderclap/engine/anim`: keyframe clips (glTF sampler semantics) sampled into poses,
 * blended and cross-faded by a mixer, resolved into node world matrices and skin joint matrices.
 * Pure arithmetic, no GPU, no allocations per frame.
 */
export type {
  AnimationChannel,
  AnimationClip,
  AnimationEvent,
  BlendMode,
  ChannelPath,
  ClipCursor,
  Interpolation,
} from './clip';
export {
  channelComponents,
  clipDuration,
  createClipCursor,
  findKeyframe,
  sampleChannel,
  sampleClip,
} from './clip';
export type { AnimationEventListener, AnimationMixerOptions, PlayOptions } from './mixer';
export { AnimationAction, AnimationMixer } from './mixer';
export type { Pose, Skeleton } from './pose';
export {
  blendPose,
  copyPose,
  createPose,
  inverseBindFromRest,
  invertAffine,
  jointCount,
  multiplyAffine,
  nodeCount,
  POSE_NODE_FLOATS,
  poseToWorld,
  skinMatrices,
  validateSkeleton,
  WORLD_NODE_FLOATS,
  writeNodeMatrix,
} from './pose';
export {
  quatDot,
  quatFromAxisAngle,
  quatFromEuler,
  quatIdentity,
  quatMultiply,
  quatNlerp,
  quatNormalize,
  quatSlerp,
} from './quat';
export type { Socket, SocketLocal } from './socket';
export { attachTransform, createSocket, socketWorld } from './socket';
