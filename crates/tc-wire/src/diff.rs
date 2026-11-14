//! Structural diffs of encoded values, generated from the schema.
//!
//! Nobody writes diff code by hand: [`diff`] walks two encodings of the same
//! schema type side by side and [`apply`] walks one encoding and a patch.
//! Both work on bytes and need only the [`Schema`], so any type with a
//! `#[derive(Wire)]` is diffable, and the TypeScript runtime
//! (`src/net/patch.ts`) applies patches with the same walk over the schema
//! table.
//!
//! A patch is a list of [`PatchOp`]s, each addressed by a path of
//! [`PathStep`]s from the root of the value:
//!
//! - a struct descends by field index, an enum by field index within its
//!   current variant (only when both values have the same variant), a
//!   present option into its value, and a map into the value of one entry,
//!   named by its encoded key;
//! - maps change entry by entry ([`PatchOp::MapPut`], [`PatchOp::MapRemove`]),
//!   and entries that stay change field by field;
//! - everything else (lists, scalars, a changed variant, an option appearing
//!   or disappearing) is replaced whole ([`PatchOp::Set`]).
//!
//! At every level the diff keeps whichever is smaller: the finer ops, or one
//! `Set` of the whole value there. So a patch is never larger than a `Set` of
//! the root plus its path.

use std::cmp::Ordering;

use crate::Wire;
use crate::schema::{Schema, TypeKind, TypeRef, VariantFields};
use crate::wire::{Bytes, DecodeError, Reader, Writer};

/// One step of a path into a value.
#[derive(Wire, Debug, Clone, PartialEq, Eq)]
pub enum PathStep {
    /// Field `index` (declaration order) of a struct.
    Field {
        /// The field's index.
        index: u32,
    },
    /// Field `field` of an enum value whose variant is `variant` (both by
    /// declaration order); a tuple variant's value is field 0.
    Variant {
        /// The variant the value must have.
        variant: u32,
        /// The field's index within the variant.
        field: u32,
    },
    /// The value of the map entry whose encoded key is `key`.
    Entry {
        /// The encoded key.
        key: Bytes,
    },
    /// The value inside an option that is present.
    Present,
}

/// One change to an encoded value.
#[derive(Wire, Debug, Clone, PartialEq, Eq)]
pub enum PatchOp {
    /// Replaces the value at `path` with `value` (encoded).
    Set {
        /// Where.
        path: Vec<PathStep>,
        /// The new value, encoded.
        value: Bytes,
    },
    /// Inserts entry `key`, or replaces its value, in the map at `path`.
    MapPut {
        /// The map.
        path: Vec<PathStep>,
        /// The encoded key.
        key: Bytes,
        /// The encoded value.
        value: Bytes,
    },
    /// Removes entry `key` from the map at `path`; it must be there.
    MapRemove {
        /// The map.
        path: Vec<PathStep>,
        /// The encoded key.
        key: Bytes,
    },
}

/// Why a patch could not be applied (or a value diffed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchError(pub String);

impl std::fmt::Display for PatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PatchError {}

impl From<DecodeError> for PatchError {
    fn from(e: DecodeError) -> PatchError {
        PatchError(format!("bad encoding {e}"))
    }
}

/// The 64-bit stable hash of an encoded result: a
/// [`StableHasher`](crate::hash::StableHasher) fed the bytes with
/// `write_bytes`. The TypeScript `resultHash` computes the same value.
pub fn result_hash(bytes: &[u8]) -> u64 {
    let mut h = crate::hash::StableHasher::new();
    h.write_bytes(bytes);
    h.finish()
}

/// A hash as it goes on the wire: 16 lowercase hex digits.
pub fn hash_hex(hash: u64) -> String {
    format!("{hash:016x}")
}

/// Parses [`hash_hex`]'s output.
pub fn parse_hash_hex(text: &str) -> Option<u64> {
    if text.len() != 16 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    u64::from_str_radix(text, 16).ok()
}

/// The encoded size of a patch's ops (without the list's count prefix).
pub fn encoded_len(ops: &[PatchOp]) -> usize {
    ops.iter().map(|op| op.to_bytes().len()).sum()
}

/// The patch that turns `old` into `new`, both encodings of `ty`. Empty if
/// they are equal. Fails if either is not a valid encoding of `ty`.
pub fn diff(
    schema: &Schema,
    ty: &TypeRef,
    old: &[u8],
    new: &[u8],
) -> Result<Vec<PatchOp>, PatchError> {
    let walk = Walk { schema };
    walk.check(ty, old)?;
    walk.check(ty, new)?;
    let mut ops = Vec::new();
    walk.diff(ty, old, new, &mut Vec::new(), &mut ops)?;
    Ok(ops)
}

/// Applies `ops` in order to `old`, an encoding of `ty`, and returns the new
/// encoding. Fails if `old` or any value in the patch is not a valid
/// encoding, a path doesn't fit the value, or the result isn't canonical.
pub fn apply(
    schema: &Schema,
    ty: &TypeRef,
    old: &[u8],
    ops: &[PatchOp],
) -> Result<Vec<u8>, PatchError> {
    let walk = Walk { schema };
    walk.check(ty, old)?;
    let mut current = old.to_vec();
    for op in ops {
        current = walk.apply_op(ty, &current, op)?;
    }
    walk.check(ty, &current)?;
    Ok(current)
}

/// A map key, for ordering: maps are keyed by integers or strings.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Int(i128),
    /// Byte order of UTF-8 is code point order.
    Str(Vec<u8>),
}

/// A value's shape, newtypes followed.
enum Shape<'a> {
    Scalar,
    Struct(Vec<&'a TypeRef>),
    Enum(&'static str, &'a [crate::schema::Variant]),
    Option(&'a TypeRef),
    Vec,
    Map(&'a TypeRef, &'a TypeRef),
}

/// What [`Walk::rewrite`] does at the end of a path: given the type and the
/// bytes there, the bytes to put there instead.
type Leaf<'a> = dyn FnMut(&TypeRef, &[u8]) -> Result<Vec<u8>, PatchError> + 'a;

/// One map entry's spans.
struct Entry<'b> {
    key: Key,
    key_bytes: &'b [u8],
    value: &'b [u8],
}

struct Walk<'s> {
    schema: &'s Schema,
}

impl<'s> Walk<'s> {
    fn shape<'t>(&self, ty: &'t TypeRef) -> Result<Shape<'t>, PatchError>
    where
        's: 't,
    {
        Ok(match self.schema.resolve(ty) {
            TypeRef::Named(name) => match self.schema.get(name).map(|d| &d.kind) {
                Some(TypeKind::Struct(fields)) => {
                    Shape::Struct(fields.iter().map(|f| &f.ty).collect())
                }
                Some(TypeKind::Enum(variants)) => Shape::Enum(name, variants),
                Some(TypeKind::Newtype(_)) | None => {
                    return Err(PatchError(format!("unknown type `{name}`")));
                }
            },
            TypeRef::Option(inner) => Shape::Option(inner),
            TypeRef::Vec(_) => Shape::Vec,
            TypeRef::Map(key, value) => Shape::Map(key, value),
            _ => Shape::Scalar,
        })
    }

    /// Requires `bytes` to be exactly one valid encoding of `ty`.
    fn check(&self, ty: &TypeRef, bytes: &[u8]) -> Result<(), PatchError> {
        let mut r = Reader::new(bytes);
        self.skip(ty, &mut r)?;
        r.finish()?;
        Ok(())
    }

    /// Reads past one value of `ty`, validating it exactly as decoding does.
    fn skip(&self, ty: &TypeRef, r: &mut Reader<'_>) -> Result<(), PatchError> {
        match self.schema.resolve(ty) {
            TypeRef::Bool => drop(bool::decode(r)?),
            TypeRef::U8 => drop(u8::decode(r)?),
            TypeRef::U16 => drop(u16::decode(r)?),
            TypeRef::U32 => drop(u32::decode(r)?),
            TypeRef::U64 => drop(u64::decode(r)?),
            TypeRef::I32 => drop(i32::decode(r)?),
            TypeRef::I64 => drop(i64::decode(r)?),
            TypeRef::Fixed => drop(crate::Fixed::decode(r)?),
            TypeRef::String => drop(String::decode(r)?),
            TypeRef::Bytes => drop(Bytes::decode(r)?),
            TypeRef::Vec(inner) => {
                for _ in 0..r.read_len()? {
                    self.skip(inner, r)?;
                }
            }
            TypeRef::Option(inner) => {
                if r.read_option_tag()? {
                    self.skip(inner, r)?;
                }
            }
            TypeRef::Map(key, value) => {
                let mut last: Option<Key> = None;
                for _ in 0..r.read_len()? {
                    let at = r.position();
                    let k = self.read_key(key, r)?;
                    if last.as_ref().is_some_and(|last| *last >= k) {
                        return Err(
                            DecodeError::new(at, crate::DecodeErrorKind::MapKeyOrder).into()
                        );
                    }
                    last = Some(k);
                    self.skip(value, r)?;
                }
            }
            TypeRef::Named(_) => match self.shape(ty)? {
                Shape::Struct(fields) => {
                    for field in fields {
                        self.skip(field, r)?;
                    }
                }
                Shape::Enum(name, variants) => {
                    for field in self.variant_fields(name, variants, r)?.1 {
                        self.skip(field, r)?;
                    }
                }
                _ => unreachable!("named types resolve to structs or enums"),
            },
        }
        Ok(())
    }

    /// Reads an enum's variant index; returns it and its field types.
    fn variant_fields<'t>(
        &self,
        name: &'static str,
        variants: &'t [crate::schema::Variant],
        r: &mut Reader<'_>,
    ) -> Result<(u64, Vec<&'t TypeRef>), PatchError> {
        let at = r.position();
        let index = r.read_variant()?;
        let variant = usize::try_from(index)
            .ok()
            .and_then(|i| variants.get(i))
            .ok_or_else(|| DecodeError::unknown_variant(at, name, index))?;
        let fields = match &variant.fields {
            VariantFields::Unit => Vec::new(),
            VariantFields::Named(fields) => fields.iter().map(|f| &f.ty).collect(),
            VariantFields::Newtype(inner) => vec![inner],
        };
        Ok((index, fields))
    }

    fn read_key(&self, ty: &TypeRef, r: &mut Reader<'_>) -> Result<Key, PatchError> {
        Ok(match self.schema.resolve(ty) {
            TypeRef::U8 => Key::Int(u8::decode(r)?.into()),
            TypeRef::U16 => Key::Int(u16::decode(r)?.into()),
            TypeRef::U32 => Key::Int(u32::decode(r)?.into()),
            TypeRef::U64 => Key::Int(u64::decode(r)?.into()),
            TypeRef::I32 => Key::Int(i32::decode(r)?.into()),
            TypeRef::I64 => Key::Int(i64::decode(r)?.into()),
            TypeRef::String => Key::Str(String::decode(r)?.into_bytes()),
            other => return Err(PatchError(format!("`{other}` cannot be a map key"))),
        })
    }

    /// The spans of consecutive values of `types` that make up `bytes`.
    fn split<'b>(&self, types: &[&TypeRef], bytes: &'b [u8]) -> Result<Vec<&'b [u8]>, PatchError> {
        let mut r = Reader::new(bytes);
        let mut spans = Vec::with_capacity(types.len());
        for ty in types {
            let start = r.position();
            self.skip(ty, &mut r)?;
            spans.push(r.since(start));
        }
        r.finish()?;
        Ok(spans)
    }

    fn entries<'b>(
        &self,
        key: &TypeRef,
        value: &TypeRef,
        bytes: &'b [u8],
    ) -> Result<Vec<Entry<'b>>, PatchError> {
        let mut r = Reader::new(bytes);
        let len = r.read_len()?;
        let mut entries = Vec::with_capacity(len.min(1024));
        for _ in 0..len {
            let start = r.position();
            let k = self.read_key(key, &mut r)?;
            let key_bytes = r.since(start);
            let start = r.position();
            self.skip(value, &mut r)?;
            entries.push(Entry {
                key: k,
                key_bytes,
                value: r.since(start),
            });
        }
        r.finish()?;
        Ok(entries)
    }

    fn diff(
        &self,
        ty: &TypeRef,
        old: &[u8],
        new: &[u8],
        path: &mut Vec<PathStep>,
        out: &mut Vec<PatchOp>,
    ) -> Result<(), PatchError> {
        if old == new {
            return Ok(());
        }
        let mut finer = Vec::new();
        let structured = match self.shape(ty)? {
            Shape::Struct(fields) => {
                let (o, n) = (self.split(&fields, old)?, self.split(&fields, new)?);
                for (i, field) in fields.iter().enumerate() {
                    path.push(PathStep::Field { index: i as u32 });
                    self.diff(field, o[i], n[i], path, &mut finer)?;
                    path.pop();
                }
                true
            }
            Shape::Enum(name, variants) => {
                let (mut ro, mut rn) = (Reader::new(old), Reader::new(new));
                let (vo, fields) = self.variant_fields(name, variants, &mut ro)?;
                let (vn, _) = self.variant_fields(name, variants, &mut rn)?;
                if vo != vn || fields.is_empty() {
                    false
                } else {
                    let o = self.split(&fields, &old[ro.position()..])?;
                    let n = self.split(&fields, &new[rn.position()..])?;
                    for (i, field) in fields.iter().enumerate() {
                        path.push(PathStep::Variant {
                            variant: vo as u32,
                            field: i as u32,
                        });
                        self.diff(field, o[i], n[i], path, &mut finer)?;
                        path.pop();
                    }
                    true
                }
            }
            Shape::Option(inner) => {
                if old.first() == Some(&1) && new.first() == Some(&1) {
                    path.push(PathStep::Present);
                    self.diff(inner, &old[1..], &new[1..], path, &mut finer)?;
                    path.pop();
                    true
                } else {
                    false
                }
            }
            Shape::Map(key, value) => {
                let o = self.entries(key, value, old)?;
                let n = self.entries(key, value, new)?;
                let (mut i, mut j) = (0, 0);
                while i < o.len() || j < n.len() {
                    let order = match (o.get(i), n.get(j)) {
                        (Some(a), Some(b)) => a.key.cmp(&b.key),
                        (Some(_), None) => Ordering::Less,
                        _ => Ordering::Greater,
                    };
                    match order {
                        Ordering::Less => {
                            finer.push(PatchOp::MapRemove {
                                path: path.clone(),
                                key: Bytes(o[i].key_bytes.to_vec()),
                            });
                            i += 1;
                        }
                        Ordering::Greater => {
                            finer.push(PatchOp::MapPut {
                                path: path.clone(),
                                key: Bytes(n[j].key_bytes.to_vec()),
                                value: Bytes(n[j].value.to_vec()),
                            });
                            j += 1;
                        }
                        Ordering::Equal => {
                            path.push(PathStep::Entry {
                                key: Bytes(n[j].key_bytes.to_vec()),
                            });
                            self.diff(value, o[i].value, n[j].value, path, &mut finer)?;
                            path.pop();
                            i += 1;
                            j += 1;
                        }
                    }
                }
                true
            }
            Shape::Vec | Shape::Scalar => false,
        };
        let set = PatchOp::Set {
            path: path.clone(),
            value: Bytes(new.to_vec()),
        };
        if structured && encoded_len(&finer) < set.to_bytes().len() {
            out.extend(finer);
        } else {
            out.push(set);
        }
        Ok(())
    }

    fn apply_op(&self, ty: &TypeRef, bytes: &[u8], op: &PatchOp) -> Result<Vec<u8>, PatchError> {
        match op {
            PatchOp::Set { path, value } => self.rewrite(ty, bytes, path, &mut |ty, _| {
                self.check(ty, value)?;
                Ok(value.0.clone())
            }),
            PatchOp::MapPut { path, key, value } => {
                self.rewrite(ty, bytes, path, &mut |ty, bytes| {
                    let Shape::Map(kt, vt) = self.shape(ty)? else {
                        return Err(PatchError(format!("MapPut on `{ty}`, which is not a map")));
                    };
                    let mut r = Reader::new(key);
                    let k = self.read_key(kt, &mut r)?;
                    r.finish()?;
                    self.check(vt, value)?;
                    let mut entries = self.entries(kt, vt, bytes)?;
                    let new = Entry {
                        key: k,
                        key_bytes: key,
                        value,
                    };
                    match entries.binary_search_by(|e| e.key.cmp(&new.key)) {
                        Ok(i) => entries[i] = new,
                        Err(i) => entries.insert(i, new),
                    }
                    Ok(encode_entries(&entries))
                })
            }
            PatchOp::MapRemove { path, key } => self.rewrite(ty, bytes, path, &mut |ty, bytes| {
                let Shape::Map(kt, vt) = self.shape(ty)? else {
                    return Err(PatchError(format!(
                        "MapRemove on `{ty}`, which is not a map"
                    )));
                };
                let mut entries = self.entries(kt, vt, bytes)?;
                let i = entries
                    .iter()
                    .position(|e| e.key_bytes == &key.0[..])
                    .ok_or_else(|| PatchError(format!("MapRemove of absent key {key:?}")))?;
                entries.remove(i);
                Ok(encode_entries(&entries))
            }),
        }
    }

    /// Rebuilds `bytes` (a `ty`) with the value at `path` replaced by
    /// `leaf(type there, bytes there)`.
    fn rewrite(
        &self,
        ty: &TypeRef,
        bytes: &[u8],
        path: &[PathStep],
        leaf: &mut Leaf<'_>,
    ) -> Result<Vec<u8>, PatchError> {
        let Some((step, rest)) = path.split_first() else {
            return leaf(ty, bytes);
        };
        let mismatch = || PatchError(format!("path step {step:?} does not fit `{ty}`"));
        match (step, self.shape(ty)?) {
            (PathStep::Field { index }, Shape::Struct(fields)) => {
                let i = *index as usize;
                let field = fields.get(i).ok_or_else(mismatch)?;
                let spans = self.split(&fields, bytes)?;
                let mut out = Vec::with_capacity(bytes.len());
                for (j, span) in spans.iter().enumerate() {
                    if j == i {
                        out.extend(self.rewrite(field, span, rest, leaf)?);
                    } else {
                        out.extend_from_slice(span);
                    }
                }
                Ok(out)
            }
            (PathStep::Variant { variant, field }, Shape::Enum(name, variants)) => {
                let mut r = Reader::new(bytes);
                let (index, fields) = self.variant_fields(name, variants, &mut r)?;
                if index != u64::from(*variant) {
                    return Err(PatchError(format!(
                        "path expects variant {variant} of `{ty}`, the value is variant {index}"
                    )));
                }
                let i = *field as usize;
                let field_ty = fields.get(i).copied().ok_or_else(mismatch)?;
                let head = r.position();
                let spans = self.split(&fields, &bytes[head..])?;
                let mut out = bytes[..head].to_vec();
                for (j, span) in spans.iter().enumerate() {
                    if j == i {
                        out.extend(self.rewrite(field_ty, span, rest, leaf)?);
                    } else {
                        out.extend_from_slice(span);
                    }
                }
                Ok(out)
            }
            (PathStep::Present, Shape::Option(inner)) => {
                if bytes.first() != Some(&1) {
                    return Err(PatchError(format!("path goes into an absent `{ty}`")));
                }
                let mut out = vec![1];
                out.extend(self.rewrite(inner, &bytes[1..], rest, leaf)?);
                Ok(out)
            }
            (PathStep::Entry { key }, Shape::Map(kt, vt)) => {
                let entries = self.entries(kt, vt, bytes)?;
                let i = entries
                    .iter()
                    .position(|e| e.key_bytes == &key.0[..])
                    .ok_or_else(|| PatchError(format!("path names absent map key {key:?}")))?;
                let value = self.rewrite(vt, entries[i].value, rest, leaf)?;
                let mut entries = entries;
                entries[i].value = &value;
                Ok(encode_entries(&entries))
            }
            _ => Err(mismatch()),
        }
    }
}

fn encode_entries(entries: &[Entry<'_>]) -> Vec<u8> {
    let mut w = Writer::new();
    w.write_len(entries.len());
    for e in entries {
        w.write_raw(e.key_bytes);
        w.write_raw(e.value);
    }
    w.into_bytes()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::Fixed;
    use crate::arbitrary::Arbitrary;

    // Test types with the shapes a game's live results have.
    #[derive(Wire, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    struct Id(u32);

    #[derive(Wire, Debug, Clone, PartialEq)]
    struct Slot {
        item: Id,
        count: u8,
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    struct Amount {
        at: u64,
        value: Fixed,
        rate: Fixed,
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    struct Store {
        capacity: u32,
        items: BTreeMap<Id, Amount>,
        full_at: Option<u64>,
        empty_at: BTreeMap<Id, u64>,
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    enum Cause {
        NoPower,
        NoInput,
        Unrecorded,
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    enum Status {
        Idle,
        Running,
        Stalled { cause: Cause },
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    struct Machine {
        block: Id,
        status: Status,
        spin: Fixed,
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    struct Pos {
        x: Fixed,
        y: Fixed,
        yaw: u8,
        on_ground: bool,
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    enum Msg {
        Welcome {
            id: u64,
            name: String,
        },
        Moved(Pos),
        Slots(BTreeMap<u8, Slot>),
        Machines(Vec<Option<Machine>>),
        Blob {
            data: Bytes,
            tags: BTreeMap<String, i64>,
        },
        Bye,
    }

    fn check_round_trip<T: Wire>(old: &T, new: &T) -> Vec<PatchOp> {
        let (schema, ty) = Schema::for_type::<T>();
        let (o, n) = (old.to_bytes(), new.to_bytes());
        let ops = diff(&schema, &ty, &o, &n).unwrap();
        assert_eq!(apply(&schema, &ty, &o, &ops).unwrap(), n);
        if o == n {
            assert!(ops.is_empty());
        }
        ops
    }

    fn amount(at: u64, value: i32) -> Amount {
        Amount {
            at,
            value: Fixed::from_int(value),
            rate: Fixed::ZERO,
        }
    }

    #[test]
    fn equal_values_need_no_ops() {
        let v: BTreeMap<u8, Slot> = BTreeMap::new();
        assert!(check_round_trip(&v, &v).is_empty());
    }

    #[test]
    fn a_changed_map_entry_is_patched_in_place() {
        let slot = |count| Slot { item: Id(3), count };
        let old: BTreeMap<u8, Slot> = [(0, slot(1)), (5, slot(64)), (9, slot(2))].into();
        let mut new = old.clone();
        new.insert(5, slot(63));
        let ops = check_round_trip(&old, &new);
        // The slot's two bytes are cheaper to send whole than a path to
        // its count; either way only slot 5 is touched.
        assert_eq!(
            ops,
            vec![PatchOp::Set {
                path: vec![PathStep::Entry {
                    key: Bytes(vec![5])
                }],
                value: Bytes(vec![3, 63]),
            }]
        );
        // Added and removed entries.
        let mut new = old.clone();
        new.remove(&0);
        new.insert(7, slot(1));
        let ops = check_round_trip(&old, &new);
        assert!(
            matches!(ops[..], [PatchOp::MapRemove { .. }, PatchOp::MapPut { .. }]),
            "{ops:?}"
        );
    }

    #[test]
    fn options_and_variants() {
        let view = |items: &[(u32, i32)]| Store {
            capacity: 27,
            items: items.iter().map(|&(i, v)| (Id(i), amount(10, v))).collect(),
            full_at: None,
            empty_at: BTreeMap::new(),
        };
        let ops = check_round_trip(&Some(view(&[(1, 2)])), &Some(view(&[(1, 3)])));
        assert!(matches!(&ops[0], PatchOp::Set { path, .. } if path[0] == PathStep::Present));
        check_round_trip(&None, &Some(view(&[])));
        check_round_trip(&Some(view(&[(4, 1)])), &None);
        let machine = |status| Machine {
            block: Id(2),
            status,
            spin: Fixed::ZERO,
        };
        check_round_trip(
            &machine(Status::Running),
            &machine(Status::Stalled {
                cause: Cause::NoPower,
            }),
        );
        check_round_trip(
            &machine(Status::Stalled {
                cause: Cause::NoInput,
            }),
            &machine(Status::Stalled {
                cause: Cause::Unrecorded,
            }),
        );
        let ops = check_round_trip(
            &Status::Stalled {
                cause: Cause::NoInput,
            },
            &Status::Stalled {
                cause: Cause::NoPower,
            },
        );
        // A two-byte value is cheaper whole than a path into it.
        assert!(matches!(&ops[..], [PatchOp::Set { path, .. }] if path.is_empty()));
        // A larger value is patched inside: only its status goes.
        let machine = |cause| Machine {
            block: Id(2),
            status: Status::Stalled { cause },
            spin: Fixed::from_int(8),
        };
        let ops = check_round_trip(&machine(Cause::NoInput), &machine(Cause::NoPower));
        assert_eq!(
            ops,
            vec![PatchOp::Set {
                path: vec![PathStep::Field { index: 1 }],
                value: Bytes(vec![2, 0]),
            }]
        );
    }

    #[test]
    fn a_patch_is_never_much_larger_than_the_value() {
        let old: BTreeMap<u32, u32> = (0..50).map(|i| (i, i)).collect();
        let new: BTreeMap<u32, u32> = (100..150).map(|i| (i, i)).collect();
        let ops = check_round_trip(&old, &new);
        assert!(matches!(&ops[..], [PatchOp::Set { path, .. }] if path.is_empty()));
    }

    #[test]
    fn apply_refuses_bad_patches() {
        let (schema, ty) = Schema::for_type::<BTreeMap<u8, u32>>();
        let old = BTreeMap::from([(1u8, 5u32)]).to_bytes();
        let bad = |ops: Vec<PatchOp>| apply(&schema, &ty, &old, &ops).unwrap_err().0;
        assert!(
            bad(vec![PatchOp::MapRemove {
                path: vec![],
                key: Bytes(vec![2])
            }])
            .contains("absent")
        );
        assert!(
            bad(vec![PatchOp::Set {
                path: vec![PathStep::Present],
                value: Bytes(vec![0])
            }])
            .contains("does not fit")
        );
        assert!(
            bad(vec![PatchOp::MapPut {
                path: vec![],
                key: Bytes(vec![1, 2]),
                value: Bytes(vec![0])
            }])
            .contains("trailing")
        );
        assert!(
            bad(vec![PatchOp::Set {
                path: vec![],
                value: Bytes(vec![1, 1])
            }])
            .contains("bad encoding")
        );
    }

    #[test]
    fn hashes_match_the_stable_hasher() {
        assert_eq!(result_hash(&[]), {
            let mut h = crate::hash::StableHasher::new();
            h.write_bytes(&[]);
            h.finish()
        });
        assert_eq!(hash_hex(0xab), "00000000000000ab");
        assert_eq!(parse_hash_hex("00000000000000ab"), Some(0xab));
        assert_eq!(parse_hash_hex("00000000000000AB"), None);
        assert_eq!(parse_hash_hex("ab"), None);
    }

    /// apply(old, diff(old, new)) == new for random pairs of every result
    /// type, with structure shared between old and new so diffs go deep.
    #[test]
    fn random_round_trips() {
        fn run<T: Wire>(rounds: u64) {
            let (schema, ty) = Schema::for_type::<T>();
            let mut arb = Arbitrary::new(&schema, 0x5eed);
            for _ in 0..rounds {
                let old = arb.value(&ty);
                let new = arb.mutate(&ty, &old);
                let ops = diff(&schema, &ty, &old, &new).unwrap();
                assert_eq!(
                    apply(&schema, &ty, &old, &ops).unwrap(),
                    new,
                    "{ty}: {ops:?}"
                );
                assert!(
                    encoded_len(&ops) <= new.len() + 8,
                    "{ty}: patch larger than a Set"
                );
                // Both decode as T, so the generator only makes canonical values.
                T::from_bytes(&old).unwrap();
                T::from_bytes(&new).unwrap();
            }
        }
        run::<Vec<Option<Machine>>>(300);
        run::<BTreeMap<u8, Slot>>(500);
        run::<Pos>(200);
        run::<Option<Store>>(500);
        run::<Option<Machine>>(500);
        run::<Msg>(300);
    }
}
