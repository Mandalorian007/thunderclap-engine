//! Parity with the TypeScript runtime (`src/net`): its schema vectors,
//! hashes and `Fixed` numbers, and vectors written here for it to read.
//!
//! `src/net/testdata/wire-rust.json` holds a schema built from derived
//! types (generics included) as a `TypesDesc`, its canonical text and
//! hash, and values encoded by the derived codecs with the JSON shape
//! TypeScript must decode them to. `src/net/wire-rust.test.ts` checks the
//! other side. `TC_BLESS=1 cargo test -p tc-wire --test net` rewrites it
//! (then `pnpm biome format --write src/net/testdata/wire-rust.json`).

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use common::*;
use serde_json::{Value, json};
use tc_wire::schema::generic_name;
use tc_wire::{
    Bytes, Field, Fixed, QueryDef, Schema, SchemaBuilder, TypeKind, TypeRef, VariantFields,
    WIRE_HEADER, Wire,
};

fn testdata(file: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/net/testdata")
        .join(file)
}

#[test]
fn typescript_schema_vectors_match() {
    let cases = read_ordered(testdata("schema.json"));
    for case in cases.items() {
        let s = schema_from_desc(WIRE_HEADER, &case["desc"]);
        assert_eq!(s.canonical_text(), case["text"].value().as_str().unwrap());
        assert_eq!(s.hash(), case["hash"].value().as_str().unwrap());
    }
    // schema.test.ts's first schema under Forge's header.
    let first = &cases.items()[0]["desc"];
    assert_eq!(
        schema_from_desc(FORGE_HEADER, first).hash(),
        "f5fdfd2f9a7219a0"
    );
}

#[test]
fn typescript_hash_and_fixed_vectors_match() {
    for case in read_json(testdata("hash.json")).as_array().unwrap() {
        let bytes = unhex(case["bytes"].as_str().unwrap());
        let hash = tc_wire::diff::hash_hex(tc_wire::diff::result_hash(&bytes));
        assert_eq!(hash, case["hash"].as_str().unwrap());
    }
    check_fixed(&read_json(testdata("fixed.json")));
}

/// An item's id.
#[derive(Wire, Debug, Clone, PartialEq)]
struct ItemId(u32);

/// A page of anything.
#[derive(Wire, Debug, Clone, PartialEq)]
struct Page<T> {
    items: Vec<T>,
    /// Where the next page starts, if there is one.
    next: Option<u64>,
}

#[derive(Wire, Debug, Clone, PartialEq)]
struct Pair<A, B> {
    left: A,
    right: B,
}

#[derive(Wire, Debug, Clone, PartialEq)]
struct Slot {
    item: ItemId,
    count: u16,
    worn: bool,
}

#[derive(Wire, Debug, Clone, PartialEq)]
enum Shape {
    Empty,
    Circle { radius: Fixed },
    Tagged(String),
}

#[derive(Wire, Debug, Clone, PartialEq)]
enum Either<L, R> {
    Left(L),
    Right { value: R },
}

/// A message.
#[derive(Wire, Debug, Clone, PartialEq)]
enum Msg {
    Hello {
        player_name: String,
        schema_hash: String,
    },
    Slots(Page<Slot>),
    Names(Page<String>),
    Pairs(Vec<Pair<u8, Option<String>>>),
    Shapes(BTreeMap<i32, Shape>),
    Choice(Either<ItemId, Vec<Bytes>>),
    Raw {
        data: Bytes,
        at: i64,
        delta: i32,
        big: u64,
    },
    Bye,
}

fn schema() -> Schema {
    let mut b = SchemaBuilder::new();
    b.root::<Msg>();
    let result = b.describe::<Page<Slot>>();
    b.query(QueryDef {
        name: "slots_from",
        doc: "A page of slots.",
        player: true,
        args: vec![Field::new("start", "", TypeRef::U32)],
        result,
    });
    b.finish().unwrap()
}

fn messages() -> Vec<(&'static str, Msg)> {
    let slot = |item, count, worn| Slot {
        item: ItemId(item),
        count,
        worn,
    };
    vec![
        (
            "hello",
            Msg::Hello {
                player_name: "Ada ✓ é".into(),
                schema_hash: "0123456789abcdef".into(),
            },
        ),
        (
            "hello_empty",
            Msg::Hello {
                player_name: String::new(),
                schema_hash: String::new(),
            },
        ),
        (
            "slots",
            Msg::Slots(Page {
                items: vec![slot(1, 0, false), slot(u32::MAX, u16::MAX, true)],
                next: Some(MAX_SAFE),
            }),
        ),
        (
            "slots_empty",
            Msg::Slots(Page {
                items: vec![],
                next: None,
            }),
        ),
        (
            "names",
            Msg::Names(Page {
                items: vec!["a".into(), "\"q\"\n".into()],
                next: Some(0),
            }),
        ),
        (
            "pairs",
            Msg::Pairs(vec![
                Pair {
                    left: 0,
                    right: None,
                },
                Pair {
                    left: 255,
                    right: Some("x".into()),
                },
            ]),
        ),
        (
            "shapes",
            Msg::Shapes(BTreeMap::from([
                (i32::MIN, Shape::Empty),
                (
                    -1,
                    Shape::Circle {
                        radius: Fixed::from_bits(-(1 << 31)),
                    },
                ),
                (0, Shape::Tagged("t".into())),
                (
                    i32::MAX,
                    Shape::Circle {
                        radius: Fixed::from_bits(i64::MAX),
                    },
                ),
            ])),
        ),
        ("choice_left", Msg::Choice(Either::Left(ItemId(300)))),
        (
            "choice_right",
            Msg::Choice(Either::Right {
                value: vec![Bytes(vec![]), Bytes(vec![0, 0x80, 0xff])],
            }),
        ),
        (
            "raw",
            Msg::Raw {
                data: Bytes((0..=255).collect()),
                at: -(MAX_SAFE as i64),
                delta: i32::MIN,
                big: MAX_SAFE,
            },
        ),
        ("bye", Msg::Bye),
    ]
}

/// A type reference as `TypesDesc` writes it: named types by bare name.
fn spec(ty: &TypeRef) -> Value {
    match ty {
        TypeRef::Vec(inner) => json!({ "vec": spec(inner) }),
        TypeRef::Option(inner) => json!({ "option": spec(inner) }),
        TypeRef::Map(k, v) => json!({ "map": [spec(k), spec(v)] }),
        TypeRef::Named(name) => json!(name),
        scalar => json!(scalar.to_string()),
    }
}

/// The schema as TypeScript's `TypesDesc`, its fields and variants in
/// order.
fn desc(s: &Schema) -> Json {
    let obj = |entries: Vec<(&str, Json)>| {
        Json::Object(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    };
    let spec = |ty: &TypeRef| Json::from(spec(ty));
    let fields = |fields: &[Field]| {
        Json::Object(
            fields
                .iter()
                .map(|f| (f.name.to_string(), spec(&f.ty)))
                .collect(),
        )
    };
    let types = s
        .types()
        .iter()
        .map(|def| {
            let shape = match &def.kind {
                TypeKind::Struct(f) => obj(vec![("struct", fields(f))]),
                TypeKind::Newtype(inner) => obj(vec![("newtype", spec(inner))]),
                TypeKind::Enum(variants) => {
                    let vs = variants
                        .iter()
                        .map(|v| {
                            let fields = match &v.fields {
                                VariantFields::Unit => Json::Scalar(Value::Null),
                                VariantFields::Newtype(inner) => Json::Array(vec![spec(inner)]),
                                VariantFields::Named(f) => fields(f),
                            };
                            (v.name.to_string(), fields)
                        })
                        .collect();
                    obj(vec![("enum", Json::Object(vs))])
                }
            };
            (def.name.to_string(), shape)
        })
        .collect();
    let queries = s
        .queries()
        .iter()
        .map(|q| {
            let query = obj(vec![("args", fields(&q.args)), ("result", spec(&q.result))]);
            (q.name.to_string(), query)
        })
        .collect();
    obj(vec![
        ("roots", Json::from(json!(s.roots()))),
        ("types", Json::Object(types)),
        ("queries", Json::Object(queries)),
    ])
}

fn vectors() -> Json {
    let s = schema();
    let ty = TypeRef::Named("Msg");
    let cases: Vec<Json> = messages()
        .into_iter()
        .map(|(name, msg)| {
            let bytes = msg.to_bytes();
            assert_eq!(Msg::from_bytes(&bytes).unwrap(), msg, "{name}");
            let value = decode_all(&s, &ty, &bytes).unwrap();
            assert_eq!(encode_all(&s, &ty, &value), bytes, "{name}");
            Json::Object(vec![
                ("name".into(), Json::from(json!(name))),
                ("ty".into(), Json::from(json!("Msg"))),
                ("hex".into(), Json::from(json!(hex(&bytes)))),
                ("value".into(), Json::from(value)),
            ])
        })
        .collect();
    Json::Object(vec![
        (
            "_note".into(),
            Json::from(json!(
                "Written by crates/tc-wire/tests/net.rs (TC_BLESS=1 cargo test -p tc-wire --test net); checked by wire-rust.test.ts."
            )),
        ),
        ("desc".into(), desc(&s)),
        ("text".into(), Json::from(json!(s.canonical_text()))),
        ("hash".into(), Json::from(json!(s.hash()))),
        ("cases".into(), Json::Array(cases)),
    ])
}

#[test]
fn generic_types_are_named_by_their_arguments() {
    let s = schema();
    let names: Vec<&str> = s.types().iter().map(|t| t.name).collect();
    assert_eq!(
        names,
        [
            "Msg",
            "PageSlot",
            "Slot",
            "ItemId",
            "PageString",
            "PairU8OptionString",
            "Shape",
            "EitherItemIdVecBytes"
        ]
    );
    assert_eq!(
        generic_name(
            "Pair",
            &[TypeRef::Map(
                Box::new(TypeRef::U8),
                Box::new(TypeRef::Fixed)
            )]
        ),
        "PairMapU8Fixed"
    );
    assert!(std::ptr::eq(
        generic_name("A", &[TypeRef::Bool]),
        generic_name("A", &[TypeRef::Bool])
    ));
    let err = Msg::from_bytes(&[2, 1]).map(|_| ()).unwrap_err();
    assert_eq!(
        err.to_string(),
        "at byte 1: length 1 exceeds the 0 bytes left"
    );
    let err = Either::<u8, u8>::from_bytes(&[7]).unwrap_err();
    assert!(err.to_string().contains("EitherU8U8"), "{err}");
}

#[test]
fn rust_vectors_for_typescript() {
    let path = testdata("wire-rust.json");
    let ours = vectors();
    if std::env::var_os("TC_BLESS").is_some() {
        std::fs::write(&path, ours.pretty() + "\n").unwrap();
        return;
    }
    let committed = read_ordered(path);
    // The values as values; the desc in order (its fields and variants are).
    assert!(
        committed.value() == ours.value() && committed["desc"] == ours["desc"],
        "src/net/testdata/wire-rust.json is stale: TC_BLESS=1 cargo test -p tc-wire --test net"
    );
}
