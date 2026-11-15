//! The generated TypeScript for a game with an envelope of its own, every
//! option used: `Hello`'s game fields among the envelope's, `Rejected`
//! without `stale_schema`, acks by whole messages, quoted client texts, the
//! game's messages in slots of their own and a close enum.
//!
//! Writes nothing unless blessed: `src/net/testdata/own-envelope.gen.ts`
//! is `define_schema_ts_with`'s output, and `own-envelope.json` holds
//! frames the Rust codecs encoded. `src/net/own-envelope.test.ts` checks
//! the TypeScript schema hashes the same and round-trips each frame.
//! `TC_BLESS=1 cargo test -p thunderclap-server --test ts_envelope`
//! rewrites both.

use std::path::PathBuf;

use serde_json::json;
use thunderclap_server::define_schema_ts_with;
use thunderclap_server::net::envelope::{
    AckMode, ClientSlot, ClientText, CloseCodes, Envelope, HelloField, Protocol, RejectedField,
    ServerSlot, WelcomeField,
};
use thunderclap_server::net::{ClientMsg, Empty, ServerMsg, schema_builder};
use thunderclap_server::wire::{Bytes, Fixed, Wire};

#[derive(Debug, Clone, PartialEq)]
struct Own;

/// What a player says on joining.
#[derive(Wire, Debug, Clone, PartialEq)]
struct Joining {
    watch: bool,
    region: String,
    seed: u64,
}

/// The game's own client messages.
#[derive(Wire, Debug, Clone, PartialEq)]
enum Ask {
    Look { at: Fixed },
    Leave,
}

/// The game's own server messages.
#[derive(Wire, Debug, Clone, PartialEq)]
enum News {
    Chunk { stamp: u64, data: Bytes },
    Note(String),
}

/// Why the server closed.
#[derive(Wire, Debug, Clone, PartialEq)]
enum Bye {
    Restart,
    Kicked,
}

impl Protocol for Own {
    type Hello = Joining;
    type Welcome = String;
    type Command = u32;
    type Result = String;
    type Interest = Empty;
    type Input = Empty;
    type State = Empty;
    type Client = Ask;
    type Server = News;
    const ENVELOPE: &'static Envelope = &Envelope {
        client: &[
            ClientSlot::Hello,
            ClientSlot::Command,
            ClientSlot::Inline,
            ClientSlot::Ping,
            ClientSlot::Inline,
            ClientSlot::Ack,
        ],
        server: &[
            ServerSlot::Welcome,
            ServerSlot::Rejected,
            ServerSlot::CommandResult,
            ServerSlot::Inline,
            ServerSlot::Pong,
            ServerSlot::Closed,
            ServerSlot::Inline,
            ServerSlot::Bulk,
        ],
        hello: &[
            HelloField::Token,
            HelloField::ExtFields(1),
            HelloField::SchemaHash,
            HelloField::Bulk,
            HelloField::ExtFields(2),
        ],
        welcome: &[
            WelcomeField::Player,
            WelcomeField::Time,
            WelcomeField::Paused,
            WelcomeField::Ext,
        ],
        rejected: &[RejectedField::Reason],
        ack: AckMode::Messages,
        client_text: ClientText::QUOTED,
        close: Some(CloseCodes {
            describe: <Bye as Wire>::describe,
            codes: &[1012, 4003],
        }),
    };
}

fn testdata(file: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/net/testdata")
        .join(file)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Frames for TypeScript to decode and encode back, by root.
fn frames() -> serde_json::Value {
    let client: Vec<ClientMsg<Own>> = vec![
        ClientMsg::Hello {
            token: "ada".into(),
            schema_hash: "0123456789abcdef".into(),
            bulk: Some(1),
            ext: Joining {
                watch: true,
                region: "north".into(),
                seed: (1 << 53) - 1,
            },
        },
        ClientMsg::Command {
            seq: 7,
            command: 300,
        },
        ClientMsg::Game(Ask::Look {
            at: Fixed::from_bits(-(3 << 32) - 1),
        }),
        ClientMsg::Ping { client_time: 42 },
        ClientMsg::Game(Ask::Leave),
        ClientMsg::Ack { bytes: 3 },
    ];
    let server: Vec<ServerMsg<Own>> = vec![
        ServerMsg::Welcome {
            player: 9,
            time: 1_700_000_000_000,
            paused: false,
            step_us: 0,
            ext: "hi".into(),
        },
        ServerMsg::Rejected {
            reason: "no".into(),
            stale_schema: false,
        },
        ServerMsg::CommandResult {
            seq: 7,
            result: "ok".into(),
        },
        ServerMsg::Game(News::Chunk {
            stamp: u64::from(u32::MAX) * 1000,
            data: Bytes(vec![1, 2, 3, 255]),
        }),
        ServerMsg::Pong {
            client_time: 42,
            time: 43,
            paused: true,
        },
        ServerMsg::Closed {
            code: 4003,
            reason: "bye".into(),
        },
        ServerMsg::Game(News::Note("note".into())),
        ServerMsg::Bulk {
            codec: 1,
            data: Bytes(vec![9; 4]),
        },
    ];
    json!({
        "_note": "Written by crates/thunderclap-server/tests/ts_envelope.rs (TC_BLESS=1); checked by own-envelope.test.ts.",
        "ClientMsg": client.iter().map(|m| hex(&m.to_bytes())).collect::<Vec<_>>(),
        "ServerMsg": server.iter().map(|m| hex(&m.to_bytes())).collect::<Vec<_>>(),
    })
}

#[test]
fn an_envelope_of_its_own_generates_its_typescript() {
    let schema = schema_builder::<Own>().finish().unwrap();
    let ts = define_schema_ts_with(&schema, "../envelope", Own::ENVELOPE).unwrap();
    for line in [
        "    Hello: { struct: { watch: 'bool', region: 'String', seed: 'u64' } },\n",
        "    hello: 'Hello',\n",
        "    hello: ['token', { ext: 1 }, 'schema_hash', 'bulk', { ext: 2 }],\n",
        "    rejected: ['reason'],\n",
        "    ack: 'messages',\n",
    ] {
        assert!(ts.contains(line), "{line}in\n{ts}");
    }
    let vectors = serde_json::to_string_pretty(&frames()).unwrap() + "\n";
    let (gen_ts, json) = (
        testdata("own-envelope.gen.ts"),
        testdata("own-envelope.json"),
    );
    if std::env::var_os("TC_BLESS").is_some() {
        std::fs::write(&gen_ts, &ts).unwrap();
        std::fs::write(&json, &vectors).unwrap();
        return;
    }
    let stale = "stale: TC_BLESS=1 cargo test -p thunderclap-server --test ts_envelope";
    assert_eq!(std::fs::read_to_string(gen_ts).expect(stale), ts, "{stale}");
    assert_eq!(
        std::fs::read_to_string(json).expect(stale),
        vectors,
        "{stale}"
    );
}

#[test]
fn a_schema_off_its_envelope_is_named() {
    // The engine envelope's schema, read as this game's: every slot that
    // differs is named, not a hash that silently differs.
    #[derive(Debug, Clone, PartialEq)]
    struct Engine;
    impl Protocol for Engine {
        type Hello = Joining;
        type Welcome = String;
        type Command = u32;
        type Result = String;
        type Interest = Empty;
        type Input = Empty;
        type State = Empty;
        type Client = Empty;
        type Server = String;
        const ENVELOPE: &'static Envelope = &Envelope::ENGINE;
    }
    let schema = schema_builder::<Engine>().finish().unwrap();
    let err = define_schema_ts_with(&schema, "../envelope", Own::ENVELOPE).unwrap_err();
    assert!(
        err.contains("ClientMsg has 11 variants, the envelope 6 slots"),
        "{err}"
    );
    assert!(
        err.contains("ClientMsg::Hello has fields [token, schema_hash, bulk, ext]"),
        "{err}"
    );
}
