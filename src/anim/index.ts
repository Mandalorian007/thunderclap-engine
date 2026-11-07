/**
 * `@thunderclap/engine/anim`: keyframe clips (glTF sampler semantics) sampled into poses,
 * blended and cross-faded by a mixer, resolved into node world matrices and skin joint matrices.
 * Pure arithmetic, no GPU, no allocations per frame.
 */

export type { AimOffset, AimOffsetDesc, AimOffsetOptions } from './aim';
export { applyAimOffset, createAimOffset } from './aim';
export type {
  AnimationChannel,
  AnimationClip,
  AnimationEvent,
  AnimBlendMode,
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
  unpackQuat,
} from './clip';
export type { CompressClipOptions, CompressedClip, QuantizeClipOptions } from './compress';
export { clipBytes, compressClip, packQuat, quantizeClip } from './compress';
export type { FootIk, FootIkDesc, FootIkFootDesc, FootIkProbe } from './foot-ik';
export { applyFootIk, createFootIk } from './foot-ik';
// ws/anim-4: 2D blend spaces and pose-matched transitions (graph.ts, match.ts), aim offsets,
// foot placement, spring chains, clip compression and quantisation.
export type {
  AnimGraph,
  AnimGraphBlend1D,
  AnimGraphBlend2D,
  AnimGraphBlendPoint,
  AnimGraphBlendPoint2D,
  AnimGraphBlendState,
  AnimGraphClipState,
  AnimGraphDesc,
  AnimGraphListener,
  AnimGraphMatchDesc,
  AnimGraphParams,
  AnimGraphStateDesc,
  AnimGraphTransition,
} from './graph';
export { createAnimGraph } from './graph';
// IK and root motion (ik.ts, root-motion.ts): pose arithmetic after sampling, before poseToWorld.
export type { IkChain, IkChainDesc, LookAtOptions, TwoBoneIkOptions } from './ik';
export { createIkChain, lookAt, twoBoneIk } from './ik';
export type { FindBestFrameOptions, PoseFeatures, PoseFeaturesOptions, PoseMatch } from './match';
export { buildPoseFeatures, findBestFrame, rootSpacePositions } from './match';
export type {
  AnimationEventListener,
  AnimationMixerOptions,
  AnimPlayOptions,
  PlayOptions,
} from './mixer';
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
export type {
  SpringCapsule,
  SpringChain,
  SpringChainDesc,
  SpringCollider,
  SpringSphere,
} from './spring-chain';
export { createSpringChain, updateSpringChain } from './spring-chain';
