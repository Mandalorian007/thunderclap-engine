//! tc-tsgen, configured as Forge Wilds (`tests/forge/config.json`), over
//! Forge's schema (`../tc-wire/tests/forge/schema.json`) writes Forge's
//! committed generated TypeScript byte for byte: its protocol module and
//! its SDK's two event files (copies in `tests/forge/`).
//!
//! Forge's `wire.ts`, `patch.ts` and `index.ts` were hand-written runtime
//! files its generator copied out; they are not generated, so not here.

#[path = "../../tc-wire/tests/common/mod.rs"]
mod common;

use std::path::PathBuf;

use common::*;
use serde_json::Value;
use tc_tsgen::{Config, Constant, Pass, Payload, SdkConfig, generate};

fn text(v: &Value) -> String {
    v.as_str().expect("string").to_string()
}

fn forge_config() -> Config {
    let c = read_json(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/forge/config.json"));
    let sdk = &c["sdk"];
    let pairs = |v: &Value| -> Vec<(String, Value)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| (text(&p[0]), p[1].clone()))
            .collect()
    };
    Config {
        header: text(&c["header"]),
        generated_path: text(&c["generatedPath"]),
        wire_import: text(&c["wireImport"]),
        patch_import: text(&c["patchImport"]),
        hash_doc: text(&c["hashDoc"]),
        constants: c["constants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| Constant {
                name: text(&k["name"]),
                doc: text(&k["doc"]),
                value: text(&k["value"]),
            })
            .collect(),
        reserved: Vec::new(),
        sdk: Some(SdkConfig {
            root: text(&sdk["root"]),
            events_path: text(&sdk["eventsPath"]),
            pass_path: text(&sdk["passPath"]),
            protocol_import: text(&sdk["protocolImport"]),
            pass_protocol_import: sdk["passProtocolImport"].as_str().map(String::from),
            events_import: text(&sdk["eventsImport"]),
            helpers_import: text(&sdk["helpersImport"]),
            events_preamble: text(&sdk["eventsPreamble"]),
            pass_preamble: text(&sdk["passPreamble"]),
            keep_doc: text(&sdk["keepDoc"]),
            lists_source: text(&sdk["listsSource"]),
            missing_hint: text(&sdk["missingHint"]),
            pass: sdk["pass"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| Pass {
                    msg: text(&p["msg"]),
                    event: text(&p["event"]),
                    param: text(&p["param"]),
                    payload: match &p["whole"] {
                        Value::Null => Payload::Field,
                        name => Payload::Whole(text(name)),
                    },
                    doc: text(&p["doc"]),
                })
                .collect(),
            hand: pairs(&sdk["hand"])
                .into_iter()
                .map(|(m, events)| (m, events.as_array().unwrap().iter().map(text).collect()))
                .collect(),
            no_event: pairs(&sdk["noEvent"])
                .into_iter()
                .map(|(m, why)| (m, text(&why)))
                .collect(),
        }),
        types_preamble: "\n".into(),
    }
}

#[test]
fn reproduces_forges_generated_typescript() {
    let schema = forge_schema(FORGE_HEADER);
    let files = generate(&schema, &forge_config()).unwrap();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/forge");
    let expected = [
        ("packages/protocol/src/generated.ts", "generated.ts"),
        (
            "packages/sdk/src/events.generated.ts",
            "events.generated.ts",
        ),
        (
            "packages/sdk/src/connection/pass.generated.ts",
            "pass.generated.ts",
        ),
    ];
    assert_eq!(files.len(), expected.len());
    for ((path, contents), (want_path, fixture)) in files.iter().zip(expected) {
        assert_eq!(path, want_path);
        let want = read(fixtures.join(fixture));
        if *contents != want {
            let line = contents
                .lines()
                .zip(want.lines())
                .position(|(a, b)| a != b)
                .unwrap_or(contents.lines().count().min(want.lines().count()));
            panic!(
                "{path} differs from Forge's at line {}:\n ours: {:?}\nforge: {:?}",
                line + 1,
                contents.lines().nth(line),
                want.lines().nth(line)
            );
        }
    }
}

#[test]
fn a_forge_message_with_no_event_fails() {
    let schema = forge_schema(FORGE_HEADER);
    let mut config = forge_config();
    let sdk = config.sdk.as_mut().unwrap();
    sdk.no_event.retain(|(m, _)| m != "Pong");
    let err = generate(&schema, &config).unwrap_err();
    assert!(err.contains("ServerMsg::Pong has no SDK event"), "{err}");
}

/// The types alone, as Forge's SDK has them since its codec became the
/// engine's (`packages/sdk/src/net/wire.generated.ts`, forgewilds #815): the
/// same types as the full module, then `QUERIES` and `Api`, and no codecs.
#[test]
fn types_only_as_forges_sdk_has_them() {
    let schema = forge_schema(FORGE_HEADER);
    let net = "@thunderclap-engine/engine/net";
    let config = Config {
        wire_import: net.into(),
        patch_import: net.into(),
        types_preamble: "//\n// The wire's types.\n\n".into(),
        ..forge_config()
    };
    let ts = tc_tsgen::types_ts(&schema, &config).unwrap();
    assert!(ts.starts_with(&format!(
        "{}//\n// The wire's types.\n\nimport type {{ Fixed, QueryApi }} from \"{net}\";\n\n/** The least time",
        config.header
    )));
    let full = tc_tsgen::generated_ts(&schema, &forge_config()).unwrap();
    let section = |s: &str, from: &str, to: &str| {
        let a = s.find(from).unwrap();
        s[a..a + s[a..].find(to).unwrap()].to_string()
    };
    assert_eq!(
        section(&ts, "// Types\n", "\n// Live queries\n"),
        section(&full, "// Types\n", "\n// Message codecs\n")
    );
    for line in [
        "export const QUERIES = {\n  block: [\"block\", false],\n  inventory: [\"inventory\", true],\n",
        "export interface Api {\n",
        "  readonly inventory: QueryApi<InventoryArgs, Map<number, SlotView>>;\n",
    ] {
        assert!(ts.contains(line), "{line}");
    }
    assert!(!ts.contains("export function") && !ts.contains("export const SCHEMA_HASH"));
    let files = tc_tsgen::generate_types(&schema, &config).unwrap();
    assert_eq!(files[0], (config.generated_path.clone(), ts));
    assert_eq!(files.len(), 3);
}
