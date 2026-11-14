//! Shared by the parity tests (tc-wire's and tc-tsgen's): schemas built
//! from data, and a schema-driven codec between wire bytes and the JSON
//! shape TypeScript sees (camelCase fields, `type` discriminants, `value`
//! for a tuple variant, `null` for `None`, `{"$fixed": bits}`,
//! `{"$bytes": hex}`, `{"$map": [[k, v], ...]}`).

#![allow(dead_code, missing_docs)]

use std::cmp::Ordering;
use std::fmt::Write as _;
use std::path::PathBuf;

use serde_json::Value;
use tc_wire::{
    Bytes, DecodeError, DecodeErrorKind, Field, Fixed, QueryDef, Reader, Schema, TypeDef, TypeKind,
    TypeRef, Variant, VariantFields, Wire, Writer,
};

/// The largest integer a JavaScript number holds exactly.
pub const MAX_SAFE: u64 = (1 << 53) - 1;

/// Forge Wilds' header: the game whose vectors and generated files these
/// tests reproduce.
pub const FORGE_HEADER: &str = "forge-wire 2";

pub fn leak(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

pub fn unhex(hex: &str) -> Vec<u8> {
    assert!(hex.len().is_multiple_of(2), "odd hex {hex}");
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

/// The directory of Forge's vectors and schema (tc-wire's `tests/forge`).
pub fn forge_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tc-wire/tests/forge")
}

pub fn read(path: PathBuf) -> String {
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .replace("\r\n", "\n")
}

pub fn read_json(path: PathBuf) -> Value {
    serde_json::from_str(&read(path)).expect("json")
}

/// The snake_case-to-camelCase rule of generated TypeScript.
pub fn camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for c in name.chars() {
        if c == '_' && !out.is_empty() {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn scalar(name: &str) -> Option<TypeRef> {
    Some(match name {
        "bool" => TypeRef::Bool,
        "u8" => TypeRef::U8,
        "u16" => TypeRef::U16,
        "u32" => TypeRef::U32,
        "u64" => TypeRef::U64,
        "i32" => TypeRef::I32,
        "i64" => TypeRef::I64,
        "Fixed" => TypeRef::Fixed,
        "String" => TypeRef::String,
        "Bytes" => TypeRef::Bytes,
        _ => return None,
    })
}

/// A type reference from JSON: a scalar's name, a bare name (if
/// `bare_names`) or `{"named"}`, `{"vec"}`, `{"option"}`, `{"map": [k, v]}`.
pub fn type_ref(v: &Value, bare_names: bool) -> TypeRef {
    let boxed = |v: &Value| Box::new(type_ref(v, bare_names));
    match v {
        Value::String(s) => scalar(s).unwrap_or_else(|| {
            assert!(bare_names, "unknown scalar {s}");
            TypeRef::Named(leak(s))
        }),
        Value::Object(o) => {
            let (key, inner) = o.iter().next().expect("one key");
            match key.as_str() {
                "vec" => TypeRef::Vec(boxed(inner)),
                "option" => TypeRef::Option(boxed(inner)),
                "map" => TypeRef::Map(boxed(&inner[0]), boxed(&inner[1])),
                "named" => TypeRef::Named(leak(inner.as_str().expect("name"))),
                other => panic!("not a type: {other}"),
            }
        }
        other => panic!("not a type: {other}"),
    }
}

/// Forge's full schema, as `forge_server::schema()` built it (dumped to
/// `tests/forge/schema.json`), under a header: Forge's own reproduces its
/// hash.
pub fn forge_schema(header: &'static str) -> Schema {
    let d = read_json(forge_dir().join("schema.json"));
    let fields = |v: &Value| -> Vec<Field> {
        v.as_array()
            .expect("fields")
            .iter()
            .map(|f| {
                Field::new(
                    leak(f["name"].as_str().unwrap()),
                    leak(f["doc"].as_str().unwrap()),
                    type_ref(&f["ty"], false),
                )
            })
            .collect()
    };
    let types = d["types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let kind = &t["kind"];
            let kind = if let Some(f) = kind.get("struct") {
                TypeKind::Struct(fields(f))
            } else if let Some(inner) = kind.get("newtype") {
                TypeKind::Newtype(type_ref(inner, false))
            } else {
                TypeKind::Enum(
                    kind["enum"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| {
                            let name = leak(v["name"].as_str().unwrap());
                            let doc = leak(v["doc"].as_str().unwrap());
                            match &v["fields"] {
                                Value::Null => Variant::unit(name, doc),
                                f if f.get("named").is_some() => {
                                    Variant::named(name, doc, fields(&f["named"]))
                                }
                                f => Variant::newtype(name, doc, type_ref(&f["newtype"], false)),
                            }
                        })
                        .collect(),
                )
            };
            let name = leak(t["name"].as_str().unwrap());
            TypeDef {
                name,
                rust_path: name,
                doc: leak(t["doc"].as_str().unwrap()),
                kind,
            }
        })
        .collect();
    let queries = d["queries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| QueryDef {
            name: leak(q["name"].as_str().unwrap()),
            doc: leak(q["doc"].as_str().unwrap()),
            player: q["player"].as_bool().unwrap(),
            args: fields(&q["args"]),
            result: type_ref(&q["result"], false),
        })
        .collect();
    let roots = d["roots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| leak(r.as_str().unwrap()))
        .collect();
    Schema::from_parts(header, roots, types, queries).expect("Forge's schema")
}

/// The hash `forge_server::schema()` had when it was dumped.
pub fn forge_hash() -> String {
    read_json(forge_dir().join("schema.json"))["hash"]
        .as_str()
        .unwrap()
        .to_string()
}

/// A schema from TypeScript's `TypesDesc` (`src/net/schema.ts`), with its
/// discovery order: each root's types depth first (a type before its
/// parts), then each query's arguments and result.
pub fn schema_from_desc(header: &'static str, desc: &Value) -> Schema {
    struct Build<'a> {
        desc: &'a Value,
        order: Vec<&'static str>,
        defs: std::collections::BTreeMap<&'static str, TypeDef>,
    }
    impl Build<'_> {
        fn fields(&mut self, specs: &Value) -> Vec<Field> {
            let specs = specs.as_object().expect("fields");
            let out: Vec<Field> = specs
                .iter()
                .map(|(name, spec)| Field::new(leak(name), "", type_ref(spec, true)))
                .collect();
            for f in &out {
                self.reach(&f.ty);
            }
            out
        }
        fn reach(&mut self, ty: &TypeRef) {
            match ty {
                TypeRef::Vec(inner) | TypeRef::Option(inner) => self.reach(inner),
                TypeRef::Map(k, v) => {
                    self.reach(k);
                    self.reach(v);
                }
                TypeRef::Named(name) => self.define(name),
                _ => {}
            }
        }
        fn define(&mut self, name: &'static str) {
            if self.order.contains(&name) {
                return;
            }
            self.order.push(name);
            let spec = &self.desc["types"][name];
            let kind = if let Some(f) = spec.get("struct") {
                TypeKind::Struct(self.fields(f))
            } else if let Some(inner) = spec.get("newtype") {
                let ty = type_ref(inner, true);
                self.reach(&ty);
                TypeKind::Newtype(ty)
            } else {
                let variants = spec["enum"].as_object().expect("enum");
                let mut out = Vec::new();
                for (v, fields) in variants {
                    let v = leak(v);
                    out.push(match fields {
                        Value::Null => Variant::unit(v, ""),
                        Value::Array(one) => {
                            let ty = type_ref(&one[0], true);
                            self.reach(&ty);
                            Variant::newtype(v, "", ty)
                        }
                        f => Variant::named(v, "", self.fields(f)),
                    });
                }
                TypeKind::Enum(out)
            };
            self.defs.insert(
                name,
                TypeDef {
                    name,
                    rust_path: name,
                    doc: "",
                    kind,
                },
            );
        }
    }
    let mut b = Build {
        desc,
        order: Vec::new(),
        defs: Default::default(),
    };
    let roots: Vec<&'static str> = desc["roots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| leak(r.as_str().unwrap()))
        .collect();
    for r in &roots {
        b.define(r);
    }
    let mut queries = Vec::new();
    if let Some(qs) = desc.get("queries").and_then(Value::as_object) {
        for (name, q) in qs {
            let args = q.get("args").map(|a| b.fields(a)).unwrap_or_default();
            let result = type_ref(&q["result"], true);
            b.reach(&result);
            queries.push(QueryDef {
                name: leak(name),
                doc: "",
                player: false,
                args,
                result,
            });
        }
    }
    let types = b
        .order
        .iter()
        .map(|n| b.defs.remove(n).expect("defined"))
        .collect();
    Schema::from_parts(header, roots, types, queries).expect("desc schema")
}

/// Decodes one value of `ty` into TypeScript's JSON shape, as strictly as
/// the derived decoders (the same errors, at the same bytes).
pub fn decode(schema: &Schema, ty: &TypeRef, r: &mut Reader<'_>) -> Result<Value, DecodeError> {
    Ok(match ty {
        TypeRef::Bool => bool::decode(r)?.into(),
        TypeRef::U8 => u8::decode(r)?.into(),
        TypeRef::U16 => u16::decode(r)?.into(),
        TypeRef::U32 => u32::decode(r)?.into(),
        TypeRef::I32 => i32::decode(r)?.into(),
        TypeRef::U64 => {
            let v = u64::decode(r)?;
            assert!(v <= MAX_SAFE, "u64 {v} is not a safe JS integer");
            v.into()
        }
        TypeRef::I64 => {
            let v = i64::decode(r)?;
            assert!(v.unsigned_abs() <= MAX_SAFE, "i64 {v} is not safe");
            v.into()
        }
        TypeRef::Fixed => serde_json::json!({ "$fixed": Fixed::decode(r)?.to_bits().to_string() }),
        TypeRef::String => String::decode(r)?.into(),
        TypeRef::Bytes => serde_json::json!({ "$bytes": hex(&Bytes::decode(r)?.0) }),
        TypeRef::Vec(inner) => {
            let len = r.read_len()?;
            let mut items = Vec::new();
            for _ in 0..len {
                items.push(decode(schema, inner, r)?);
            }
            Value::Array(items)
        }
        TypeRef::Option(inner) => {
            if r.read_option_tag()? {
                decode(schema, inner, r)?
            } else {
                Value::Null
            }
        }
        TypeRef::Map(key, value) => {
            let len = r.read_len()?;
            let mut entries: Vec<Value> = Vec::new();
            for _ in 0..len {
                let at = r.position();
                let k = decode(schema, key, r)?;
                if let Some(last) = entries.last()
                    && compare(schema, key, &last[0], &k) != Ordering::Less
                {
                    return Err(DecodeError::new(at, DecodeErrorKind::MapKeyOrder));
                }
                let v = decode(schema, value, r)?;
                entries.push(Value::Array(vec![k, v]));
            }
            serde_json::json!({ "$map": entries })
        }
        TypeRef::Named(name) => {
            let def = schema.get(name).expect("named type is in the schema");
            match &def.kind {
                TypeKind::Newtype(inner) => decode(schema, inner, r)?,
                TypeKind::Struct(fields) => {
                    let mut obj = serde_json::Map::new();
                    for f in fields {
                        obj.insert(camel(f.name), decode(schema, &f.ty, r)?);
                    }
                    Value::Object(obj)
                }
                TypeKind::Enum(variants) => {
                    let at = r.position();
                    let index = r.read_variant()?;
                    let variant = usize::try_from(index)
                        .ok()
                        .and_then(|i| variants.get(i))
                        .ok_or_else(|| DecodeError::unknown_variant(at, def.name, index))?;
                    let mut obj = serde_json::Map::new();
                    obj.insert("type".into(), variant.name.into());
                    match &variant.fields {
                        VariantFields::Unit => {}
                        VariantFields::Newtype(inner) => {
                            obj.insert("value".into(), decode(schema, inner, r)?);
                        }
                        VariantFields::Named(fields) => {
                            for f in fields {
                                obj.insert(camel(f.name), decode(schema, &f.ty, r)?);
                            }
                        }
                    }
                    Value::Object(obj)
                }
            }
        }
    })
}

/// Decodes all of `bytes` as one `ty`.
pub fn decode_all(schema: &Schema, ty: &TypeRef, bytes: &[u8]) -> Result<Value, DecodeError> {
    let mut r = Reader::new(bytes);
    let v = decode(schema, ty, &mut r)?;
    r.finish()?;
    Ok(v)
}

/// Encodes a value in TypeScript's JSON shape.
pub fn encode(schema: &Schema, ty: &TypeRef, v: &Value, w: &mut Writer) {
    let int = |v: &Value| v.as_i64().unwrap_or_else(|| panic!("not an integer: {v}"));
    match ty {
        TypeRef::Bool => v.as_bool().expect("bool").encode(w),
        TypeRef::U8 => u8::try_from(int(v)).unwrap().encode(w),
        TypeRef::U16 => u16::try_from(int(v)).unwrap().encode(w),
        TypeRef::U32 => u32::try_from(int(v)).unwrap().encode(w),
        TypeRef::I32 => i32::try_from(int(v)).unwrap().encode(w),
        TypeRef::U64 => v.as_u64().expect("u64").encode(w),
        TypeRef::I64 => int(v).encode(w),
        TypeRef::Fixed => {
            Fixed::from_bits(v["$fixed"].as_str().unwrap().parse().unwrap()).encode(w);
        }
        TypeRef::String => v.as_str().expect("string").to_string().encode(w),
        TypeRef::Bytes => Bytes(unhex(v["$bytes"].as_str().unwrap())).encode(w),
        TypeRef::Vec(inner) => {
            let items = v.as_array().expect("array");
            w.write_len(items.len());
            for item in items {
                encode(schema, inner, item, w);
            }
        }
        TypeRef::Option(inner) => {
            if v.is_null() {
                w.write_u8(0);
            } else {
                w.write_u8(1);
                encode(schema, inner, v, w);
            }
        }
        TypeRef::Map(key, value) => {
            let entries = v["$map"].as_array().expect("$map");
            w.write_len(entries.len());
            for e in entries {
                encode(schema, key, &e[0], w);
                encode(schema, value, &e[1], w);
            }
        }
        TypeRef::Named(name) => match &schema.get(name).expect("named").kind {
            TypeKind::Newtype(inner) => encode(schema, inner, v, w),
            TypeKind::Struct(fields) => {
                for f in fields {
                    encode(schema, &f.ty, &v[camel(f.name)], w);
                }
            }
            TypeKind::Enum(variants) => {
                let tag = v["type"].as_str().expect("type");
                let (index, variant) = variants
                    .iter()
                    .enumerate()
                    .find(|(_, x)| x.name == tag)
                    .unwrap_or_else(|| panic!("{name} has no variant {tag}"));
                w.write_varint(index as u64);
                match &variant.fields {
                    VariantFields::Unit => {}
                    VariantFields::Newtype(inner) => encode(schema, inner, &v["value"], w),
                    VariantFields::Named(fields) => {
                        for f in fields {
                            encode(schema, &f.ty, &v[camel(f.name)], w);
                        }
                    }
                }
            }
        },
    }
}

pub fn encode_all(schema: &Schema, ty: &TypeRef, v: &Value) -> Vec<u8> {
    let mut w = Writer::new();
    encode(schema, ty, v, &mut w);
    w.into_bytes()
}

/// Two decoded values of `ty` in the order derived `Ord` puts them.
pub fn compare(schema: &Schema, ty: &TypeRef, a: &Value, b: &Value) -> Ordering {
    let list = |tys: &mut dyn Iterator<Item = (&TypeRef, &Value, &Value)>| {
        tys.map(|(t, x, y)| compare(schema, t, x, y))
            .find(|o| o.is_ne())
            .unwrap_or(Ordering::Equal)
    };
    match ty {
        TypeRef::Bool => a.as_bool().cmp(&b.as_bool()),
        TypeRef::U8 | TypeRef::U16 | TypeRef::U32 | TypeRef::U64 => a.as_u64().cmp(&b.as_u64()),
        TypeRef::I32 | TypeRef::I64 => a.as_i64().cmp(&b.as_i64()),
        TypeRef::Fixed => {
            let bits = |v: &Value| v["$fixed"].as_str().unwrap().parse::<i64>().unwrap();
            bits(a).cmp(&bits(b))
        }
        TypeRef::String => a.as_str().cmp(&b.as_str()),
        TypeRef::Bytes => {
            unhex(a["$bytes"].as_str().unwrap()).cmp(&unhex(b["$bytes"].as_str().unwrap()))
        }
        TypeRef::Option(inner) => match (a.is_null(), b.is_null()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => compare(schema, inner, a, b),
        },
        TypeRef::Vec(inner) => {
            let (x, y) = (a.as_array().unwrap(), b.as_array().unwrap());
            list(&mut x.iter().zip(y).map(|(x, y)| (&**inner, x, y))).then(x.len().cmp(&y.len()))
        }
        TypeRef::Map(k, v) => {
            let (x, y) = (a["$map"].as_array().unwrap(), b["$map"].as_array().unwrap());
            x.iter()
                .zip(y)
                .map(|(x, y)| {
                    compare(schema, k, &x[0], &y[0]).then_with(|| compare(schema, v, &x[1], &y[1]))
                })
                .find(|o| o.is_ne())
                .unwrap_or(Ordering::Equal)
                .then(x.len().cmp(&y.len()))
        }
        TypeRef::Named(name) => match &schema.get(name).unwrap().kind {
            TypeKind::Newtype(inner) => compare(schema, inner, a, b),
            TypeKind::Struct(fields) => list(
                &mut fields
                    .iter()
                    .map(|f| (&f.ty, &a[camel(f.name)], &b[camel(f.name)])),
            ),
            TypeKind::Enum(variants) => {
                let pos = |v: &Value| variants.iter().position(|x| x.name == v["type"]).unwrap();
                let (i, j) = (pos(a), pos(b));
                i.cmp(&j).then_with(|| match &variants[i].fields {
                    VariantFields::Unit => Ordering::Equal,
                    VariantFields::Newtype(t) => compare(schema, t, &a["value"], &b["value"]),
                    VariantFields::Named(fields) => list(
                        &mut fields
                            .iter()
                            .map(|f| (&f.ty, &a[camel(f.name)], &b[camel(f.name)])),
                    ),
                })
            }
        },
    }
}

/// The `fixed` and `parse` sections of a `fixed.json` (Forge's, or
/// `src/net/testdata`'s).
pub fn check_fixed(d: &Value) {
    for case in d["fixed"].as_array().unwrap() {
        let f = Fixed::from_bits(case["bits"].as_str().unwrap().parse().unwrap());
        assert_eq!(f.to_string(), case["display"].as_str().unwrap());
        assert_eq!(f.floor_int(), case["floor"].as_i64().unwrap());
    }
    for case in d["parse"].as_array().unwrap() {
        let f = Fixed::parse_decimal(case["text"].as_str().unwrap()).unwrap();
        assert_eq!(f.to_bits().to_string(), case["bits"].as_str().unwrap());
    }
}
