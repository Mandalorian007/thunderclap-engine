//! A small command line for a game's server binary: [`main`] reads the
//! arguments, runs the command and returns the exit code.
//!
//! ```text
//! serve    [--data DIR] [--host H] [--port N]   serve until stop or Ctrl-C
//! status | stop | pause | resume | reload       ask the running server
//! revoke NAME                                   end a name's tokens
//! reports [--kind K] [--since UNIX]             the reports it holds
//! backup  [--out DIR]                           copy the store (running or not)
//! rollback (--seq N | --time T | --wall UNIX) [--copy DIR]
//!                                               roll a stopped store back
//! gen OUT                                       write the client TypeScript
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tc_admin::{Reply, Request, ask};
use tc_sim::Game;
use tc_store::{Output, RollbackTo};

use crate::server::Builder;

/// The usage text.
pub const USAGE: &str = "\
usage: <server> <command> [options]   (every command takes --data DIR)
  serve    [--host H] [--port N]               serve until `stop` or Ctrl-C
  status | stop | pause | resume | reload      ask the running server
  revoke NAME                                  end every token NAME holds
  reports  [--kind K] [--since UNIX]           the reports the server holds
  backup   [--out DIR]                         copy the store, running or not
  rollback (--seq N | --time T | --wall UNIX) [--copy DIR]
                                               roll the stopped store back
                                               (in place unless --copy)
  gen OUT                                      write the client TypeScript";

/// The options each command takes (and `--data`, which all do).
fn takes(command: &str) -> Option<&'static [&'static str]> {
    Some(match command {
        "serve" => &["host", "port"],
        "status" | "stop" | "pause" | "resume" | "reload" | "revoke" | "gen" => &[],
        "reports" => &["kind", "since"],
        "backup" => &["out"],
        "rollback" => &["seq", "time", "wall", "copy"],
        _ => return None,
    })
}

/// Arguments read: the command, its words, its options.
#[derive(Debug, Default, PartialEq, Eq)]
struct Args {
    command: String,
    words: Vec<String>,
    options: BTreeMap<String, String>,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut it = args.into_iter().skip(1);
    let command = it.next().ok_or("no command")?;
    let allowed = takes(&command).ok_or_else(|| format!("no command {command:?}"))?;
    let mut parsed = Args {
        command,
        ..Args::default()
    };
    while let Some(arg) = it.next() {
        if let Some(name) = arg.strip_prefix("--") {
            if name != "data" && !allowed.contains(&name) {
                return Err(format!("{} takes no --{name}", parsed.command));
            }
            let value = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
            parsed.options.insert(name.to_string(), value);
        } else {
            parsed.words.push(arg);
        }
    }
    Ok(parsed)
}

fn number<T: std::str::FromStr>(args: &Args, name: &str) -> Result<Option<T>, String> {
    args.options
        .get(name)
        .map(|v| {
            v.parse()
                .map_err(|_| format!("--{name} {v:?} is not a number"))
        })
        .transpose()
}

/// Runs the command `args` names (the first is the program, as
/// [`std::env::args`] gives them) on the server `make` sets up; the
/// options given override its settings. The exit code: 0 done, 1 failed or
/// refused, 2 a usage error.
pub fn main<G: Game>(
    args: impl IntoIterator<Item = String>,
    make: impl FnOnce() -> Builder<G>,
) -> i32 {
    let args: Vec<String> = args.into_iter().collect();
    if args
        .get(1)
        .is_some_and(|a| matches!(a.as_str(), "help" | "-h" | "--help"))
    {
        println!("{USAGE}");
        return 0;
    }
    let args = match parse(args) {
        Ok(a) => a,
        Err(why) => {
            eprintln!("{why}\n{USAGE}");
            return 2;
        }
    };
    match run(&args, make) {
        Ok(out) => {
            if !out.is_empty() {
                println!("{out}");
            }
            0
        }
        Err(Failure::Usage(why)) => {
            eprintln!("{why}\n{USAGE}");
            2
        }
        Err(Failure::Failed(why)) => {
            eprintln!("{why}");
            1
        }
    }
}

enum Failure {
    Usage(String),
    Failed(String),
}

impl From<String> for Failure {
    fn from(why: String) -> Failure {
        Failure::Failed(why)
    }
}

fn run<G: Game>(args: &Args, make: impl FnOnce() -> Builder<G>) -> Result<String, Failure> {
    let usage = |why: &str| Failure::Usage(why.to_string());
    let mut builder = make();
    if let Some(dir) = args.options.get("data") {
        builder = builder.data_dir(dir);
    }
    let store = builder.store_path();
    let words = args.words.len();
    let want_words = usize::from(matches!(args.command.as_str(), "revoke" | "gen"));
    if words != want_words {
        return Err(usage(&format!(
            "{} takes {want_words} word(s), not {words}",
            args.command
        )));
    }
    let asked = |request: Request| -> Result<String, Failure> {
        let reply = ask(&store, &request).map_err(|e| e.to_string())?;
        show(reply)
    };
    match args.command.as_str() {
        "serve" => {
            if let Some(host) = args.options.get("host") {
                builder = builder.host(host);
            }
            if let Some(port) = number::<u16>(args, "port").map_err(Failure::Usage)? {
                builder = builder.port(port);
            }
            builder.run()?;
            Ok(String::new())
        }
        "status" => asked(Request::Status),
        "stop" => asked(Request::Stop),
        "pause" => asked(Request::Pause),
        "resume" => asked(Request::Resume),
        "reload" => asked(Request::Reload),
        "revoke" => asked(Request::Revoke {
            name: args.words[0].clone(),
        }),
        "reports" => asked(Request::Reports {
            since: number(args, "since").map_err(Failure::Usage)?,
            kind: args.options.get("kind").cloned(),
        }),
        "backup" => {
            let out = args.options.get("out").map(PathBuf::from);
            if tc_store::holder(&store).is_some() {
                // Through the server, so its backups are counted as its.
                let out = out.map(|o| absolute(&o).display().to_string());
                asked(Request::Backup { out })
            } else {
                let b = builder.backups().run(out.as_deref())?;
                Ok(format!(
                    "backed up to {}: {} files, {} bytes, through entry {}{}",
                    b.dir.display(),
                    b.files,
                    b.bytes,
                    b.last_seq,
                    pruned(b.pruned)
                ))
            }
        }
        "rollback" => {
            let points = [
                number(args, "seq")
                    .map_err(Failure::Usage)?
                    .map(RollbackTo::Seq),
                number(args, "time")
                    .map_err(Failure::Usage)?
                    .map(RollbackTo::Time),
                number(args, "wall")
                    .map_err(Failure::Usage)?
                    .map(RollbackTo::Wall),
            ];
            let mut points = points.into_iter().flatten();
            let (Some(to), None) = (points.next(), points.next()) else {
                return Err(usage("rollback takes one of --seq, --time and --wall"));
            };
            let copy = args.options.get("copy").map(PathBuf::from);
            let output = match &copy {
                Some(dir) => Output::Copy(dir),
                None => Output::InPlace,
            };
            let r = tc_store::rollback(&store, &builder.codec(), to, output)
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "rolled back to entry {} (it held {}), clock {}{}",
                r.kept,
                r.was,
                r.clock,
                match (&copy, &r.moved) {
                    (Some(dir), _) => format!(", into {}", dir.display()),
                    (None, Some(moved)) => format!("; the old log is in {}", moved.display()),
                    (None, None) => String::new(),
                }
            ))
        }
        "gen" => {
            let out = Path::new(&args.words[0]);
            let written = crate::generate_ts::<G>(out, &tc_tsgen::Config::default())?;
            Ok(format!(
                "{} file(s) written under {}",
                written.len(),
                out.display()
            ))
        }
        other => Err(usage(&format!("no command {other:?}"))),
    }
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

fn pruned(n: u64) -> String {
    if n == 0 {
        String::new()
    } else {
        format!(" ({n} older removed)")
    }
}

/// A reply as the command prints it, or why it failed.
fn show(reply: Reply) -> Result<String, Failure> {
    Ok(match reply {
        Reply::Status(s) => s.to_string(),
        Reply::Stopping { already: true } => "already stopping".into(),
        Reply::Stopping { already: false } => "stopping".into(),
        Reply::Clock { paused, time } => {
            format!("{} at t{time}", if paused { "paused" } else { "running" })
        }
        Reply::Reloaded {
            time,
            version,
            rounds,
            replayed,
        } => format!(
            "reloaded at t{time} v{version}: {replayed} entries replayed in {rounds} round(s)"
        ),
        Reply::BackedUp {
            dir,
            files,
            bytes,
            last_seq,
            pruned: n,
        } => format!(
            "backed up to {dir}: {files} files, {bytes} bytes, through entry {last_seq}{}",
            pruned(n)
        ),
        Reply::Revoked { name, generation } => {
            format!("revoked {name}'s tokens (generation {generation})")
        }
        Reply::Reports(r) if !r.kept => "this server keeps no reports".into(),
        Reply::Reports(r) => {
            let mut out = format!(
                "{} held; since start {} received, {} saved, {} dropped, {} pruned",
                r.count, r.received, r.saved, r.dropped, r.pruned
            );
            for b in r.newest {
                out.push_str(&format!(
                    "\n  {}  {} {}: {}",
                    b.file, b.from, b.kind, b.text
                ));
            }
            out
        }
        Reply::Game(v) => v.to_string(),
        Reply::Refused(why) => return Err(Failure::Failed(format!("refused: {why}"))),
        Reply::Unknown(name) => {
            return Err(Failure::Failed(format!(
                "the server doesn't know {name:?} (an older build?)"
            )));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        std::iter::once("srv")
            .chain(line.split_whitespace())
            .map(String::from)
            .collect()
    }

    #[test]
    fn arguments_are_read_and_checked() {
        let a = parse(args("rollback --seq 4 --data d --copy out")).unwrap();
        assert_eq!(a.command, "rollback");
        assert_eq!(a.options["seq"], "4");
        assert_eq!(a.options["data"], "d");
        assert!(
            parse(args("status --port 3"))
                .unwrap_err()
                .contains("no --port")
        );
        assert!(parse(args("seal")).unwrap_err().contains("no command"));
        assert!(
            parse(args("serve --port"))
                .unwrap_err()
                .contains("needs a value")
        );
        assert!(parse(args("")).is_err());
        let a = parse(args("revoke ada")).unwrap();
        assert_eq!(a.words, ["ada"]);
    }
}
