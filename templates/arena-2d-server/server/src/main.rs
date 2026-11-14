//! The arena's server binary: the facade's command line.
//!
//! ```text
//! cargo run --release -- serve --port 4711     serve until `stop` or Ctrl-C
//! cargo run --release -- status                ask the running server
//! cargo run --release -- stop
//! ```
//!
//! `--data DIR` (any command) keeps the arena somewhere other than
//! `data/arena`.

fn main() {
    std::process::exit(thunderclap_server::cli::main(
        std::env::args(),
        arena_server::server,
    ));
}
