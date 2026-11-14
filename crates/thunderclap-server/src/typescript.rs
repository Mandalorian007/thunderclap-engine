//! TypeScript for a game's clients, from its schema: [`generate_ts`].

use std::path::{Path, PathBuf};

use tc_sim::Game;

/// Writes the TypeScript tc-tsgen makes from `G`'s schema
/// ([`Game::schema`]) under `out`, by `config`. Files whose text is
/// already that are left alone (so a watcher sees no change). The files
/// written.
pub fn generate_ts<G: Game>(out: &Path, config: &tc_tsgen::Config) -> Result<Vec<PathBuf>, String> {
    let files = tc_tsgen::generate(&G::schema(), config)?;
    let mut written = Vec::new();
    for (rel, text) in files {
        let path = out.join(&rel);
        if std::fs::read_to_string(&path).is_ok_and(|old| old == text) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("creating {}: {e}", parent.display()))?;
        }
        std::fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))?;
        written.push(path);
    }
    Ok(written)
}
