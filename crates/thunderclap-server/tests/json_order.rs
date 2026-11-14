//! The engine turns on no `serde_json` feature that would reach a game's
//! crates: `preserve_order` unifies across a build, and a game's own
//! `serde_json::Map` would change order with it. This test links every
//! engine crate, so it sees the features they turn on together.

#![allow(missing_docs)]

use serde_json::{Map, Value};

#[test]
fn a_dependents_maps_keep_serde_jsons_own_order() {
    let mut map = Map::new();
    map.insert("b".into(), Value::from(1));
    map.insert("a".into(), Value::from(2));
    // Sorted by key: serde_json's default. With `preserve_order` on
    // anywhere in the build, it would come out "b" first.
    assert_eq!(Value::Object(map).to_string(), r#"{"a":2,"b":1}"#);
}

#[test]
fn the_admin_lines_keep_their_order_without_it() {
    let line = tc_admin::Reply::Revoked {
        name: "ada".into(),
        generation: 3,
    }
    .encode();
    assert_eq!(
        line,
        r#"{"admin":1,"reply":{"type":"revoked","name":"ada","generation":3}}"#
    );
}
