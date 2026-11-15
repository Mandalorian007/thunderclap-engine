//! The control channel's lines: a [`Request`] carrying the endpoint's
//! token, and the server's [`Reply`]. Each is one line of JSON naming
//! [`ADMIN_VERSION`].

use serde_json::{Value, json};

/// `value` (anything `json!` takes) as JSON text.
macro_rules! j {
    ($value:expr) => {
        json!($value).to_string()
    };
}

/// The protocol's version, in every request and reply. A new request or
/// field doesn't change it (an older server answers a request it doesn't
/// know with [`Reply::Unknown`]); a changed meaning does. 2: a status's
/// `players` are [`PlayerBrief`]s, not ids.
pub const ADMIN_VERSION: u32 = 2;

/// The longest line either side reads; longer is refused.
pub const MAX_LINE: usize = 16 * 1024;

/// What a caller asks a running server.
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    /// What the server is doing ([`Status`]).
    Status,
    /// Stop cleanly, as on Ctrl-C.
    Stop,
    /// Pause the game's clock.
    Pause,
    /// Run the game's clock again.
    Resume,
    /// Rebuild the game from its data, read again now ([`Reply::Reloaded`]).
    Reload,
    /// Copy the store while it runs ([`Reply::BackedUp`]): into `out`, or
    /// a new directory under the server's backups.
    Backup {
        /// Where to, if not the default.
        out: Option<String>,
    },
    /// Revoke every token a name holds so far: its open sessions close
    /// with 4001 ([`Reply::Revoked`]).
    Revoke {
        /// The name.
        name: String,
    },
    /// The reports the server holds ([`Reply::Reports`]).
    Reports {
        /// Only those that arrived at or after this, in seconds since the
        /// Unix epoch.
        since: Option<u64>,
        /// Only those of this kind (a game's own word).
        kind: Option<String>,
    },
    /// A request of the game's own ([`Reply::Game`]).
    Game {
        /// Its name.
        name: String,
        /// Its arguments, as the game reads them.
        args: Value,
    },
}

/// A running server, as [`Request::Status`] answers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Status {
    /// The server's process id.
    pub pid: u32,
    /// Its build, as the game names it.
    pub build: String,
    /// The port it serves the game on.
    pub port: u16,
    /// When it started, in seconds since the Unix epoch.
    pub started: u64,
    /// How long it has run, in seconds.
    pub uptime_secs: u64,
    /// Players present, in order.
    pub players: Vec<PlayerBrief>,
    /// Open connections.
    pub connections: u64,
    /// The game's version (its last log entry).
    pub version: u64,
    /// The game's time, in steps.
    pub time: u64,
    /// The clock is paused.
    pub paused: bool,
    /// A reload is running.
    pub reloading: bool,
    /// It is shutting down.
    pub stopping: bool,
    /// Why the store stopped taking writes, if it did.
    pub store_error: Option<String>,
    /// Batches the log refused to encode (a game bug).
    pub refused: u64,
    /// Game messages dropped over a rate lane.
    pub limited: u64,
    /// Frames written to clients since it started.
    pub frames_sent: u64,
    /// Their bytes.
    pub bytes_sent: u64,
    /// The game's own status ([`Live::status`](crate::Live::status)):
    /// its world's numbers.
    pub game: Option<Value>,
}

/// A player present, as [`Status::players`] lists it: its id, its name,
/// or both, as the game knows it
/// ([`SimControl::players`](crate::SimControl::players)).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlayerBrief {
    /// Its id in the game (tc-sim's `PlayerId`), if it has one.
    pub id: Option<u64>,
    /// Its name, as a person reads it.
    pub name: Option<String>,
}

impl PlayerBrief {
    /// A player with an id and, if known, a name.
    pub fn id(id: u64, name: Option<String>) -> PlayerBrief {
        PlayerBrief { id: Some(id), name }
    }

    /// A player known by its name alone.
    pub fn named(name: impl Into<String>) -> PlayerBrief {
        PlayerBrief {
            id: None,
            name: Some(name.into()),
        }
    }
}

impl std::fmt::Display for PlayerBrief {
    /// Its name, else `#id`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (&self.name, self.id) {
            (Some(name), _) => f.write_str(name),
            (None, Some(id)) => write!(f, "#{id}"),
            (None, None) => f.write_str("?"),
        }
    }
}

/// One report, as [`Reply::Reports`] lists it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReportBrief {
    /// Its file name in the reports directory.
    pub file: String,
    /// When it arrived, in seconds since the Unix epoch.
    pub received: u64,
    /// Who sent it.
    pub from: String,
    /// Its kind.
    pub kind: String,
    /// The start of its text.
    pub text: String,
}

/// The reports a server holds, as [`Request::Reports`] answers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReportsReply {
    /// The server keeps reports; without, the rest is empty.
    pub kept: bool,
    /// The reports in its directory that match.
    pub count: u64,
    /// The newest of them, newest first.
    pub newest: Vec<ReportBrief>,
    /// Since it started: reports received,
    pub received: u64,
    /// those written,
    pub saved: u64,
    /// those dropped over their sender's rate,
    pub rate_limited: u64,
    /// those dropped otherwise (too big, the queue full, a failed write),
    pub dropped: u64,
    /// and older ones removed to keep the directory in its budget.
    pub pruned: u64,
    /// The game's own numbers about its reports
    /// ([`ReportsSource::extra`](crate::ReportsSource::extra)).
    pub extra: Option<Value>,
}

/// What a running server answers.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    /// The answer to [`Request::Status`].
    Status(Status),
    /// The answer to [`Request::Stop`]; `already` if it was stopping.
    Stopping {
        /// It was already stopping.
        already: bool,
    },
    /// The answer to [`Request::Pause`] and [`Request::Resume`]: the clock
    /// as the request left it.
    Clock {
        /// Paused.
        paused: bool,
        /// The time, in steps, as the loop last published it (up to
        /// [`tc_sim::STATUS_PUBLISH`] behind).
        time: u64,
    },
    /// The answer to [`Request::Reload`].
    Reloaded {
        /// The time it swapped in at.
        time: u64,
        /// The version it swapped in at.
        version: u64,
        /// Rounds taken.
        rounds: u32,
        /// Entries replayed.
        replayed: u64,
    },
    /// The answer to [`Request::Backup`].
    BackedUp {
        /// Where the copy is.
        dir: String,
        /// Log files copied.
        files: u64,
        /// Their bytes.
        bytes: u64,
        /// The last entry the copy holds.
        last_seq: u64,
        /// Older backups removed to keep the newest.
        pruned: u64,
    },
    /// The answer to [`Request::Revoke`].
    Revoked {
        /// The name.
        name: String,
        /// Its generation now: tokens below it are refused.
        generation: u32,
        /// Open sessions on the tokens it ended that closed before the
        /// reply,
        closed: u64,
        /// and those still closing when the server stopped waiting.
        closing: u64,
    },
    /// The answer to [`Request::Reports`].
    Reports(ReportsReply),
    /// The answer to [`Request::Game`].
    Game(Value),
    /// The server knows the request but this game doesn't do it (a loop
    /// with no clock to pause, no data to reload, no store to back up,
    /// no tokens to revoke). Nothing changed.
    Unsupported {
        /// The request's name.
        request: String,
        /// Why not, in the game's words.
        why: String,
    },
    /// The request was refused (a wrong token or version, a garbled line,
    /// the loop stopped, a step that failed), and why.
    Refused(String),
    /// The server doesn't know this request: its name.
    Unknown(String),
}

impl Request {
    /// Its name on the wire.
    pub fn name(&self) -> &str {
        match self {
            Request::Status => "status",
            Request::Stop => "stop",
            Request::Pause => "pause",
            Request::Resume => "resume",
            Request::Reload => "reload",
            Request::Backup { .. } => "backup",
            Request::Revoke { .. } => "revoke",
            Request::Reports { .. } => "reports",
            Request::Game { .. } => "game",
        }
    }

    /// The request's line (without its newline), carrying `token`.
    pub fn encode(&self, token: &str) -> String {
        let mut r = vec![("type", j!(self.name()))];
        match self {
            Request::Backup { out } => r.push(("out", j!(out))),
            Request::Revoke { name } => r.push(("name", j!(name))),
            Request::Reports { since, kind } => {
                r.push(("since", j!(since)));
                r.push(("kind", j!(kind)));
            }
            Request::Game { name, args } => {
                r.push(("name", j!(name)));
                r.push(("args", args.to_string()));
            }
            _ => {}
        }
        obj(&[
            ("admin", j!(ADMIN_VERSION)),
            ("token", j!(token)),
            ("request", obj(&r)),
        ])
    }
}

/// A request line, read: the token it carries and the request, or the
/// name of one this build doesn't know.
#[derive(Debug, PartialEq)]
pub struct Asked {
    /// The token.
    pub token: String,
    /// The request, or the unknown name.
    pub request: Result<Request, String>,
}

/// Reads a request line: `Err` says why it is refused.
pub fn decode_request(line: &str) -> Result<Asked, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("not JSON: {e}"))?;
    check_version(&v)?;
    let token = v
        .get("token")
        .and_then(Value::as_str)
        .ok_or("no token")?
        .to_string();
    let r = v.get("request").ok_or("no request")?;
    let kind = r
        .get("type")
        .and_then(Value::as_str)
        .ok_or("no request type")?;
    let text = |k: &str| r.get(k).and_then(Value::as_str).map(String::from);
    let request = match kind {
        "status" => Ok(Request::Status),
        "stop" => Ok(Request::Stop),
        "pause" => Ok(Request::Pause),
        "resume" => Ok(Request::Resume),
        "reload" => Ok(Request::Reload),
        "backup" => Ok(Request::Backup { out: text("out") }),
        "revoke" => Ok(Request::Revoke {
            name: text("name").ok_or("a revoke names no one")?,
        }),
        "reports" => Ok(Request::Reports {
            since: r.get("since").and_then(Value::as_u64),
            kind: text("kind"),
        }),
        "game" => Ok(Request::Game {
            name: text("name").ok_or("a game request has no name")?,
            args: r.get("args").cloned().unwrap_or(Value::Null),
        }),
        other => Err(other.to_string()),
    };
    Ok(Asked { token, request })
}

impl Reply {
    /// The reply's line (without its newline).
    pub fn encode(&self) -> String {
        let reply = match self {
            Reply::Status(s) => obj(&[
                ("type", j!("status")),
                ("pid", j!(s.pid)),
                ("build", j!(s.build)),
                ("port", j!(s.port)),
                ("started", j!(s.started)),
                ("uptime_secs", j!(s.uptime_secs)),
                (
                    "players",
                    list(
                        s.players
                            .iter()
                            .map(|p| obj(&[("id", j!(p.id)), ("name", j!(p.name))])),
                    ),
                ),
                ("connections", j!(s.connections)),
                ("version", j!(s.version)),
                ("time", j!(s.time)),
                ("paused", j!(s.paused)),
                ("reloading", j!(s.reloading)),
                ("stopping", j!(s.stopping)),
                ("store_error", j!(s.store_error)),
                ("refused", j!(s.refused)),
                ("limited", j!(s.limited)),
                ("frames_sent", j!(s.frames_sent)),
                ("bytes_sent", j!(s.bytes_sent)),
                ("game", j!(s.game)),
            ]),
            Reply::Stopping { already } => {
                obj(&[("type", j!("stopping")), ("already", j!(already))])
            }
            Reply::Clock { paused, time } => obj(&[
                ("type", j!("clock")),
                ("paused", j!(paused)),
                ("time", j!(time)),
            ]),
            Reply::Reloaded {
                time,
                version,
                rounds,
                replayed,
            } => obj(&[
                ("type", j!("reloaded")),
                ("time", j!(time)),
                ("version", j!(version)),
                ("rounds", j!(rounds)),
                ("replayed", j!(replayed)),
            ]),
            Reply::BackedUp {
                dir,
                files,
                bytes,
                last_seq,
                pruned,
            } => obj(&[
                ("type", j!("backed_up")),
                ("dir", j!(dir)),
                ("files", j!(files)),
                ("bytes", j!(bytes)),
                ("last_seq", j!(last_seq)),
                ("pruned", j!(pruned)),
            ]),
            Reply::Revoked {
                name,
                generation,
                closed,
                closing,
            } => obj(&[
                ("type", j!("revoked")),
                ("name", j!(name)),
                ("generation", j!(generation)),
                ("closed", j!(closed)),
                ("closing", j!(closing)),
            ]),
            Reply::Reports(r) => obj(&[
                ("type", j!("reports")),
                ("kept", j!(r.kept)),
                ("count", j!(r.count)),
                (
                    "newest",
                    list(r.newest.iter().map(|b| {
                        obj(&[
                            ("file", j!(b.file)),
                            ("received", j!(b.received)),
                            ("from", j!(b.from)),
                            ("kind", j!(b.kind)),
                            ("text", j!(b.text)),
                        ])
                    })),
                ),
                ("received", j!(r.received)),
                ("saved", j!(r.saved)),
                ("rate_limited", j!(r.rate_limited)),
                ("dropped", j!(r.dropped)),
                ("pruned", j!(r.pruned)),
                ("extra", j!(r.extra)),
            ]),
            Reply::Game(value) => obj(&[("type", j!("game")), ("value", j!(value))]),
            Reply::Unsupported { request, why } => obj(&[
                ("type", j!("unsupported")),
                ("request", j!(request)),
                ("why", j!(why)),
            ]),
            Reply::Refused(why) => obj(&[("type", j!("refused")), ("why", j!(why))]),
            Reply::Unknown(name) => obj(&[("type", j!("unknown")), ("request", j!(name))]),
        };
        obj(&[("admin", j!(ADMIN_VERSION)), ("reply", reply)])
    }

    /// Reads a reply line.
    pub fn decode(line: &str) -> Result<Reply, String> {
        let v: Value = serde_json::from_str(line).map_err(|e| format!("not JSON: {e}"))?;
        check_version(&v)?;
        let r = v.get("reply").ok_or("no reply")?;
        let num = |k: &str| r.get(k).and_then(Value::as_u64).unwrap_or(0);
        let small = |k: &str| u32::try_from(num(k)).unwrap_or(u32::MAX);
        let text = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let flag = |k: &str| r.get(k).and_then(Value::as_bool).unwrap_or(false);
        match r.get("type").and_then(Value::as_str) {
            Some("status") => Ok(Reply::Status(Status {
                pid: small("pid"),
                build: text("build"),
                port: u16::try_from(num("port")).unwrap_or(0),
                started: num("started"),
                uptime_secs: num("uptime_secs"),
                players: r
                    .get("players")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(player).collect())
                    .unwrap_or_default(),
                connections: num("connections"),
                version: num("version"),
                time: num("time"),
                paused: flag("paused"),
                reloading: flag("reloading"),
                stopping: flag("stopping"),
                store_error: r
                    .get("store_error")
                    .and_then(Value::as_str)
                    .map(String::from),
                refused: num("refused"),
                limited: num("limited"),
                frames_sent: num("frames_sent"),
                bytes_sent: num("bytes_sent"),
                game: r.get("game").filter(|g| !g.is_null()).cloned(),
            })),
            Some("stopping") => Ok(Reply::Stopping {
                already: flag("already"),
            }),
            Some("clock") => Ok(Reply::Clock {
                paused: flag("paused"),
                time: num("time"),
            }),
            Some("reloaded") => Ok(Reply::Reloaded {
                time: num("time"),
                version: num("version"),
                rounds: small("rounds"),
                replayed: num("replayed"),
            }),
            Some("backed_up") => Ok(Reply::BackedUp {
                dir: text("dir"),
                files: num("files"),
                bytes: num("bytes"),
                last_seq: num("last_seq"),
                pruned: num("pruned"),
            }),
            Some("revoked") => Ok(Reply::Revoked {
                name: text("name"),
                generation: small("generation"),
                closed: num("closed"),
                closing: num("closing"),
            }),
            Some("reports") => Ok(Reply::Reports(ReportsReply {
                kept: flag("kept"),
                count: num("count"),
                newest: r
                    .get("newest")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(brief).collect())
                    .unwrap_or_default(),
                received: num("received"),
                saved: num("saved"),
                rate_limited: num("rate_limited"),
                dropped: num("dropped"),
                pruned: num("pruned"),
                extra: r.get("extra").filter(|e| !e.is_null()).cloned(),
            })),
            Some("game") => Ok(Reply::Game(r.get("value").cloned().unwrap_or(Value::Null))),
            Some("unsupported") => Ok(Reply::Unsupported {
                request: text("request"),
                why: text("why"),
            }),
            Some("refused") => Ok(Reply::Refused(text("why"))),
            Some("unknown") => Ok(Reply::Unknown(text("request"))),
            Some(other) => Err(format!("an unknown reply type {other:?}")),
            None => Err("no reply type".into()),
        }
    }
}

/// A JSON object, its fields in the order given (each value JSON text
/// already): the lines keep their order whatever `serde_json` features a
/// game's crates turn on.
fn obj(fields: &[(&str, String)]) -> String {
    let mut out = String::from("{");
    for (i, (key, value)) in fields.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&Value::from(*key).to_string());
        out.push(':');
        out.push_str(value);
    }
    out.push('}');
    out
}

/// A JSON array of JSON texts.
fn list(items: impl Iterator<Item = String>) -> String {
    format!("[{}]", items.collect::<Vec<_>>().join(","))
}

fn player(v: &Value) -> PlayerBrief {
    PlayerBrief {
        id: v.get("id").and_then(Value::as_u64),
        name: v.get("name").and_then(Value::as_str).map(String::from),
    }
}

fn brief(v: &Value) -> ReportBrief {
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    ReportBrief {
        file: text("file"),
        received: v.get("received").and_then(Value::as_u64).unwrap_or(0),
        from: text("from"),
        kind: text("kind"),
        text: text("text"),
    }
}

fn check_version(v: &Value) -> Result<(), String> {
    match v.get("admin").and_then(Value::as_u64) {
        Some(n) if n == u64::from(ADMIN_VERSION) => Ok(()),
        Some(n) => Err(format!(
            "admin protocol version {n}; this build speaks {ADMIN_VERSION}"
        )),
        None => Err("not an admin message".into()),
    }
}

impl std::fmt::Display for Status {
    /// One line: `pid 7 port 8080 up 5s v4 t900 running 2 players 3 conns
    /// (ada, #2)`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "pid {} port {} up {}s v{} t{} {} {} players {} conns",
            self.pid,
            self.port,
            self.uptime_secs,
            self.version,
            self.time,
            if self.paused { "paused" } else { "running" },
            self.players.len(),
            self.connections,
        )?;
        if !self.players.is_empty() {
            let names: Vec<String> = self.players.iter().map(PlayerBrief::to_string).collect();
            write!(f, " ({})", names.join(", "))?;
        }
        if self.reloading {
            f.write_str(" reloading")?;
        }
        if self.stopping {
            f.write_str(" stopping")?;
        }
        if let Some(e) = &self.store_error {
            write!(f, " store failed: {e}")?;
        }
        if let Some(g) = &self.game {
            write!(f, " game {g}")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_and_replies_round_trip() {
        for request in [
            Request::Status,
            Request::Stop,
            Request::Pause,
            Request::Resume,
            Request::Reload,
            Request::Backup { out: None },
            Request::Backup {
                out: Some("/b".into()),
            },
            Request::Revoke { name: "ada".into() },
            Request::Reports {
                since: Some(1_793_000_000),
                kind: Some("error".into()),
            },
            Request::Reports {
                since: None,
                kind: None,
            },
            Request::Game {
                name: "kick".into(),
                args: json!({ "who": 3 }),
            },
        ] {
            let asked = decode_request(&request.encode("t0k")).unwrap();
            assert_eq!(
                asked,
                Asked {
                    token: "t0k".into(),
                    request: Ok(request)
                }
            );
        }
        let status = Status {
            pid: 7,
            build: "abc".into(),
            port: 14850,
            started: 100,
            uptime_secs: 5,
            players: vec![
                PlayerBrief::id(1, Some("ada".into())),
                PlayerBrief::named("bo"),
            ],
            connections: 3,
            version: 4,
            time: 900,
            paused: true,
            reloading: false,
            stopping: false,
            store_error: Some("disk full".into()),
            refused: 1,
            limited: 2,
            frames_sent: 12,
            bytes_sent: 3400,
            game: Some(serde_json::json!({ "zones": 3 })),
        };
        for reply in [
            Reply::Status(status),
            Reply::Stopping { already: true },
            Reply::Clock {
                paused: false,
                time: 40,
            },
            Reply::Reloaded {
                time: 9,
                version: 3,
                rounds: 2,
                replayed: 3,
            },
            Reply::BackedUp {
                dir: "/b/1".into(),
                files: 2,
                bytes: 100,
                last_seq: 7,
                pruned: 1,
            },
            Reply::Revoked {
                name: "ada".into(),
                generation: 3,
                closed: 2,
                closing: 1,
            },
            Reply::Reports(ReportsReply {
                kept: true,
                count: 4,
                newest: vec![ReportBrief {
                    file: "1793000000-ada-error.json".into(),
                    received: 1_793_000_000,
                    from: "ada".into(),
                    kind: "error".into(),
                    text: "it broke".into(),
                }],
                received: 6,
                saved: 4,
                rate_limited: 1,
                dropped: 1,
                pruned: 1,
                extra: Some(json!({ "per_player": { "ada": 4 } })),
            }),
            Reply::Reports(ReportsReply::default()),
            Reply::Unsupported {
                request: "pause".into(),
                why: "no clock".into(),
            },
            Reply::Game(json!([1, 2])),
            Reply::Refused("a wrong token".into()),
            Reply::Unknown("seal".into()),
        ] {
            assert_eq!(Reply::decode(&reply.encode()).unwrap(), reply);
        }
    }

    /// The lines as they are on the wire: what another client must send.
    #[test]
    fn the_lines_are_pinned() {
        assert_eq!(
            Request::Stop.encode("ab"),
            r#"{"admin":2,"token":"ab","request":{"type":"stop"}}"#
        );
        assert_eq!(
            Request::Revoke { name: "al".into() }.encode("ab"),
            r#"{"admin":2,"token":"ab","request":{"type":"revoke","name":"al"}}"#
        );
        assert_eq!(
            Reply::Clock {
                paused: true,
                time: 3
            }
            .encode(),
            r#"{"admin":2,"reply":{"type":"clock","paused":true,"time":3}}"#
        );
        assert_eq!(
            Reply::Unsupported {
                request: "pause".into(),
                why: "no clock".into()
            }
            .encode(),
            r#"{"admin":2,"reply":{"type":"unsupported","request":"pause","why":"no clock"}}"#
        );
        let status = Reply::Status(Status {
            players: vec![
                PlayerBrief::id(1, Some("ada".into())),
                PlayerBrief::named("bo"),
            ],
            ..Status::default()
        })
        .encode();
        assert!(
            status.contains(r#""players":[{"id":1,"name":"ada"},{"id":null,"name":"bo"}]"#),
            "{status}"
        );
    }

    #[test]
    fn unknown_requests_and_versions_are_told_apart() {
        let asked = decode_request(r#"{"admin":2,"token":"t","request":{"type":"seal"}}"#).unwrap();
        assert_eq!(asked.request, Err("seal".to_string()));
        let err =
            decode_request(r#"{"admin":2,"token":"t","request":{"type":"revoke"}}"#).unwrap_err();
        assert!(err.contains("names no one"), "{err}");
        let err =
            decode_request(r#"{"admin":1,"token":"t","request":{"type":"stop"}}"#).unwrap_err();
        assert!(err.contains("version 1"), "{err}");
        assert!(decode_request("stop").is_err());
        assert!(decode_request(r#"{"admin":2,"request":{"type":"stop"}}"#).is_err());
        assert!(Reply::decode(r#"{"admin":2,"reply":{"type":"later"}}"#).is_err());
    }
}
