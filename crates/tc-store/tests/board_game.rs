//! A board game's turn log through the store's public API: a codec with
//! no file keys (everything in `main.log`), players named through the
//! name table, turns written, marked, reopened and read back unchanged.

use std::convert::Infallible;
use std::fs;

use tc_store::format::{Reader, Writer};
use tc_store::{Log, LogCodec, LogEntry, NameTable, Names, read};

/// A turn of a game on an 8 by 8 board.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Turn {
    Join {
        player: String,
    },
    Move {
        player: String,
        from: (u8, u8),
        to: (u8, u8),
    },
    Resign {
        player: String,
    },
}

struct TurnLog;

impl TurnLog {
    fn square(r: &mut Reader<'_>) -> Result<(u8, u8), String> {
        let at = r.u8()?;
        if at >= 64 {
            return Err(format!("square {at} is off the board"));
        }
        Ok((at % 8, at / 8))
    }
}

impl LogCodec for TurnLog {
    type Event = Turn;
    type Key = Infallible;

    fn key(&self, _: &Turn) -> Option<Infallible> {
        None
    }
    fn file_name(&self, key: &Infallible) -> String {
        match *key {}
    }
    fn parse_file_name(&self, _: &str) -> Option<Infallible> {
        None
    }

    fn encode(&self, turn: &Turn, names: &mut Names<'_>, out: &mut Vec<u8>) -> Result<(), String> {
        let mut w = Writer::default();
        match turn {
            Turn::Join { player } => {
                w.u8(1);
                w.str(player);
            }
            Turn::Move { player, from, to } => {
                w.u8(2);
                w.u32(names.id(player));
                for (x, y) in [from, to] {
                    if *x >= 8 || *y >= 8 {
                        return Err(format!("({x}, {y}) is off the board"));
                    }
                    w.u8(y * 8 + x);
                }
            }
            Turn::Resign { player } => {
                w.u8(3);
                w.u32(names.id(player));
            }
        }
        out.extend_from_slice(&w.0);
        Ok(())
    }

    fn decode(&self, bytes: &[u8], names: &NameTable) -> Result<Turn, String> {
        let mut r = Reader::new(bytes);
        let player = |r: &mut Reader<'_>| -> Result<String, String> {
            let id = r.u32()?;
            names
                .get(id)
                .map(str::to_string)
                .ok_or_else(|| format!("player {id} isn't named"))
        };
        let turn = match r.u8()? {
            1 => Turn::Join { player: r.str()? },
            2 => Turn::Move {
                player: player(&mut r)?,
                from: TurnLog::square(&mut r)?,
                to: TurnLog::square(&mut r)?,
            },
            3 => Turn::Resign {
                player: player(&mut r)?,
            },
            tag => return Err(format!("unknown turn {tag}")),
        };
        r.finish()?;
        Ok(turn)
    }
}

#[test]
fn a_board_games_turn_log_round_trips() {
    let dir = std::env::temp_dir().join(format!("tc-store-board-game-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let turns = [
        Turn::Join {
            player: "ada".into(),
        },
        Turn::Join {
            player: "bo".into(),
        },
        Turn::Move {
            player: "ada".into(),
            from: (4, 1),
            to: (4, 3),
        },
        Turn::Move {
            player: "bo".into(),
            from: (4, 6),
            to: (4, 4),
        },
        Turn::Move {
            player: "ada".into(),
            from: (6, 0),
            to: (5, 2),
        },
        Turn::Resign {
            player: "bo".into(),
        },
    ];
    let entries: Vec<LogEntry<Turn>> = turns
        .iter()
        .zip(1..)
        .map(|(turn, seq)| LogEntry {
            seq,
            time: seq * 1000,
            event: turn.clone(),
        })
        .collect();

    let mut log = Log::create(&dir, TurnLog, b"chess v1").unwrap();
    log.append_all(&entries[..2]).unwrap();
    for entry in &entries[2..] {
        log.append(entry).unwrap();
    }
    let bad = LogEntry {
        seq: 7,
        time: 7000,
        event: Turn::Move {
            player: "ada".into(),
            from: (0, 0),
            to: (9, 9),
        },
    };
    assert!(log.append(&bad).is_err());
    log.mark(6000).unwrap();
    log.wait().unwrap();
    drop(log);

    let (log, opened) = Log::open(&dir, TurnLog).unwrap();
    assert!(opened.report.is_clean(), "{:?}", opened.report);
    assert_eq!(opened.meta, b"chess v1");
    assert_eq!(opened.entries, entries);
    assert_eq!((opened.clock, log.last_seq()), (6000, 6));
    drop(log);
    assert_eq!(read(&dir, &TurnLog).unwrap().entries, entries);
    let _ = fs::remove_dir_all(&dir);
}
