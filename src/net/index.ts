/**
 * `@thunderclap-engine/engine/net`: the client side of a networked game. Sessions over a transport
 * the game hands in (the engine opens no connection itself), a hashed schema shared with the server,
 * live queries, the entity stream, snapshot interpolation, prediction with rollback, optimistic
 * edits, and in-page transports for tests and demos. See README.md.
 */

export { NetClock } from './clock';
export {
  type EntityChanges,
  EntityEncoder,
  EntityStream,
  EntityStreamError,
  MAX_VIEW_FIELDS,
} from './entities';
export {
  type ClientMsg,
  defineSchema,
  EMPTY,
  ENVELOPE_TYPES,
  type Roles,
  type SchemaDesc,
  type ServerMsg,
} from './envelope';
export { hashHex, resultHash, stableHash } from './hash';
export { QueryFeed, ServerEnd, type ServerEndEvents } from './host';
export { Optimistic, type OptimisticStore } from './optimistic';
export {
  applyPatch,
  diffValues,
  PatchError,
  type PatchOp,
  type PathStep,
  writePatchOp,
} from './patch';
export { type Correction, Predictor, type PredictorOptions } from './predict';
export {
  type Codec,
  defineTypes,
  displayType,
  type FieldSpecs,
  NetSchema,
  netType,
  propName,
  type QueryApi,
  type QueryDef,
  type QuerySpec,
  type Scalar,
  SchemaError,
  type TypeDefSpec,
  type TypeRef,
  type TypeShape,
  type TypeSpec,
  type Types,
  type TypesDesc,
  typeRef,
  type VariantSpec,
  WIRE_FORMAT,
  WIRE_HEADER,
} from './schema';
export {
  createNet,
  type Hello,
  type LivenessOptions,
  type LiveQuery,
  Net,
  NetError,
  type NetEvents,
  type NetOptions,
  type NetStatus,
  type QueryOptions,
  type ReconnectOptions,
  type Welcome,
} from './session';
export { SnapshotBuffer, type SnapshotBufferOptions } from './snapshots';
export {
  type Connect,
  type InPageHub,
  type InPageLink,
  type InPageOptions,
  inPageHub,
  inPageLink,
  inPagePair,
  type LinkConditions,
  linkConditions,
  pageTimers,
  type Timers,
  type Transport,
  type TransportEvents,
} from './transport';
export {
  compareKeys,
  DecodeError,
  Fixed,
  invalidVariant,
  type MapKey,
  Reader,
  Writer,
} from './wire';
