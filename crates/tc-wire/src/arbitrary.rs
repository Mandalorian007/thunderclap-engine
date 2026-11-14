//! Random canonical encodings of any schema type, for property tests of the
//! diff and of anything else that walks encodings.
//!
//! Values come from small domains (few distinct integers, strings, and map
//! keys) so that two random values often share parts, and
//! [`Arbitrary::mutate`] derives a new value from an old one, keeping most
//! of its structure, so diffs between them go deep.

use crate::Wire;
use crate::schema::{Schema, TypeKind, TypeRef, VariantFields};
use crate::wire::{Bytes, Reader, Writer};

/// A deterministic generator of encoded values.
pub struct Arbitrary<'s> {
    schema: &'s Schema,
    state: u64,
    depth: u32,
}

impl<'s> Arbitrary<'s> {
    /// A generator for `schema`'s types, seeded with `seed`.
    pub fn new(schema: &'s Schema, seed: u64) -> Arbitrary<'s> {
        Arbitrary {
            schema,
            state: seed,
            depth: 0,
        }
    }

    fn next(&mut self) -> u64 {
        self.state = self.state.wrapping_add(crate::hash::GOLDEN_GAMMA);
        crate::hash::mix64(self.state)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    /// A random canonical encoding of `ty`.
    pub fn value(&mut self, ty: &TypeRef) -> Vec<u8> {
        let mut w = Writer::new();
        self.write(ty, &mut w);
        w.into_bytes()
    }

    /// A random value of `ty` that keeps much of `old` (an encoding of
    /// `ty`): struct fields, enum variants, map entries, and options are
    /// each kept, changed, or replaced at random.
    ///
    /// # Panics
    ///
    /// If `old` is not a valid encoding of `ty`.
    pub fn mutate(&mut self, ty: &TypeRef, old: &[u8]) -> Vec<u8> {
        let mut r = Reader::new(old);
        let mut w = Writer::new();
        self.mutate_value(ty, &mut r, &mut w);
        r.finish().expect("mutate takes one whole value");
        w.into_bytes()
    }

    fn write(&mut self, ty: &TypeRef, w: &mut Writer) {
        let deep = self.depth > 6;
        self.depth += 1;
        match self.schema.resolve(ty) {
            TypeRef::Bool => (self.below(2) == 1).encode(w),
            TypeRef::U8 => (self.small() as u8).encode(w),
            TypeRef::U16 => (self.small() as u16).encode(w),
            TypeRef::U32 => (self.small() as u32).encode(w),
            TypeRef::U64 => self.small().encode(w),
            TypeRef::I32 => (self.small() as i32 - 3).encode(w),
            TypeRef::I64 => (self.small() as i64 - 3).encode(w),
            TypeRef::Fixed => crate::Fixed::from_bits((self.small() as i64 - 3) << 30).encode(w),
            TypeRef::String => ["", "a", "b", "oak", "é🌲"][self.below(5) as usize]
                .to_string()
                .encode(w),
            TypeRef::Bytes => Bytes(vec![self.small() as u8; self.below(3) as usize]).encode(w),
            TypeRef::Vec(inner) => {
                let len = if deep { 0 } else { self.below(4) as usize };
                w.write_len(len);
                for _ in 0..len {
                    self.write(inner, w);
                }
            }
            TypeRef::Option(inner) => {
                if deep || self.chance(30) {
                    w.write_u8(0);
                } else {
                    w.write_u8(1);
                    self.write(inner, w);
                }
            }
            TypeRef::Map(key, value) => {
                let count = if deep { 0 } else { self.below(5) };
                let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
                for _ in 0..count {
                    let k = self.key(key);
                    let v = self.value(value);
                    entries.push((k, v));
                }
                self.write_entries(key, entries, w);
            }
            TypeRef::Named(name) => match &self.schema.get(name).expect("defined").kind {
                TypeKind::Struct(fields) => {
                    for f in fields {
                        self.write(&f.ty, w);
                    }
                }
                TypeKind::Enum(variants) => {
                    let i = self.below(variants.len() as u64) as usize;
                    w.write_varint(i as u64);
                    for field in variant_types(&variants[i].fields) {
                        self.write(field, w);
                    }
                }
                TypeKind::Newtype(_) => unreachable!("resolve follows newtypes"),
            },
        }
        self.depth -= 1;
    }

    /// Mostly tiny numbers, sometimes large ones.
    fn small(&mut self) -> u64 {
        if self.chance(90) {
            self.below(6)
        } else {
            200 + self.below(100_000)
        }
    }

    /// A key from a domain of eight, so maps overlap.
    fn key(&mut self, ty: &TypeRef) -> Vec<u8> {
        let k = self.below(8);
        match self.schema.resolve(ty) {
            TypeRef::U8 => (k as u8).to_bytes(),
            TypeRef::U16 => (k as u16).to_bytes(),
            TypeRef::U32 => (k as u32 * 1000).to_bytes(),
            TypeRef::U64 => (k * 1_000_000).to_bytes(),
            TypeRef::I32 => (k as i32 - 4).to_bytes(),
            TypeRef::I64 => (k as i64 - 4).to_bytes(),
            TypeRef::String => ["", "a", "b", "z", "é", "0,6,0", "-2,6,0", "🌲"][k as usize]
                .to_string()
                .to_bytes(),
            other => panic!("`{other}` is not a map key type"),
        }
    }

    /// Writes entries sorted by key, dropping duplicate keys.
    fn write_entries(
        &mut self,
        key: &TypeRef,
        mut entries: Vec<(Vec<u8>, Vec<u8>)>,
        w: &mut Writer,
    ) {
        let order = |schema: &Schema, bytes: &[u8]| -> (i128, String) {
            let mut r = Reader::new(bytes);
            match schema.resolve(key) {
                TypeRef::U8 => (u8::decode(&mut r).unwrap().into(), String::new()),
                TypeRef::U16 => (u16::decode(&mut r).unwrap().into(), String::new()),
                TypeRef::U32 => (u32::decode(&mut r).unwrap().into(), String::new()),
                TypeRef::U64 => (u64::decode(&mut r).unwrap().into(), String::new()),
                TypeRef::I32 => (i32::decode(&mut r).unwrap().into(), String::new()),
                TypeRef::I64 => (i64::decode(&mut r).unwrap().into(), String::new()),
                _ => (0, String::decode(&mut r).unwrap()),
            }
        };
        let schema = self.schema;
        entries.sort_by_key(|a| order(schema, &a.0));
        entries.dedup_by(|a, b| a.0 == b.0);
        w.write_len(entries.len());
        for (k, v) in entries {
            w.write_raw(&k);
            w.write_raw(&v);
        }
    }

    fn mutate_value(&mut self, ty: &TypeRef, r: &mut Reader<'_>, w: &mut Writer) {
        let start = r.position();
        let mut scratch = Writer::new();
        self.copy(ty, r, &mut scratch);
        let old = r.since(start).to_vec();
        // Keep it, replace it, or recurse into it.
        if self.chance(35) {
            w.write_raw(&old);
            return;
        }
        if self.chance(25) {
            self.write(ty, w);
            return;
        }
        let mut r = Reader::new(&old);
        match self.schema.resolve(ty) {
            TypeRef::Option(inner) => {
                if r.read_option_tag().unwrap() {
                    w.write_u8(1);
                    self.mutate_value(inner, &mut r, w);
                } else {
                    self.write(ty, w);
                }
            }
            TypeRef::Map(key, value) => {
                let len = r.read_len().unwrap();
                let mut entries = Vec::new();
                for _ in 0..len {
                    let ks = r.position();
                    self.copy(key, &mut r, &mut Writer::new());
                    let k = r.since(ks).to_vec();
                    if self.chance(20) {
                        self.copy(value, &mut r, &mut Writer::new());
                        continue; // removed
                    }
                    let mut v = Writer::new();
                    self.mutate_value(value, &mut r, &mut v);
                    entries.push((k, v.into_bytes()));
                }
                for _ in 0..self.below(3) {
                    let k = self.key(key);
                    if !entries.iter().any(|(e, _)| *e == k) {
                        let v = self.value(value);
                        entries.push((k, v));
                    }
                }
                self.write_entries(key, entries, w);
            }
            TypeRef::Named(name) => match &self.schema.get(name).expect("defined").kind {
                TypeKind::Struct(fields) => {
                    for f in fields {
                        self.mutate_value(&f.ty, &mut r, w);
                    }
                }
                TypeKind::Enum(variants) => {
                    let i = r.read_variant().unwrap() as usize;
                    w.write_varint(i as u64);
                    for field in variant_types(&variants[i].fields) {
                        self.mutate_value(field, &mut r, w);
                    }
                }
                TypeKind::Newtype(_) => unreachable!("resolve follows newtypes"),
            },
            _ => self.write(ty, w),
        }
    }

    /// Copies one value of `ty` from `r` to `w` unchanged.
    fn copy(&mut self, ty: &TypeRef, r: &mut Reader<'_>, w: &mut Writer) {
        let start = r.position();
        match self.schema.resolve(ty) {
            TypeRef::Bool => drop(bool::decode(r).unwrap()),
            TypeRef::U8 => drop(u8::decode(r).unwrap()),
            TypeRef::U16 => drop(u16::decode(r).unwrap()),
            TypeRef::U32 => drop(u32::decode(r).unwrap()),
            TypeRef::U64 | TypeRef::I64 | TypeRef::Fixed => drop(r.read_varint().unwrap()),
            TypeRef::I32 => drop(i32::decode(r).unwrap()),
            TypeRef::String => drop(String::decode(r).unwrap()),
            TypeRef::Bytes => drop(Bytes::decode(r).unwrap()),
            TypeRef::Vec(inner) => {
                for _ in 0..r.read_len().unwrap() {
                    self.copy(inner, r, &mut Writer::new());
                }
            }
            TypeRef::Option(inner) => {
                if r.read_option_tag().unwrap() {
                    self.copy(inner, r, &mut Writer::new());
                }
            }
            TypeRef::Map(key, value) => {
                for _ in 0..r.read_len().unwrap() {
                    self.copy(key, r, &mut Writer::new());
                    self.copy(value, r, &mut Writer::new());
                }
            }
            TypeRef::Named(name) => match &self.schema.get(name).expect("defined").kind {
                TypeKind::Struct(fields) => {
                    for f in fields {
                        self.copy(&f.ty, r, &mut Writer::new());
                    }
                }
                TypeKind::Enum(variants) => {
                    let i = r.read_variant().unwrap() as usize;
                    for field in variant_types(&variants[i].fields) {
                        self.copy(field, r, &mut Writer::new());
                    }
                }
                TypeKind::Newtype(_) => unreachable!("resolve follows newtypes"),
            },
        }
        w.write_raw(r.since(start));
    }
}

fn variant_types(fields: &VariantFields) -> Vec<&TypeRef> {
    match fields {
        VariantFields::Unit => Vec::new(),
        VariantFields::Named(fields) => fields.iter().map(|f| &f.ty).collect(),
        VariantFields::Newtype(inner) => vec![inner],
    }
}
