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
  sampleWeights,
} from './clip';
export type {
  AnimGraph,
  AnimGraphBlendPoint,
  AnimGraphBlendState,
  AnimGraphClipState,
  AnimGraphDesc,
  AnimGraphListener,
  AnimGraphParams,
  AnimGraphStateDesc,
  AnimGraphTransition,
} from './graph';
export { createAnimGraph } from './graph';
// IK and root motion (ik.ts, root-motion.ts): pose arithmetic after sampling, before poseToWorld.
export type { IkChain, IkChainDesc, LookAtOptions, TwoBoneIkOptions } from './ik';
export { createIkChain, lookAt, twoBoneIk } from './ik';
export type { AnimationEventListener, AnimationMixerOptions, PlayOptions } from './mixer';
export { AnimationAction, AnimationMixer } from './mixer';
export type { MorphBlender, MorphLayout, MorphTarget } from './morph';
export { createMorphBlender } from './morph';
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
  quatFromMat3,
  quatIdentity,
  quatMultiply,
  quatNlerp,
  quatNormalize,
  quatSlerp,
} from './quat';
export type { RetargetClipOptions, RetargetMap, RetargetOptions } from './retarget';
export { createRetargetMap, normalizeJointName, retargetClip, retargetPose } from './retarget';
export type { RootMotionDelta, RootMotionOptions, RootMotionSplit } from './root-motion';
export { applyRootMotionDelta, extractRootMotion } from './root-motion';
export type { Socket, SocketLocal } from './socket';
export { attachTransform, createSocket, socketWorld } from './socket';
