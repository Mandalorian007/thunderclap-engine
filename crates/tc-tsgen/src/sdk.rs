//! A client SDK's generated events: one root message enum's variants,
//! each passed through to listeners whole, handled by hand, or skipped.
//!
//! Every variant of [`SdkConfig::root`] is in exactly one of three lists:
//! - [`SdkConfig::pass`]: a pass-through event, generated whole: the message
//!   reaches the listener as it came (its fields as one object, or its one
//!   field);
//! - [`SdkConfig::hand`]: handled by hand, with the events it raises;
//! - [`SdkConfig::no_event`]: the skip list, messages with no event of
//!   their own, each with why.
//!
//! Generating fails on a message in none of them: that is the check that a
//! new message gets an event. From the pass list it writes two files:
//! - [`SdkConfig::events_path`]: each event's payload type (with the
//!   message's docs) and `PassEvents`, its listener by event name;
//! - [`SdkConfig::pass_path`]: their listener sets and `passThrough`, the
//!   dispatch. What a message also changes in the connection's state stays
//!   hand-written (`PassKeep`).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use tc_wire::{Field, Schema, TypeKind, TypeRef, VariantFields};

use super::{Config, doc_comment, rust_type_note, ts_field_name, ts_type};

/// The SDK's event lists and where its files go.
#[derive(Debug, Clone, Default)]
pub struct SdkConfig {
    /// The message enum the events come from (a schema root).
    pub root: String,
    /// The events file, relative to the output root.
    pub events_path: String,
    /// The dispatch file, relative to the output root.
    pub pass_path: String,
    /// The module the protocol's generated types are imported from.
    pub protocol_import: String,
    /// The events file as the dispatch file imports it.
    pub events_import: String,
    /// The module exporting `Listeners`, as the dispatch file imports it.
    pub helpers_import: String,
    /// Comment lines after the header of the events file.
    pub events_preamble: String,
    /// Comment lines after the header of the dispatch file.
    pub pass_preamble: String,
    /// The doc of `PassKeep`, the hand-written changes a message makes
    /// before its listeners hear it.
    pub keep_doc: String,
    /// Where the lists live, named in errors.
    pub lists_source: String,
    /// What a missing message's error suggests, after the lists' names.
    pub missing_hint: String,
    /// The pass-through events, in the order they are written.
    pub pass: Vec<Pass>,
    /// The messages handled by hand, and the events each raises.
    pub hand: Vec<(String, Vec<String>)>,
    /// The skip list: messages with no event of their own, and why.
    pub no_event: Vec<(String, String)>,
}

/// A message the SDK passes through as one event.
#[derive(Debug, Clone)]
pub struct Pass {
    /// The root enum's variant.
    pub msg: String,
    /// The event's name.
    pub event: String,
    /// The listener's parameter name.
    pub param: String,
    /// What the event carries.
    pub payload: Payload,
    /// The event's doc.
    pub doc: String,
}

/// What a pass-through event carries.
#[derive(Debug, Clone)]
pub enum Payload {
    /// The message's fields as one object: a generated interface of this
    /// name, documented by the message's docs.
    Whole(String),
    /// The message's only field, as it came.
    Field,
}

/// A pass-through event resolved against the schema.
struct Resolved<'a> {
    pass: &'a Pass,
    fields: &'a [Field],
    /// The payload's TypeScript type.
    payload: String,
}

/// The generated SDK files, as `(path, contents)`; an error if a message is
/// in no list (or two), or a pass-through event doesn't match its message.
pub(super) fn files(
    schema: &Schema,
    config: &Config,
    sdk: &SdkConfig,
) -> Result<Vec<(String, String)>, String> {
    let events = resolve(schema, sdk)?;
    Ok(vec![
        (
            sdk.events_path.clone(),
            events_ts(schema, config, sdk, &events),
        ),
        (sdk.pass_path.clone(), pass_ts(config, sdk, &events)),
    ])
}

fn resolve<'a>(schema: &'a Schema, sdk: &'a SdkConfig) -> Result<Vec<Resolved<'a>>, String> {
    let root = sdk.root.as_str();
    let def = schema
        .get(root)
        .ok_or_else(|| format!("the schema has no `{root}`"))?;
    let TypeKind::Enum(variants) = &def.kind else {
        return Err(format!("`{root}` is not an enum"));
    };
    let names: Vec<&str> = variants.iter().map(|v| v.name).collect();
    classify(sdk, &names)?;
    let mut resolved = Vec::new();
    for pass in &sdk.pass {
        let variant = variants
            .iter()
            .find(|v| v.name == pass.msg)
            .expect("classified");
        let fields: &[Field] = match &variant.fields {
            VariantFields::Named(fields) => fields.as_slice(),
            _ => {
                return Err(format!("{root}::{} has no named fields to pass", pass.msg));
            }
        };
        let payload = match &pass.payload {
            Payload::Whole(name) => {
                if schema.get(name).is_some() {
                    return Err(format!(
                        "the SDK type `{name}` collides with a protocol type"
                    ));
                }
                name.clone()
            }
            Payload::Field => match fields {
                [field] => sdk_type(&field.ty),
                _ => {
                    return Err(format!(
                        "{root}::{} passes its one field, but it has {}",
                        pass.msg,
                        fields.len()
                    ));
                }
            },
        };
        resolved.push(Resolved {
            pass,
            fields,
            payload,
        });
    }
    Ok(resolved)
}

/// Checks that each message is in exactly one list, that the lists name
/// only messages that exist, and that each pass-through event is raised once.
fn classify(sdk: &SdkConfig, messages: &[&str]) -> Result<(), String> {
    let root = &sdk.root;
    let source = &sdk.lists_source;
    let mut listed: BTreeMap<&str, &str> = BTreeMap::new();
    let lists = sdk
        .pass
        .iter()
        .map(|p| (p.msg.as_str(), "PASS"))
        .chain(sdk.hand.iter().map(|(m, _)| (m.as_str(), "HAND")))
        .chain(sdk.no_event.iter().map(|(m, _)| (m.as_str(), "NO_EVENT")));
    for (msg, list) in lists {
        if let Some(other) = listed.insert(msg, list) {
            return Err(format!(
                "{root}::{msg} is in both {other} and {list} ({source})"
            ));
        }
        if !messages.contains(&msg) {
            return Err(format!(
                "{list} names {root}::{msg}, which doesn't exist ({source})"
            ));
        }
    }
    let missing: Vec<&str> = messages
        .iter()
        .copied()
        .filter(|name| !listed.contains_key(name))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "{root}::{} has no SDK event: add it to PASS (an event generated whole), \
             HAND (handled by hand) or NO_EVENT (no event, with why) in {source}{}",
            missing.join(&format!(", {root}::")),
            sdk.missing_hint
        ));
    }
    let mut events = BTreeSet::new();
    for event in sdk.pass.iter().map(|p| p.event.as_str()) {
        if !events.insert(event) || sdk.hand.iter().any(|(_, e)| e.iter().any(|h| h == event)) {
            return Err(format!("the SDK event `{event}` is raised twice"));
        }
    }
    Ok(())
}

/// A payload field's TypeScript type: a protocol type, with a top-level list
/// read-only (a listener must not change what it was given).
fn sdk_type(ty: &TypeRef) -> String {
    match ty {
        TypeRef::Vec(inner) => match **inner {
            TypeRef::Option(_) => format!("readonly ({})[]", ts_type(inner)),
            _ => format!("readonly {}[]", ts_type(inner)),
        },
        other => ts_type(other),
    }
}

/// The protocol's named types `ty` mentions.
fn named_types<'a>(ty: &'a TypeRef, out: &mut BTreeSet<&'a str>) {
    match ty {
        TypeRef::Named(name) => {
            out.insert(name);
        }
        TypeRef::Fixed => {
            out.insert("Fixed");
        }
        TypeRef::Vec(inner) | TypeRef::Option(inner) => named_types(inner, out),
        TypeRef::Map(key, value) => {
            named_types(key, out);
            named_types(value, out);
        }
        _ => {}
    }
}

fn import_line(out: &mut String, names: &BTreeSet<&str>, from: &str) {
    if names.is_empty() {
        return;
    }
    let list: Vec<&str> = names.iter().copied().collect();
    let _ = writeln!(
        out,
        "import type {{ {} }} from \"{from}\";",
        list.join(", ")
    );
}

fn events_ts(schema: &Schema, config: &Config, sdk: &SdkConfig, events: &[Resolved]) -> String {
    let mut out = String::new();
    out.push_str(&config.header);
    out.push_str(&sdk.events_preamble);
    let mut protocol = BTreeSet::new();
    for e in events {
        for field in e.fields {
            named_types(&field.ty, &mut protocol);
        }
    }
    import_line(&mut out, &protocol, &sdk.protocol_import);
    let def = schema.get(&sdk.root).expect("resolved");
    let TypeKind::Enum(variants) = &def.kind else {
        unreachable!("resolved")
    };
    for e in events {
        let Payload::Whole(name) = &e.pass.payload else {
            continue;
        };
        let variant = variants
            .iter()
            .find(|v| v.name == e.pass.msg)
            .expect("resolved");
        out.push('\n');
        doc_comment(&mut out, "", variant.doc);
        let _ = writeln!(out, "export interface {name} {{");
        for field in e.fields {
            doc_comment(&mut out, "  ", field.doc);
            let _ = writeln!(
                out,
                "  {}: {};{}",
                ts_field_name(field.name),
                sdk_type(&field.ty),
                rust_type_note(&field.ty)
            );
        }
        out.push_str("}\n");
    }
    out.push_str(
        "\n/** The pass-through events' listeners, by event name (see `Connection.on`). */\n",
    );
    out.push_str("export interface PassEvents {\n");
    for e in events {
        doc_comment(&mut out, "  ", &e.pass.doc);
        let _ = writeln!(
            out,
            "  {}: ({}: {}) => void;",
            e.pass.event, e.pass.param, e.payload
        );
    }
    out.push_str("}\n");
    out
}

fn pass_ts(config: &Config, sdk: &SdkConfig, events: &[Resolved]) -> String {
    let mut out = String::new();
    out.push_str(&config.header);
    out.push_str(&sdk.pass_preamble);
    let mut protocol = BTreeSet::from([sdk.root.as_str()]);
    let mut own = BTreeSet::from(["PassEvents"]);
    for e in events {
        match &e.pass.payload {
            Payload::Whole(name) => {
                own.insert(name.as_str());
            }
            Payload::Field => named_types(&e.fields[0].ty, &mut protocol),
        }
    }
    import_line(&mut out, &protocol, &sdk.protocol_import);
    import_line(&mut out, &own, &sdk.events_import);
    let _ = writeln!(
        out,
        "import {{ Listeners }} from \"{}\";",
        sdk.helpers_import
    );

    let msgs: Vec<String> = events
        .iter()
        .map(|e| format!("\"{}\"", e.pass.msg))
        .collect();
    out.push_str("\n/** The server messages passed through as events. */\n");
    let _ = writeln!(out, "export type PassMsg = {};", msgs.join(" | "));

    out.push_str("\n/** What each pass-through message's event carries. */\n");
    out.push_str("export interface PassPayloads {\n");
    for e in events {
        let _ = writeln!(out, "  {}: {};", e.pass.msg, e.payload);
    }
    out.push_str("}\n");

    out.push_str(
        "\n/** Each pass-through event's listeners. */\n\
         export type PassListeners = { readonly [K in keyof PassEvents]: Listeners<PassEvents[K]> };\n\
         \n/** A connection's pass-through listeners: none yet. */\n\
         export function passListeners(): PassListeners {\n\
         \x20 return {\n",
    );
    for e in events {
        let _ = writeln!(out, "    {}: new Listeners(),", e.pass.event);
    }
    out.push_str("  };\n}\n");

    let root = &sdk.root;
    let _ = write!(
        out,
        "\n/** {} */\n\
         export type PassKeep<C> = {{ readonly [M in PassMsg]?: (core: C, payload: PassPayloads[M]) => void }};\n\
         \n/**\n\
         \x20* Applies a pass-through message: builds its event, runs its `keep`, and\n\
         \x20* returns the call that tells its listeners (those listening when it runs).\n\
         \x20*/\n\
         export function passThrough<C>(\n\
         \x20 msg: Extract<{root}, {{ type: PassMsg }}>,\n\
         \x20 core: C,\n\
         \x20 keep: PassKeep<C>,\n\
         \x20 listeners: PassListeners,\n\
         ): () => void {{\n\
         \x20 switch (msg.type) {{\n",
        sdk.keep_doc
    );
    for e in events {
        let p = e.pass;
        let param = &p.param;
        let _ = writeln!(out, "    case \"{}\": {{", p.msg);
        match &p.payload {
            Payload::Whole(name) => {
                let fields: Vec<String> = e
                    .fields
                    .iter()
                    .map(|f| {
                        let n = ts_field_name(f.name);
                        format!("{n}: msg.{n}")
                    })
                    .collect();
                let _ = writeln!(
                    out,
                    "      const {param}: {name} = {{ {} }};",
                    fields.join(", ")
                );
            }
            Payload::Field => {
                let _ = writeln!(
                    out,
                    "      const {param} = msg.{};",
                    ts_field_name(e.fields[0].name)
                );
            }
        }
        let _ = writeln!(out, "      keep.{}?.(core, {param});", p.msg);
        let _ = writeln!(out, "      const ls = listeners.{};", p.event);
        out.push_str("      return () => {\n        const list = ls.list;\n");
        let _ = writeln!(
            out,
            "        for (let i = 0; i < list.length; i++) list[i]!({param});"
        );
        out.push_str("      };\n    }\n");
    }
    out.push_str("  }\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(pass: &[&str], hand: &[&str], skip: &[&str]) -> SdkConfig {
        SdkConfig {
            root: "Msg".into(),
            lists_source: "lists.rs".into(),
            pass: pass
                .iter()
                .map(|m| Pass {
                    msg: (*m).into(),
                    event: m.to_lowercase(),
                    param: "e".into(),
                    payload: Payload::Field,
                    doc: String::new(),
                })
                .collect(),
            hand: hand
                .iter()
                .map(|m| ((*m).into(), vec![format!("{}Hand", m.to_lowercase())]))
                .collect(),
            no_event: skip.iter().map(|m| ((*m).into(), "why".into())).collect(),
            ..SdkConfig::default()
        }
    }

    #[test]
    fn a_message_in_no_list_or_a_missing_one_fails() {
        let c = config(&["Moved"], &["Chat"], &["Pong"]);
        classify(&c, &["Moved", "Chat", "Pong"]).unwrap();
        let err = classify(&c, &["Moved", "Chat", "Pong", "Brand"]).unwrap_err();
        assert!(err.contains("Msg::Brand has no SDK event"), "{err}");
        let err = classify(&c, &["Chat", "Pong"]).unwrap_err();
        assert!(
            err.contains("PASS names Msg::Moved, which doesn't exist"),
            "{err}"
        );
        let twice = config(&["Chat"], &["Chat"], &[]);
        let err = classify(&twice, &["Chat"]).unwrap_err();
        assert!(err.contains("in both PASS and HAND"), "{err}");
    }

    #[test]
    fn lists_are_read_only_and_options_parenthesized() {
        let vec = |t| TypeRef::Vec(Box::new(t));
        assert_eq!(sdk_type(&vec(TypeRef::Named("Pos"))), "readonly Pos[]");
        assert_eq!(
            sdk_type(&vec(TypeRef::Option(Box::new(TypeRef::U8)))),
            "readonly (number | null)[]"
        );
        assert_eq!(sdk_type(&TypeRef::Named("Event")), "Event");
    }
}
