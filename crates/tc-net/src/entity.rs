//! The entity stream's server side: [`EntityEncoder`] writes, for one
//! client, the frames `ServerMsg::EntityStream` carries, the same as
//! `EntityEncoder` in `src/net/entities.ts`.
//!
//! A frame:
//!
//! - `u8` flags: bit 0 is a key frame (the client drops what it holds,
//!   then every thing comes whole).
//! - `u64` tick, then a count, then that many entries.
//! - An entry is the thing's `u64` id and a varint of bits: bit 0 gone
//!   (nothing follows), bit 1 new (every field follows), else bit `2 + i`
//!   says field `i` follows. Fields follow in order, each in its schema
//!   encoding.
//!
//! The view is a struct of the game's schema (`Ghost { x: i32, y: i32 }`);
//! the encoder encodes each thing's view and splits it into its fields'
//! encodings by walking the schema, then sends only the fields whose bytes
//! changed.

use std::collections::{BTreeMap, BTreeSet};

use tc_wire::schema::{Schema, TypeKind, TypeRef, VariantFields};
use tc_wire::{DecodeError, Reader, Wire, Writer};

/// Frame flag: a key frame.
pub const KEY: u8 = 1;
/// Entry bit: the thing is gone.
pub const GONE: u32 = 1;
/// Entry bit: the thing is new; every field follows.
pub const NEW: u32 = 2;
/// The most fields a view may have (the field bits fit a 31-bit varint).
pub const MAX_VIEW_FIELDS: usize = 29;

/// Why a view can't be streamed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewError(pub String);

impl std::fmt::Display for ViewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ViewError {}

/// Writes the entity stream for one client. Keeps what it last sent of
/// each thing; the first frame, and the one after [`resync`](Self::resync),
/// is a key frame.
#[derive(Debug)]
pub struct EntityEncoder<V: Wire> {
    schema: Schema,
    fields: Vec<TypeRef>,
    sent: BTreeMap<u64, Vec<Vec<u8>>>,
    key: bool,
    scratch: Writer,
    _view: std::marker::PhantomData<fn(&V)>,
}

impl<V: Wire> EntityEncoder<V> {
    /// An encoder for view `V`, a struct of `schema` of at most
    /// [`MAX_VIEW_FIELDS`] fields.
    pub fn new(schema: &Schema) -> Result<EntityEncoder<V>, ViewError> {
        let mut probe = tc_wire::schema::SchemaBuilder::new();
        let TypeRef::Named(name) = V::describe(&mut probe) else {
            return Err(ViewError("a view is a named struct".into()));
        };
        let fields = match schema.get(name).map(|d| &d.kind) {
            Some(TypeKind::Struct(fields)) => {
                fields.iter().map(|f| f.ty.clone()).collect::<Vec<_>>()
            }
            Some(_) => return Err(ViewError(format!("{name} is not a struct"))),
            None => return Err(ViewError(format!("{name} is not in the schema"))),
        };
        if fields.len() > MAX_VIEW_FIELDS {
            return Err(ViewError(format!(
                "{name} has {} fields; at most {MAX_VIEW_FIELDS}",
                fields.len()
            )));
        }
        Ok(EntityEncoder {
            schema: schema.clone(),
            fields,
            sent: BTreeMap::new(),
            key: true,
            scratch: Writer::new(),
            _view: std::marker::PhantomData,
        })
    }

    /// The next frame is a key frame (the client sent `EntityResync`).
    pub fn resync(&mut self) {
        self.key = true;
    }

    /// The frame that brings the client from what it was last sent to
    /// `things` (each id once); `None` if nothing changed.
    pub fn frame<'a>(
        &mut self,
        tick: u64,
        things: impl IntoIterator<Item = (u64, &'a V)>,
    ) -> Option<Vec<u8>>
    where
        V: 'a,
    {
        let key = std::mem::take(&mut self.key);
        if key {
            self.sent.clear();
        }
        let mut body = Writer::new();
        let mut n = 0u32;
        let mut seen = BTreeSet::new();
        for (id, view) in things {
            seen.insert(id);
            let enc = self.split(view);
            match self.sent.insert(id, enc) {
                None => {
                    let enc = &self.sent[&id];
                    body.write_varint(id);
                    body.write_varint(u64::from(NEW));
                    for f in enc {
                        body.write_raw(f);
                    }
                    n += 1;
                }
                Some(last) => {
                    let enc = &self.sent[&id];
                    let mut bits = 0u32;
                    for (i, (now, was)) in enc.iter().zip(&last).enumerate() {
                        if now != was {
                            bits |= 4 << i;
                        }
                    }
                    if bits == 0 {
                        continue;
                    }
                    body.write_varint(id);
                    body.write_varint(u64::from(bits));
                    for (i, f) in enc.iter().enumerate() {
                        if bits & (4 << i) != 0 {
                            body.write_raw(f);
                        }
                    }
                    n += 1;
                }
            }
        }
        let gone: Vec<u64> = self
            .sent
            .keys()
            .copied()
            .filter(|id| !seen.contains(id))
            .collect();
        for id in gone {
            self.sent.remove(&id);
            body.write_varint(id);
            body.write_varint(u64::from(GONE));
            n += 1;
        }
        if n == 0 && !key {
            return None;
        }
        let body = body.into_bytes();
        let mut w = Writer::with_capacity(body.len() + 16);
        w.write_u8(if key { KEY } else { 0 });
        w.write_varint(tick);
        w.write_varint(u64::from(n));
        w.write_raw(&body);
        Some(w.into_bytes())
    }

    /// `view`'s encoding, one piece per field.
    fn split(&mut self, view: &V) -> Vec<Vec<u8>> {
        self.scratch.clear();
        view.encode(&mut self.scratch);
        let bytes = self.scratch.as_bytes();
        let mut r = Reader::new(bytes);
        let mut out = Vec::with_capacity(self.fields.len());
        for ty in &self.fields {
            let start = r.position();
            skip(&self.schema, ty, &mut r).expect("a view encodes as its schema says");
            out.push(r.since(start).to_vec());
        }
        out
    }
}

/// Reads past one value of `ty`.
fn skip(schema: &Schema, ty: &TypeRef, r: &mut Reader<'_>) -> Result<(), DecodeError> {
    match ty {
        TypeRef::Bool => {
            r.read_bool()?;
        }
        TypeRef::U8 => {
            r.read_u8()?;
        }
        TypeRef::U16
        | TypeRef::U32
        | TypeRef::U64
        | TypeRef::I32
        | TypeRef::I64
        | TypeRef::Fixed => {
            r.read_varint()?;
        }
        TypeRef::String | TypeRef::Bytes => {
            let len = r.read_len()?;
            r.read_raw(len)?;
        }
        TypeRef::Vec(inner) => {
            for _ in 0..r.read_len()? {
                skip(schema, inner, r)?;
            }
        }
        TypeRef::Map(k, v) => {
            for _ in 0..r.read_len()? {
                skip(schema, k, r)?;
                skip(schema, v, r)?;
            }
        }
        TypeRef::Option(inner) => {
            if r.read_option_tag()? {
                skip(schema, inner, r)?;
            }
        }
        TypeRef::Named(name) => {
            let def = schema.get(name).expect("a schema names only its own types");
            match &def.kind {
                TypeKind::Struct(fields) => {
                    for f in fields {
                        skip(schema, &f.ty, r)?;
                    }
                }
                TypeKind::Newtype(inner) => skip(schema, inner, r)?,
                TypeKind::Enum(variants) => {
                    let at = r.position();
                    let index = r.read_variant()?;
                    let v = usize::try_from(index)
                        .ok()
                        .and_then(|i| variants.get(i))
                        .ok_or_else(|| DecodeError::unknown_variant(at, "view enum", index))?;
                    match &v.fields {
                        VariantFields::Unit => {}
                        VariantFields::Named(fields) => {
                            for f in fields {
                                skip(schema, &f.ty, r)?;
                            }
                        }
                        VariantFields::Newtype(inner) => skip(schema, inner, r)?,
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use tc_wire::schema::SchemaBuilder;
    use tc_wire::{Bytes, Wire};

    use super::*;

    #[derive(Wire, Debug, Clone, PartialEq)]
    enum Mood {
        Calm,
        Cross { why: String },
        Odd(u8),
    }

    #[derive(Wire, Debug, Clone, PartialEq)]
    struct Ghost {
        x: i32,
        y: i32,
        name: String,
        mood: Mood,
        tags: Vec<u16>,
        bag: BTreeMap<String, u64>,
        hat: Option<Bytes>,
        lit: bool,
    }

    fn schema() -> Schema {
        let mut b = SchemaBuilder::new();
        b.root::<Ghost>();
        b.finish().unwrap()
    }

    fn ghost(x: i32) -> Ghost {
        Ghost {
            x,
            y: -3,
            name: "boo".into(),
            mood: Mood::Cross { why: "x".into() },
            tags: vec![1, 300],
            bag: BTreeMap::from([("a".into(), 5)]),
            hat: Some(Bytes(vec![9])),
            lit: true,
        }
    }

    /// Reads a frame back: (key, tick, entries of (id, bits, field bytes)).
    fn read(frame: &[u8]) -> (bool, u64, Vec<(u64, u32, usize)>) {
        let schema = schema();
        let fields: Vec<TypeRef> = match &schema.get("Ghost").unwrap().kind {
            TypeKind::Struct(f) => f.iter().map(|f| f.ty.clone()).collect(),
            _ => unreachable!(),
        };
        let mut r = Reader::new(frame);
        let key = r.read_u8().unwrap() == KEY;
        let tick = r.read_varint().unwrap();
        let n = r.read_len().unwrap();
        let mut out = Vec::new();
        for _ in 0..n {
            let id = r.read_varint().unwrap();
            let bits = r.read_varint().unwrap() as u32;
            let start = r.position();
            if bits != GONE {
                for (i, ty) in fields.iter().enumerate() {
                    if bits == NEW || bits & (4 << i) != 0 {
                        skip(&schema, ty, &mut r).unwrap();
                    }
                }
            }
            out.push((id, bits, r.position() - start));
        }
        r.finish().unwrap();
        (key, tick, out)
    }

    #[test]
    fn sends_new_things_whole_then_only_what_changed() {
        let schema = schema();
        let mut enc = EntityEncoder::<Ghost>::new(&schema).unwrap();
        let a = ghost(1);
        let b = ghost(2);
        let first = enc.frame(10, [(1, &a), (2, &b)]).unwrap();
        let whole = a.to_bytes().len();
        assert_eq!(
            read(&first),
            (true, 10, vec![(1, NEW, whole), (2, NEW, whole)])
        );
        // Nothing changed: no frame.
        assert!(enc.frame(11, [(1, &a), (2, &b)]).is_none());
        // One field of one thing: just that field.
        let mut a2 = a.clone();
        a2.mood = Mood::Odd(4);
        let (key, tick, entries) = read(&enc.frame(12, [(1, &a2), (2, &b)]).unwrap());
        assert_eq!((key, tick), (false, 12));
        assert_eq!(entries, vec![(1, 4 << 3, 2)]);
        // A thing left out is gone.
        let (_, _, entries) = read(&enc.frame(13, [(1, &a2)]).unwrap());
        assert_eq!(entries, vec![(2, GONE, 0)]);
        // A resync sends a key frame with everything whole, even unchanged.
        enc.resync();
        let (key, _, entries) = read(&enc.frame(14, [(1, &a2)]).unwrap());
        assert!(key);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].1, NEW);
        // An empty key frame still goes (the client drops what it holds).
        enc.resync();
        let (key, _, entries) = read(&enc.frame(15, []).unwrap());
        assert!(key && entries.is_empty());
    }

    #[test]
    fn a_view_must_be_a_small_struct_of_the_schema() {
        let schema = schema();
        assert!(EntityEncoder::<Mood>::new(&schema).is_err());
        assert!(EntityEncoder::<u32>::new(&schema).is_err());
        let mut b = SchemaBuilder::new();
        b.root::<Mood>();
        let other = b.finish().unwrap();
        assert!(EntityEncoder::<Ghost>::new(&other).is_err());
    }
}
