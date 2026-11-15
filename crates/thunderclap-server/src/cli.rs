//! A small command line for a game's server binary: [`main`] reads the
//! arguments, runs the command and returns the exit code. [`Cli`] is the
//! same command line with the game's own commands and `serve` options
//! added.
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

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;
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

/// A command as it was given: its name, words, options and flags.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Given {
    command: String,
    words: Vec<String>,
    options: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}

/// What a command takes besides its words: options with a value, and
/// flags without.
struct Takes<'a> {
    options: Vec<&'a str>,
    flags: Vec<&'a str>,
}

fn parse<'a>(
    args: impl IntoIterator<Item = String>,
    takes: impl Fn(&str) -> Option<Takes<'a>>,
) -> Result<Given, String> {
    let mut it = args.into_iter().skip(1);
    let command = it.next().ok_or("no command")?;
    let takes = takes(&command).ok_or_else(|| format!("no command {command:?}"))?;
    let mut parsed = Given {
        command,
        ..Given::default()
    };
    while let Some(arg) = it.next() {
        if let Some(name) = arg.strip_prefix("--") {
            if takes.flags.contains(&name) {
                parsed.flags.insert(name.to_string());
                continue;
            }
            if name != "data" && !takes.options.contains(&name) {
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

fn number<T: std::str::FromStr>(args: &Given, name: &str) -> Result<Option<T>, String> {
    args.options
        .get(name)
        .map(|v| {
            v.parse()
                .map_err(|_| format!("--{name} {v:?} is not a number"))
        })
        .transpose()
}

type CommandFn<'a, G> = Box<dyn FnOnce(Invocation<G>) -> Result<String, String> + 'a>;
type ServeFn<'a, G> = Box<dyn FnOnce(Builder<G>, &Given) -> Result<Builder<G>, String> + 'a>;

/// One of the game's own commands, for [`Cli::command`].
pub struct Command<'a, G: Game> {
    name: String,
    usage: String,
    words: (usize, usize),
    options: Vec<String>,
    flags: Vec<String>,
    run: CommandFn<'a, G>,
}

impl<'a, G: Game> Command<'a, G> {
    /// A command `name` (its usage line, as the help lists it) that takes
    /// no words, options or flags (but `--data`) until told. `run` gets
    /// what was given and the server's builder; what it returns is
    /// printed, or the error (exit 1).
    pub fn new(
        name: impl Into<String>,
        usage: impl Into<String>,
        run: impl FnOnce(Invocation<G>) -> Result<String, String> + 'a,
    ) -> Command<'a, G> {
        Command {
            name: name.into(),
            usage: usage.into(),
            words: (0, 0),
            options: Vec::new(),
            flags: Vec::new(),
            run: Box::new(run),
        }
    }

    /// A command `name` that asks the running server the game's request
    /// `request` (`Request::Game`), sending what was given as
    /// [`Given::json`] makes it, and prints the answer (a string as it is).
    pub fn ask_game(
        name: impl Into<String>,
        usage: impl Into<String>,
        request: impl Into<String>,
    ) -> Command<'a, G> {
        let request = request.into();
        Command::new(name, usage, move |inv: Invocation<G>| {
            inv.ask_game(&request, inv.json()).map(|v| match v {
                Value::String(s) => s,
                v => v.to_string(),
            })
        })
    }

    /// It takes from `min` to `max` words.
    pub fn words(mut self, min: usize, max: usize) -> Self {
        self.words = (min, max.max(min));
        self
    }

    /// The options it takes, each with a value (`--seed 7`).
    pub fn options(mut self, names: &[&str]) -> Self {
        self.options.extend(names.iter().map(|n| (*n).to_string()));
        self
    }

    /// The flags it takes, without a value (`--fresh`).
    pub fn flags(mut self, names: &[&str]) -> Self {
        self.flags.extend(names.iter().map(|n| (*n).to_string()));
        self
    }
}

impl Given {
    /// The command's name.
    pub fn command(&self) -> &str {
        &self.command
    }

    /// Its words, in order.
    pub fn words(&self) -> &[String] {
        &self.words
    }

    /// An option's value, if given.
    pub fn option(&self, name: &str) -> Option<&str> {
        self.options.get(name).map(String::as_str)
    }

    /// An option's value read as a number, if given: an error names it.
    pub fn number<T: std::str::FromStr>(&self, name: &str) -> Result<Option<T>, String> {
        number(self, name)
    }

    /// True if the flag was given.
    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }

    /// The words, options and flags as one JSON object (`words`, then each
    /// option's value and each flag as `true`; not `--data`): what
    /// [`Command::ask_game`] sends.
    pub fn json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("words".into(), Value::from(self.words.clone()));
        for (k, v) in &self.options {
            if k != "data" {
                m.insert(k.clone(), Value::from(v.clone()));
            }
        }
        for f in &self.flags {
            m.insert(f.clone(), Value::Bool(true));
        }
        Value::Object(m)
    }
}

/// A command of the game's as it was given ([`Given`], which it derefs
/// to), and the server it would run: the builder `make` gave, with
/// `--data`.
pub struct Invocation<G: Game> {
    given: Given,
    builder: Builder<G>,
}

impl<G: Game> std::ops::Deref for Invocation<G> {
    type Target = Given;

    fn deref(&self) -> &Given {
        &self.given
    }
}

impl<G: Game> Invocation<G> {
    /// The server's builder.
    pub fn builder(&self) -> &Builder<G> {
        &self.builder
    }

    /// The server's builder, to start or change.
    pub fn into_builder(self) -> Builder<G> {
        self.builder
    }

    /// Asks the running server (its admin channel).
    pub fn ask(&self, request: &Request) -> Result<Reply, String> {
        ask(&self.builder.store_path(), request).map_err(|e| e.to_string())
    }

    /// Asks the running server the game's request `name` with `args`: its
    /// answer.
    pub fn ask_game(&self, name: &str, args: Value) -> Result<Value, String> {
        let request = Request::Game {
            name: name.into(),
            args,
        };
        match self.ask(&request)? {
            Reply::Game(v) => Ok(v),
            other => show(other).map(Value::String).map_err(|f| match f {
                Failure::Usage(w) | Failure::Failed(w) => w,
            }),
        }
    }
}

/// The command line with the game's own commands: built-in ones (see
/// [`USAGE`]), then [`command`](Self::command)s (their own, or
/// [`Command::ask_game`]s) and `serve` options added. [`main`] is `Cli::new(make).main(args)`.
pub struct Cli<'a, G: Game> {
    make: Box<dyn FnOnce() -> Builder<G> + 'a>,
    commands: Vec<Command<'a, G>>,
    serve_options: Vec<String>,
    serve_flags: Vec<String>,
    serve_usage: String,
    serve: Option<ServeFn<'a, G>>,
}

impl<'a, G: Game> Cli<'a, G> {
    /// The built-in commands, on the server `make` sets up.
    pub fn new(make: impl FnOnce() -> Builder<G> + 'a) -> Cli<'a, G> {
        Cli {
            make: Box::new(make),
            commands: Vec::new(),
            serve_options: Vec::new(),
            serve_flags: Vec::new(),
            serve_usage: String::new(),
            serve: None,
        }
    }

    /// Adds the game's command (one named like a built-in replaces it).
    pub fn command(mut self, command: Command<'a, G>) -> Self {
        self.commands.retain(|c| c.name != command.name);
        self.commands.push(command);
        self
    }

    /// Options and flags `serve` takes besides `--host` and `--port`, and
    /// how they set the server up (`apply` gets the builder and what was
    /// given). `usage` is added to `serve`'s help line.
    pub fn serve_options(
        mut self,
        options: &[&str],
        flags: &[&str],
        usage: &str,
        apply: impl FnOnce(Builder<G>, &Given) -> Result<Builder<G>, String> + 'a,
    ) -> Self {
        self.serve_options = options.iter().map(|o| (*o).to_string()).collect();
        self.serve_flags = flags.iter().map(|f| (*f).to_string()).collect();
        self.serve_usage = usage.into();
        self.serve = Some(Box::new(apply));
        self
    }

    /// The help text: the built-ins and the game's commands.
    pub fn usage(&self) -> String {
        let mut out = USAGE.to_string();
        if !self.serve_usage.is_empty() {
            out.push_str(&format!("\n  serve also takes: {}", self.serve_usage));
        }
        for c in &self.commands {
            out.push_str(&format!("\n  {}", c.usage));
        }
        out
    }

    fn takes(&self, command: &str) -> Option<Takes<'_>> {
        if let Some(c) = self.commands.iter().find(|c| c.name == command) {
            return Some(Takes {
                options: c.options.iter().map(String::as_str).collect(),
                flags: c.flags.iter().map(String::as_str).collect(),
            });
        }
        let mut options = takes(command)?.to_vec();
        let mut flags = Vec::new();
        if command == "serve" {
            options.extend(self.serve_options.iter().map(String::as_str));
            flags.extend(self.serve_flags.iter().map(String::as_str));
        }
        Some(Takes { options, flags })
    }

    /// Runs the command `args` names (the first is the program, as
    /// [`std::env::args`] gives them): the exit code, 0 done, 1 failed or
    /// refused, 2 a usage error.
    pub fn main(mut self, args: impl IntoIterator<Item = String>) -> i32 {
        let args: Vec<String> = args.into_iter().collect();
        let usage = self.usage();
        if args
            .get(1)
            .is_some_and(|a| matches!(a.as_str(), "help" | "-h" | "--help"))
        {
            println!("{usage}");
            return 0;
        }
        let args = match parse(args, |c| self.takes(c)) {
            Ok(a) => a,
            Err(why) => {
                eprintln!("{why}\n{usage}");
                return 2;
            }
        };
        let result = match self.commands.iter().position(|c| c.name == args.command) {
            Some(i) => {
                let command = self.commands.swap_remove(i);
                let n = args.words.len();
                let (min, max) = command.words;
                if n < min || n > max {
                    Err(Failure::Usage(format!(
                        "{} takes {min} to {max} word(s), not {n}",
                        args.command
                    )))
                } else {
                    let mut builder = (self.make)();
                    if let Some(dir) = args.options.get("data") {
                        builder = builder.data_dir(dir);
                    }
                    (command.run)(Invocation {
                        given: args,
                        builder,
                    })
                    .map_err(Failure::Failed)
                }
            }
            None => run(args, self.make, self.serve),
        };
        match result {
            Ok(out) => {
                if !out.is_empty() {
                    println!("{out}");
                }
                0
            }
            Err(Failure::Usage(why)) => {
                eprintln!("{why}\n{usage}");
                2
            }
            Err(Failure::Failed(why)) => {
                eprintln!("{why}");
                1
            }
        }
    }
}

/// Runs the command `args` names (the first is the program, as
/// [`std::env::args`] gives them) on the server `make` sets up; the
/// options given override its settings. The exit code: 0 done, 1 failed or
/// refused, 2 a usage error.
pub fn main<G: Game>(
    args: impl IntoIterator<Item = String>,
    make: impl FnOnce() -> Builder<G>,
) -> i32 {
    Cli::new(make).main(args)
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

fn run<G: Game>(
    args: Given,
    make: Box<dyn FnOnce() -> Builder<G> + '_>,
    serve: Option<ServeFn<'_, G>>,
) -> Result<String, Failure> {
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
            if let Some(port) = number::<u16>(&args, "port").map_err(Failure::Usage)? {
                builder = builder.port(port);
            }
            if let Some(apply) = serve {
                builder = apply(builder, &args).map_err(Failure::Usage)?;
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
            since: number(&args, "since").map_err(Failure::Usage)?,
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
                number(&args, "seq")
                    .map_err(Failure::Usage)?
                    .map(RollbackTo::Seq),
                number(&args, "time")
                    .map_err(Failure::Usage)?
                    .map(RollbackTo::Time),
                number(&args, "wall")
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

    fn builtin(command: &str) -> Option<Takes<'static>> {
        let mut flags = Vec::new();
        if command == "serve" {
            flags.push("fresh");
        }
        Some(Takes {
            options: takes(command)?.to_vec(),
            flags,
        })
    }

    fn parse(args: Vec<String>) -> Result<Given, String> {
        super::parse(args, builtin)
    }

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
        let a = parse(args("serve --fresh --port 4")).unwrap();
        assert!(a.flag("fresh"));
        assert_eq!(a.number::<u16>("port"), Ok(Some(4)));
        assert_eq!(
            a.json(),
            serde_json::json!({ "words": [], "port": "4", "fresh": true })
        );
    }
}
