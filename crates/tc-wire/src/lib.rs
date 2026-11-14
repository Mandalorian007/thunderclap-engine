//! ThunderClap's wire format: the binary codec, schema and schema hash
//! that a networked game's Rust server shares with its TypeScript client
//! (`src/net/`).
//!
//! - [`Wire`] (with `#[derive(Wire)]`) gives a type its codec and its
//!   schema description; [`wire`] documents the format.
//! - [`Schema`] collects the types and live queries a protocol is made of;
//!   its [`canonical_text`](Schema::canonical_text) and
//!   [`hash`](Schema::hash) match `src/net/schema.ts` byte for byte.
//! - [`diff`] diffs and patches any encoded value by walking its schema;
//!   [`arbitrary`] makes random encodings of any schema type for tests.
//! - [`Fixed`] is the 32.32 fixed-point number both sides compute with
//!   exactly; [`hash`] the stable hash; [`varint`] the integer codec.
//! - [`bulk`] batches frames into one message; [`stamp`] hashes what a
//!   client holds.
//!
//! `tc-tsgen` writes TypeScript types and codecs from a [`Schema`].

extern crate self as tc_wire;

pub mod arbitrary;
pub mod bulk;
pub mod diff;
pub mod fixed;
pub mod hash;
pub mod schema;
pub mod stamp;
pub mod varint;
pub mod wire;

pub use fixed::Fixed;
pub use schema::{
    Field, QueryDef, Schema, SchemaBuilder, TypeDef, TypeKind, TypeRef, Variant, VariantFields,
    WIRE_FORMAT, WIRE_HEADER,
};
pub use tc_wire_derive::Wire;
pub use wire::{Bytes, DecodeError, DecodeErrorKind, Reader, Wire, Writer};
