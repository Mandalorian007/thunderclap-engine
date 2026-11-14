//! Forge Wilds' protocol vectors, decoded and encoded by tc-wire.
//!
//! Forge Wilds is the first game on these crates. Its wire vectors
//! (`tests/forge/*.json`, copied from its `testdata/protocol`) were written
//! by its own typed codecs; here a schema-driven codec over its dumped
//! schema (`tests/forge/schema.json`, `forge_server::schema()`) must read
//! and write every one byte for byte, with the same errors, and tc-wire's
//! diff, hash, `Fixed` and stamps must give its numbers.
//!
//! Not ported: `entities.json`, `sections.json`, `climate.json` and
//! `log-variants.json`, Forge's own entity, voxel-section, climate and
//! save-log codecs (game code, not the wire format), and `fixed.json`'s
//! `linear` cases (Forge's `LinearAmount`).

mod common;

use common::*;
use serde_json::Value;
use tc_wire::diff::{self, PatchOp};
use tc_wire::{Schema, TypeKind, TypeRef, VariantFields, Wire, stamp};

fn schema() -> Schema {
    forge_schema(FORGE_HEADER)
}

fn root(schema: &Schema, root: &str) -> TypeRef {
    match root.strip_prefix("query:") {
        Some(q) => schema.query(q).expect("query").result.clone(),
        None => TypeRef::Named(schema.get(root).expect("root").name),
    }
}

fn vectors(file: &str) -> Vec<Value> {
    match read_json(forge_dir().join(file)) {
        Value::Array(cases) => cases,
        other => other["cases"].as_array().expect("cases").clone(),
    }
}

#[test]
fn the_schema_hashes_as_forge_does() {
    let s = schema();
    assert_eq!(s.hash(), forge_hash());
    assert!(
        s.canonical_text()
            .starts_with("forge-wire 2\nroot ClientMsg\nroot ServerMsg\n")
    );
    assert!(s.types().len() > 200 && s.queries().len() > 30);
}

#[test]
fn golden_messages_decode_and_encode_byte_for_byte() {
    let s = schema();
    let cases = vectors("golden.json");
    assert!(cases.len() > 300, "{}", cases.len());
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let ty = root(&s, case["root"].as_str().unwrap());
        let hex_text = case["hex"].as_str().unwrap();
        let value = decode_all(&s, &ty, &unhex(hex_text)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(value, case["value"], "{name}: decoded");
        assert_eq!(
            hex(&encode_all(&s, &ty, &case["value"])),
            hex_text,
            "{name}: encoded"
        );
    }
}

#[test]
fn invalid_messages_fail_with_the_same_errors() {
    let s = schema();
    let cases = vectors("invalid.json");
    assert!(cases.len() > 10);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let ty = root(&s, case["root"].as_str().unwrap());
        let err = decode_all(&s, &ty, &unhex(case["hex"].as_str().unwrap()))
            .expect_err(name)
            .to_string();
        assert_eq!(err, case["rustError"].as_str().unwrap(), "{name}");
    }
}

#[test]
fn patches_match_and_apply() {
    let s = schema();
    let TypeKind::Enum(msgs) = &s.get("ServerMsg").unwrap().kind else {
        panic!("ServerMsg is an enum")
    };
    let VariantFields::Named(update_fields) =
        &msgs.iter().find(|v| v.name == "Update").unwrap().fields
    else {
        panic!("Update has fields")
    };
    let patch_ty = &update_fields.iter().find(|f| f.name == "patch").unwrap().ty;
    let server_msg = TypeRef::Named("ServerMsg");
    let cases = vectors("patch.json");
    assert!(cases.len() > 20);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let ty = type_ref(&case["type"], false);
        let old = unhex(case["old"].as_str().unwrap());
        let new = unhex(case["new"].as_str().unwrap());
        let ops = diff::diff(&s, &ty, &old, &new).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(diff::apply(&s, &ty, &old, &ops).unwrap(), new, "{name}");

        let update = decode_all(&s, &server_msg, &unhex(case["update"].as_str().unwrap())).unwrap();
        assert_eq!(update["type"], "Update", "{name}");
        assert_eq!(
            update["hash"],
            diff::hash_hex(diff::result_hash(&new)),
            "{name}"
        );
        let ours = decode_all(&s, patch_ty, &ops.to_bytes()).unwrap();
        assert_eq!(ours, update["patch"], "{name}: the same patch");
        let theirs =
            Vec::<PatchOp>::from_bytes(&encode_all(&s, patch_ty, &update["patch"])).unwrap();
        assert_eq!(
            diff::apply(&s, &ty, &old, &theirs).unwrap(),
            new,
            "{name}: theirs applies"
        );
    }
}

#[test]
fn result_hashes_match() {
    let cases = vectors("hash.json");
    for case in &cases {
        let bytes = unhex(case["bytes"].as_str().unwrap());
        assert_eq!(
            diff::hash_hex(diff::result_hash(&bytes)),
            case["hash"].as_str().unwrap()
        );
    }
}

#[test]
fn fixed_displays_floors_and_parses() {
    let d = read_json(forge_dir().join("fixed.json"));
    check_fixed(&d);
}

#[test]
fn stamps_match() {
    let stamp_of = |v: &Value| u64::from_str_radix(v.as_str().unwrap(), 16).unwrap();
    let bytes = |v: &Value| unhex(v.as_str().unwrap());
    let cases = vectors("stamps.json");
    let mut kinds = std::collections::BTreeSet::new();
    for case in &cases {
        let kind = case["kind"].as_str().unwrap();
        kinds.insert(kind);
        let got = match kind {
            "section" | "timelines" => stamp::bytes_stamp(&bytes(&case["bytes"])),
            // A section's piles: sorted by index, item and owner, each
            // index (2 bytes), item (4), count (4), owner (8), little-endian.
            "piles" => {
                let mut piles: Vec<(u16, u32, u32, u64)> = case["piles"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| {
                        let n = |i: usize| p[i].as_u64().unwrap();
                        (n(0) as u16, n(1) as u32, n(2) as u32, n(3))
                    })
                    .collect();
                piles.sort_by_key(|&(index, item, _, owner)| (index, item, owner));
                let mut packed = Vec::new();
                for (index, item, count, owner) in piles {
                    packed.extend_from_slice(&index.to_le_bytes());
                    packed.extend_from_slice(&item.to_le_bytes());
                    packed.extend_from_slice(&count.to_le_bytes());
                    packed.extend_from_slice(&owner.to_le_bytes());
                }
                stamp::bytes_stamp(&packed)
            }
            "climate" => {
                let (t, m) = (bytes(&case["temperature"]), bytes(&case["moisture"]));
                stamp::parts_stamp([t.as_slice(), m.as_slice()])
            }
            "digest" => stamp::pairs_digest(case["pairs"].as_array().unwrap().iter().map(|p| {
                (
                    i32::try_from(p[0].as_i64().unwrap()).unwrap(),
                    stamp_of(&p[1]),
                )
            })),
            other => panic!("unknown kind {other}"),
        };
        assert_eq!(
            format!("{got:016x}"),
            case["stamp"].as_str().unwrap(),
            "{kind}"
        );
    }
    assert_eq!(kinds.len(), 5);
}

#[test]
fn every_enum_keeps_its_tags() {
    let s = schema();
    let d = read_json(forge_dir().join("variants.json"));
    let mut checked = 0;
    for (name, tags) in d["enums"].as_object().unwrap() {
        // A few enums there are Forge's save format's, not the protocol's.
        let Some(def) = s.get(name) else { continue };
        let TypeKind::Enum(variants) = &def.kind else {
            panic!("{name} is an enum")
        };
        for t in tags.as_array().unwrap() {
            if t.get("reserved").is_some() {
                continue;
            }
            let tag = usize::try_from(t["tag"].as_u64().unwrap()).unwrap();
            assert_eq!(variants[tag].name, t["name"].as_str().unwrap(), "{name}");
            checked += 1;
        }
    }
    assert!(checked > 300, "{checked}");
}
