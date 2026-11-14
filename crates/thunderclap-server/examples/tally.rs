//! A game's server binary through the facade: tc-sim's tally test game
//! served with the defaults and the CLI.
//!
//! ```text
//! cargo run -p thunderclap-server --example tally -- serve --port 0
//! cargo run -p thunderclap-server --example tally -- status
//! cargo run -p thunderclap-server --example tally -- backup
//! cargo run -p thunderclap-server --example tally -- stop
//! ```
//!
//! A reload reads the tally's multiplier from `TALLY_TIMES` (1 unset).

#[path = "../../tc-sim/tests/tally/mod.rs"]
mod tally;

use std::sync::Arc;

use thunderclap_server::{Server, cli};

fn main() {
    std::process::exit(cli::main(std::env::args(), || {
        Server::builder(tally::Tally::new(true))
            .data_dir("data/tally")
            .build(concat!("tally ", env!("CARGO_PKG_VERSION")))
            .reload_with(|| {
                let times = std::env::var("TALLY_TIMES").unwrap_or_else(|_| "1".into());
                times
                    .parse::<u64>()
                    .map(Arc::new)
                    .map_err(|_| format!("TALLY_TIMES {times:?} is not a number"))
            })
    }));
}
